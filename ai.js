
const SUPABASE_URL = 'https://rdmvncnjmnpjqixfuzpt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_rlTlh1l60XasCYbApw1QcA_zWU33wgM';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM =
  'You are the ai on pastpapergenie, a site used by school students. ' 
;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'The AI is not set up yet.' });

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Log in first.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const raw = body && Array.isArray(body.messages) ? body.messages.slice(-10) : [];
  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Send a message first.' });
  }

  let left;
  try {
    const q = await fetch(SUPABASE_URL + '/rest/v1/rpc/ai_take_turn', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!q.ok) {
      const t = await q.text();
      if (/daily_limit/.test(t)) return res.status(429).json({ error: 'You have used all your AI messages for today. Try again tomorrow.' });
      if (/banned/.test(t)) return res.status(403).json({ error: 'You cannot use the AI.' });
      return res.status(401).json({ error: 'Please log in again.' });
    }
    left = await q.json();
  } catch (e) {
    return res.status(502).json({ error: 'Could not check your account. Try again.' });
  }

  // Ask the model
  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, ...messages],
    temperature: 0.6,
    max_completion_tokens: 1200
  };
  if (/gpt-oss/.test(MODEL)) payload.reasoning_effort = 'low';

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.status === 429) return res.status(429).json({ error: 'The AI is busy right now. Try again in a minute.' });
    if (!r.ok) {
      console.error('Groq error', r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: 'The AI had a problem. Try again.' });
    }
    const data = await r.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!reply || !reply.trim()) return res.status(502).json({ error: 'The AI sent an empty answer. Try again.' });
    return res.status(200).json({ reply: reply.trim(), left });
  } catch (e) {
    console.error('Groq fetch failed', e);
    return res.status(502).json({ error: 'Could not reach the AI. Try again.' });
  }
};
