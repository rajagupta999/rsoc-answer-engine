/*
 * Contact form endpoint. Stores submissions in Upstash (same store as the rest of
 * the app) so they can be retrieved later. Self-contained — does not touch ask.js.
 */
function redisUrl() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || ''; }
function redisToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ''; }

async function redis(cmd) {
  const url = redisUrl(), token = redisToken();
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error('redis ' + res.status);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const name = String(body.name || '').trim().slice(0, 200);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 5000);
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || message.length < 2) {
      res.status(400).json({ error: 'A valid email and a message are required.' });
      return;
    }
    const rec = JSON.stringify({ name, email, message, ts: Date.now() });
    try {
      await redis(['LPUSH', 'contacts', rec]);
      await redis(['LTRIM', 'contacts', 0, 4999]); // keep the most recent 5000
    } catch (e) { /* storage best-effort; still acknowledge to the user */ }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
