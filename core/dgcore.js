var DgCore = (function() {
  var transport = null;
  var wasmReady = false;
  var settings = {
    wisp: "wss://wisp-server-workers.dotlyhiyou.workers.dev/",
    wasmURL: "/scramjet/scramjet.wasm",
    maxAssets: 60,
    maxBytes: 15728640
  };
  var ALLOW = ["data.vinetrap.net", "orchard.vinetrap.net"];
  var blobCache = {};
  var DEBUG = true;

  function dlog(m) {
    if (!DEBUG) return;
    try { console.warn("[dgcore] " + m); } catch (e) {}
  }

  function setup(opts) {
    if (!opts) return;
    if (opts.wisp) settings.wisp = opts.wisp;
    if (opts.wasmURL) settings.wasmURL = opts.wasmURL;
    if (opts.maxAssets) settings.maxAssets = opts.maxAssets;
    if (opts.maxBytes) settings.maxBytes = opts.maxBytes;
  }

  function addHost(h) {
    if (h && ALLOW.indexOf(h) === -1) ALLOW.push(h);
  }

  function allowed(url) {
    try {
      return ALLOW.indexOf(new URL(url).hostname) !== -1;
    } catch (e) {
      return false;
    }
  }

  function timeoutSignal(ms) {
    try {
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    } catch (e) {}
    try {
      var ctl = new AbortController();
      setTimeout(function() { try { ctl.abort(); } catch (e2) {} }, ms);
      return ctl.signal;
    } catch (e2) {}
    return null;
  }

  function withTimeout(promise, ms, label) {
    var timer = null;
    var gated = new Promise(function(_, rej) {
      timer = setTimeout(function() { rej(new Error("timeout " + label)); }, ms);
    });
    return Promise.race([promise, gated]).then(function(v) {
      try { clearTimeout(timer); } catch (e) {}
      return v;
    }, function(e) {
      try { clearTimeout(timer); } catch (e2) {}
      throw e;
    });
  }

  async function ensure() {
    if (transport) return true;
    dlog("transport init...");
    var EpoxyTransport = self.EpoxyTransport.default;
    var t = new EpoxyTransport({ wisp: settings.wisp });
    await withTimeout(t.init(), 15000, "transport");
    transport = t;
    dlog("transport ready");
    if (!wasmReady) {
      dlog("wasm fetch...");
      var wr = await withTimeout(fetch(settings.wasmURL), 15000, "wasm");
      var buf = await wr.arrayBuffer();
      $scramjet.setWasm(buf);
      wasmReady = true;
      dlog("wasm ready " + buf.byteLength);
    }
    return true;
  }

  function makeCtx() {
    var baseFlags = ($scramjet.defaultConfig && $scramjet.defaultConfig.flags) || {};
    var flags = Object.assign({}, baseFlags, { sourcemaps: false, debugSourceURL: false });
    var config = Object.assign({}, $scramjet.defaultConfig, { flags: flags });
    return {
      config: config,
      prefix: new URL("/~/sj/", location.href),
      interface: {
        codecEncode: function(s) { return encodeURIComponent(s); },
        codecDecode: function(s) { return decodeURIComponent(s); },
        getInjectScripts: function() { return []; }
      },
      cookieJar: {},
      hooks: { rewriter: { html: $scramjet.Tap.create() } }
    };
  }

  function originalOf(prefixed) {
    var s = prefixed;
    var i = s.indexOf("/~/sj/");
    if (i >= 0) s = s.slice(i + 6);
    try { s = decodeURIComponent(s); } catch (e) {}
    var q = s.indexOf("?$io=");
    if (q >= 0) s = s.slice(0, q);
    return s;
  }

  function b64(bytes) {
    var binary = "";
    var chunk = 32768;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function dataUri(bytes, type) {
    return "data:" + type.split(";")[0] + ";base64," + b64(bytes);
  }

  function headerOf(headers, name) {
    if (!headers) return "";
    try {
      for (var k = 0; k < headers.length; k++) {
        if (String(headers[k][0]).toLowerCase() === name) return headers[k][1];
      }
    } catch (e) {}
    return "";
  }

  async function readAll(body) {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    var reader = body.getReader();
    var chunks = [];
    var total = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.length;
      if (total > settings.maxBytes) throw new Error("too big");
    }
    var all = new Uint8Array(total);
    var off = 0;
    chunks.forEach(function(c) { all.set(c, off); off += c.length; });
    return all;
  }

  function pageHeaders(accept, dest, site) {
    var h = [];
    try { h.push(["user-agent", navigator.userAgent]); } catch (e) {}
    h.push(["accept", accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8"]);
    h.push(["accept-language", "en-US,en;q=0.9"]);
    h.push(["sec-fetch-dest", dest || "document"]);
    h.push(["sec-fetch-mode", dest === "document" ? "navigate" : "no-cors"]);
    h.push(["sec-fetch-site", site || "none"]);
    return h;
  }

  function imageAccept(url) {
    if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\?|$)/i.test(url)) {
      return "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
    }
    return null;
  }

  async function fetchDirect(url, method, body, headers) {
    var r = await withTimeout(fetch(url, { method: method || "GET", body: body || null, headers: headers || {} }), 10000, "direct " + url.slice(0, 60));
    if (!r.ok) throw new Error("direct http " + r.status);
    var buf = await withTimeout(r.arrayBuffer(), 10000, "direct body");
    return { bytes: new Uint8Array(buf), type: r.headers.get("content-type") || "application/octet-stream" };
  }

  async function fetchBytes(url, referer, dest) {
    dlog("fetching " + url.slice(0, 80));
    var img = imageAccept(url);
    var d = dest || (img ? "image" : "empty");
    var s = (d === "document") ? "none" : "cross-site";
    var headers = pageHeaders(img || undefined, d, s);
    if (referer) headers.push(["referer", referer]);
    try {
      var direct = await fetchDirect(url, "GET", null, headers);
      dlog("direct ok " + direct.bytes.length + "B " + direct.type);
      return direct;
    } catch (e) {
      dlog("direct miss, piping " + url.slice(0, 60));
    }
    var current = url;
    var res = null;
    for (var hop = 0; hop < 5; hop++) {
      res = await withTimeout(
        transport.request(new URL(current), "GET", null, pageHeaders(), null),
        15000, "request " + current.slice(0, 60));
      if (res.status < 300 || res.status >= 400) break;
      var loc = headerOf(res.headers, "location");
      if (!loc) break;
      try { current = new URL(loc, current).href; }
      catch (e) { break; }
      dlog("redirect " + hop + " -> " + current.slice(0, 80));
    }
    if (res.status < 200 || res.status >= 300) throw new Error("http " + res.status + " " + url);
    var bytes = await withTimeout(readAll(res.body), 15000, "body " + url.slice(0, 60));
    return { bytes: bytes, type: headerOf(res.headers, "content-type") || "application/octet-stream" };
  }

  async function bridgeFetch(input, init) {
    await ensure();
    var url = (typeof input === "string") ? input : input.url;
    var o = init || {};
    var isReq = (typeof input !== "string") && input;
    var method = o.method || (isReq && isReq.method) || "GET";
    var body = (o.body !== undefined) ? o.body : (isReq ? isReq.body : null);
    var headers = [];
    var h = o.headers || (isReq ? isReq.headers : null);
    if (h) {
      if (typeof h.forEach === "function") h.forEach(function(v, k) { headers.push([k, v]); });
      else if (Array.isArray(h)) headers = h;
    }
    var buf = null;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") buf = new TextEncoder().encode(body).buffer;
      else if (body instanceof ArrayBuffer) buf = body;
      else buf = await new Response(body).arrayBuffer();
    }
    try {
      var direct = await fetchDirect(url, method, buf, headers);
      return new Response(direct.bytes, { status: 200, statusText: "OK", headers: { "content-type": direct.type } });
    } catch (e) {
      dlog("bridge direct miss, piping");
    }
    var res = await withTimeout(
      transport.request(new URL(url), method, buf, headers, null),
      20000, "bridge " + url.slice(0, 60));
    var data = await withTimeout(readAll(res.body), 15000, "bridge body");
    var rh = {};
    (res.headers || []).forEach(function(p) { rh[p[0]] = p[1]; });
    return new Response(data, { status: res.status, statusText: res.statusText || "", headers: rh });
  }

  function bridgeScript() {
    return "<script>(function(){var ALLOW=" + JSON.stringify(ALLOW) + ";" +
      "function allowed(u){try{return ALLOW.indexOf(new URL(u,location.href).hostname)!==-1;}catch(e){return false;}}" +
      "var nativeFetch=window.fetch.bind(window);" +
      "window.fetch=function(input,init){var url=(typeof input===\"string\")?input:(input&&input.url);" +
      "if(url&&allowed(url)){try{var core=window.parent&&window.parent.DgCore;" +
      "if(core&&core.bridgeFetch)return core.bridgeFetch(url,init||{});}catch(e){}}" +
      "return nativeFetch(input,init);};})();</script>";
  }

  function collectPrefixed(html, cap) {
    var seen = {};
    var out = [];
    html.replace(/(https?:\/\/[^\/\s"'<>]+)?\/~\/sj\/[^"'()\s<>]+/g, function(u) {
      if (!seen[u] && out.length < cap) { seen[u] = 1; out.push(u); }
      return u;
    });
    return out;
  }

  function rewriteText(kind, text, ctx, url) {
    var meta = { origin: new URL(new URL(url).origin), base: new URL(url) };
    try {
      if (kind === "css") return $scramjet.rewriteCss(text, ctx, meta);
      if (kind === "js") return $scramjet.rewriteJs(text, url, ctx, meta);
    } catch (e) {}
    return text;
  }

  function kindOf(url, type) {
    var u = url.split("?")[0].toLowerCase();
    var t = (type || "").toLowerCase();
    if (/\.css$/.test(u) || t.indexOf("css") !== -1) return "css";
    if (/\.js$/.test(u) || t.indexOf("javascript") !== -1) return "js";
    return "bin";
  }

  var PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  async function inlineAssets(html, pageUrl, ctx, depth) {
    var urls = collectPrefixed(html, settings.maxAssets);
    dlog("collected " + urls.length + " prefixed urls from " + pageUrl);
    for (var ci = 0; ci < Math.min(5, urls.length); ci++) {
      dlog("raw " + ci + ": " + urls[ci].slice(0, 110));
    }
    var replaced = 0;
    for (var i = 0; i < urls.length; i++) {
      var orig = originalOf(urls[i]);
      if (!orig || /^(data|blob):/i.test(orig)) { dlog("skip non-http: " + urls[i].slice(0, 80)); continue; }
      try {
        var abs = new URL(orig, pageUrl).href;
        var got = await fetchBytes(abs, pageUrl);
        var wantImg = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\?|$)/i.test(abs.split("?")[0]);
        if (wantImg && got.type.indexOf("image/") !== 0) {
          dlog("type mismatch, pixel fallback " + got.type + " " + abs.slice(0, 80));
          html = html.split(urls[i]).join(PIXEL);
          replaced++;
          continue;
        }
        dlog("fetched " + got.bytes.length + "B " + got.type + " " + abs.slice(0, 90));
        var text = null;
        if (depth > 0) {
          var k = kindOf(abs, got.type);
          if (k === "css" || k === "js") {
            text = new TextDecoder().decode(got.bytes);
            text = rewriteText(k, text, ctx, abs);
            var deeper = await inlineAssets(text, abs, ctx, depth - 1);
            text = deeper.html;
            got = { bytes: new TextEncoder().encode(text), type: got.type };
          }
        }
        var durl = dataUri(got.bytes, got.type);
        html = html.split(urls[i]).join(durl);
        replaced++;
      } catch (e) {
        dlog("asset FAIL " + (e && e.message) + " " + urls[i].slice(0, 90));
      }
    }
    dlog("replaced " + replaced + "/" + urls.length);
    var links = html.match(/<link[^>]*>/gi) || [];
    dlog("link tags: " + links.length);
    for (var li = 0; li < Math.min(3, links.length); li++) {
      dlog("link " + li + ": " + links[li].slice(0, 120));
    }
    return { html: html };
  }

  async function load(url, depth) {
    dlog("load " + url);
    await ensure();
    if (!allowed(url)) throw new Error("not allowlisted: " + url);
    var ctx = makeCtx();
    var got = null;
    try {
      got = await fetchBytes(url, null, "document");
    } catch (e) {
      dlog("page FAIL " + ((e && e.message) || e));
      throw e;
    }
    var text = new TextDecoder().decode(got.bytes);
    var meta = { origin: new URL(new URL(url).origin), base: new URL(url) };
    var html = $scramjet.rewriteHtml(text, ctx, meta, { loadScripts: true, inline: false, source: "" });
    var packed = await inlineAssets(html, url, ctx, (depth === undefined) ? 1 : depth);
    html = packed.html;
    html = html.replace(/<head[^>]*>/i, function(m) {
      var add = bridgeScript();
      if (!/<base[ >]/i.test(html)) {
        add += '<base href="' + url.replace(/"/g, "&quot;") + '">';
      }
      return m + add;
    });
    return html;
  }

  return {
    setup: setup,
    addHost: addHost,
    allowed: allowed,
    ensure: ensure,
    load: load,
    bridgeFetch: bridgeFetch,
    setDebug: function(v) { DEBUG = !!v; }
  };
})();
