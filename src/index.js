import { DurableObject } from "cloudflare:workers";

// Rooms are fixed on purpose (no one can spam-create rooms). Edit this list to add more.
const ROOMS = ["general", "games", "help", "off-topic"];
// Keep the order in sync with NAMES in chat.html
const COLORS = ["#2a6ec2", "#c2307c", "#2a9a2a", "#c98a00", "#7a4dc2", "#0e9aa7", "#d0561b", "#d03b3b"];
const TTL = 60 * 60 * 24 * 30;

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const pbkdf2 = async (pw, salt) => {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, k, 256));
};
const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const cookieOf = (req) => (req.headers.get("cookie") || "").match(/(?:^|; )ppg_s=([a-f0-9]+)/)?.[1];
const setCookie = (v, age) => `ppg_s=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const sameOrigin = (req) => {
  const o = req.headers.get("origin");
  return !o || new URL(o).host === new URL(req.url).host;
};
const pub = (u) => ({ id: u.id, name: u.name, color: u.color, admin: !!u.admin });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!sameOrigin(req)) return json({ error: "Bad origin" }, 403);
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    const tok = cookieOf(req);
    const who = async () => (tok ? hub.session(await sha(tok)) : null);
    const start = async (u) => {
      const t = hex(rand(32));
      await hub.newSession(await sha(t), u.id);
      return json({ user: pub(u) }, 200, { "set-cookie": setCookie(t, TTL) });
    };
    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/ws":
          return await hub.fetch(req);
        case "GET /api/me": {
          const u = await who();
          return u ? json({ user: pub(u), rooms: ROOMS, colors: COLORS }) : json({ error: "Not signed in" }, 401);
        }
        case "POST /api/logout":
          if (tok) await hub.endSession(await sha(tok));
          return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });
        case "POST /api/color": {
          const u = await who();
          const b = await req.json().catch(() => ({}));
          if (!u) return json({ error: "Not signed in" }, 401);
          if (!COLORS.includes(b.color)) return json({ error: "Bad colour" }, 400);
          await hub.setColor(u.id, b.color);
          return json({ ok: true });
        }
        case "POST /api/register":
        case "POST /api/login": {
          const reg = url.pathname.endsWith("register");
          const b = await req.json().catch(() => ({}));
          const name = String(b.username || "").trim();
          const pw = String(b.password || "");
          const email = String(b.email || "").trim();
          if (!(await hub.hit("auth:" + (req.headers.get("cf-connecting-ip") || "?"), 40, 600)))
            return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
          if (reg) {
            if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return json({ error: "Username must be 3-20 letters, numbers or _." }, 400);
            if (pw.length < 8 || pw.length > 128) return json({ error: "Password must be 8-128 characters." }, 400);
            if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return json({ error: "That email doesn't look right." }, 400);
            const salt = rand(16);
            const u = await hub.register(name, email, hex(salt), hex(await pbkdf2(pw, salt)));
            return u ? start(u) : json({ error: "That username is taken." }, 409);
          }
          const rec = await hub.cred(name);
          const h = await pbkdf2(pw, rec ? unhex(rec.salt) : rand(16));
          if (!rec || !crypto.subtle.timingSafeEqual(h, unhex(rec.hash))) return json({ error: "Wrong username or password." }, 401);
          return start(rec);
        }
      }
    } catch (e) {
      return json({ error: "Server error" }, 500);
    }
    return json({ error: "Not found" }, 404);
  },
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL, color TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid INTEGER NOT NULL, exp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, uid INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS msgs_room ON msgs (room, id)",
  "CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)",
];

// One Durable Object holds everything: accounts, sessions, messages and all live sockets.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const q of SCHEMA) this.sql.exec(q);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  q(sql, ...a) {
    return this.sql.exec(sql, ...a).toArray();
  }

  // ---- RPC used by the Worker ----
  hit(k, max, secs) {
    const now = Date.now();
    this.sql.exec("DELETE FROM hits WHERE reset<?", now);
    const r = this.q("SELECT n FROM hits WHERE k=?", k)[0];
    if (!r) {
      this.sql.exec("INSERT INTO hits VALUES (?,?,?)", k, 1, now + secs * 1000);
      return true;
    }
    if (r.n >= max) return false;
    this.sql.exec("UPDATE hits SET n=n+1 WHERE k=?", k);
    return true;
  }

  register(name, email, salt, hash) {
    if (this.q("SELECT 1 FROM users WHERE name=?", name).length) return null;
    const first = !this.q("SELECT 1 FROM users LIMIT 1").length; // first account becomes admin
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const id = this.q(
      "INSERT INTO users (name,email,salt,hash,color,admin,seen) VALUES (?,?,?,?,?,?,?) RETURNING id",
      name, email || null, salt, hash, color, first ? 1 : 0, Date.now()
    )[0].id;
    return { id, name, color, admin: first ? 1 : 0 };
  }

  cred(name) {
    return this.q("SELECT id,name,color,admin,salt,hash FROM users WHERE name=?", name)[0] || null;
  }

  newSession(th, uid) {
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE exp<?", now);
    this.sql.exec("INSERT INTO sessions VALUES (?,?,?)", th, uid, now + TTL * 1000);
  }

  session(th) {
    return (
      this.q("SELECT u.id,u.name,u.color,u.admin FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=? AND s.exp>?", th, Date.now())[0] || null
    );
  }

  endSession(th) {
    this.sql.exec("DELETE FROM sessions WHERE th=?", th);
  }

  setColor(uid, color) {
    this.sql.exec("UPDATE users SET color=? WHERE id=?", color, uid);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.uid === uid) ws.serializeAttachment({ ...a, color });
    }
    this.pushMembers();
  }

  // ---- WebSocket ----
  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const tok = cookieOf(req);
    const u = tok ? this.session(await sha(tok)) : null;
    if (!u) return new Response("Sign in first", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid: u.id, name: u.name, color: u.color, admin: !!u.admin, room: null, t: 0 });
    this.sql.exec("UPDATE users SET seen=? WHERE id=?", Date.now(), u.id);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(room, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === 1 && ws.deserializeAttachment()?.room === room) ws.send(s);
    }
  }

  pushMembers() {
    const on = new Map();
    const open = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1);
    for (const ws of open) {
      const a = ws.deserializeAttachment();
      if (a) on.set(a.uid, { name: a.name, color: a.color, admin: a.admin });
    }
    const off = this.q("SELECT id,name,color,admin FROM users ORDER BY seen DESC LIMIT 200")
      .filter((u) => !on.has(u.id))
      .slice(0, 100)
      .map((u) => ({ name: u.name, color: u.color, admin: !!u.admin }));
    const s = JSON.stringify({ t: "members", online: [...on.values()], offline: off });
    for (const ws of open) ws.send(s);
  }

  webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m) return;
    if (m.t === "join" && ROOMS.includes(m.room)) {
      ws.serializeAttachment({ ...a, room: m.room });
      const msgs = this.q("SELECT id,uid,name,color,text,ts FROM msgs WHERE room=? ORDER BY id DESC LIMIT 100", m.room).reverse();
      ws.send(JSON.stringify({ t: "history", room: m.room, msgs }));
      this.pushMembers();
    } else if (m.t === "msg" && a.room) {
      const text = String(m.text || "").trim().slice(0, 500);
      const now = Date.now();
      if (!text) return;
      if (now - a.t < 800) return ws.send(JSON.stringify({ t: "err", text: "Slow down a little." }));
      ws.serializeAttachment({ ...a, t: now });
      const id = this.q("INSERT INTO msgs (room,uid,name,color,text,ts) VALUES (?,?,?,?,?,?) RETURNING id", a.room, a.uid, a.name, a.color, text, now)[0].id;
      this.sql.exec("DELETE FROM msgs WHERE room=? AND id<=(SELECT id FROM msgs WHERE room=? ORDER BY id DESC LIMIT 1 OFFSET 1000)", a.room, a.room);
      this.send(a.room, { t: "msg", room: a.room, m: { id, uid: a.uid, name: a.name, color: a.color, text, ts: now } });
    } else if (m.t === "typing" && a.room) {
      this.send(a.room, { t: "typing", room: a.room, name: a.name });
    } else if (m.t === "del") {
      const id = Number(m.id);
      const r = this.q("SELECT room,uid FROM msgs WHERE id=?", id)[0];
      if (r && (r.uid === a.uid || a.admin)) {
        this.sql.exec("DELETE FROM msgs WHERE id=?", id);
        this.send(r.room, { t: "del", id });
      }
    }
  }

  webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.sql.exec("UPDATE users SET seen=? WHERE id=?", Date.now(), a.uid);
    try { ws.close(1000); } catch {}
    this.pushMembers();
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
