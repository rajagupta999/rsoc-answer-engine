/*
 * Shared LLM logic for the serverless functions (Vercel) and the local server.
 * Provider switchable via env: PROVIDER=claude|gemini.
 */

export const CAMPAIGNS = {
  medicare: {
    label: '2026 Medicare Advantage benefits',
    brief: 'A lead-gen "benefits assistant" for 2026 Medicare Advantage plans aimed at U.S. seniors. High-intent topics: $0 premium plans, dental/vision/hearing, grocery allowance, Part B giveback, Part D drug plans, enrollment windows, Medicare Supplement. Realistic advertisers: Humana, Aetna, Anthem, UnitedHealthcare/AARP. Always add a soft disclaimer that you are not connected with the government/Medicare and plans vary by area.'
  },
  roofing: {
    label: 'Roof replacement quotes',
    brief: 'A lead-gen "roofing advisor" for U.S. homeowners pricing a new roof in 2026. High-intent topics: free roof inspection, replacement cost, financing, storm/insurance claims, metal vs shingle. Realistic advertisers: Modernize, Angi, Erie Metal Roofs. Quotes come from independent local contractors and vary by area.'
  },
  debt: {
    label: 'Debt relief programs',
    brief: 'A lead-gen "debt relief assistant" for U.S. consumers with unsecured debt. High-intent topics: debt relief/settlement, consolidation, no upfront fees, credit impact, eligibility, timelines. Realistic advertisers: National Debt Relief, Freedom Debt Relief, Achieve. Programs are not available in all states, results vary, and this is not legal or financial advice. Keep claims careful and compliant.'
  },
  tub: {
    label: 'Walk-in tubs',
    brief: 'A lead-gen "senior safety guide" for walk-in tubs aimed at older U.S. homeowners. High-intent topics: 2026 pricing, financing/$0 down, Medicare/VA coverage, install time, safety features, free in-home quote. Realistic advertisers: Safe Step, American Standard, KOHLER. Coverage depends on eligibility and is not guaranteed.'
  }
};

export function systemPrompt(brief) {
  return `You are a friendly, knowledgeable assistant helping someone with a real question.
Topic area for this conversation: ${brief}

Your FIRST priority is to be genuinely useful — answer like a helpful, trustworthy friend who happens to know this topic well, NOT like a salesperson. Earn trust; that's what keeps people engaged.

TONE
- Lead with a clear, honest, useful answer to exactly what was asked. 2-4 short sentences.
- Warm and natural. Do NOT end every reply with a sales question. Vary your endings; sometimes just answer.
- No pressure, no hype, no fake urgency. If the honest answer is "it depends," say so and explain briefly.

KEYWORDS (light touch)
- ONLY when a high-intent commercial phrase already fits naturally in your answer, wrap it as [[id|the exact visible phrase]] (id = short lowercase slug). A buyer would realistically search that phrase.
- Use 0 to 2 such markers per reply. Zero is fine and often best. NEVER force a keyword or twist the sentence to insert one.
- The sentence must read perfectly naturally with the marker removed.

ADS
- For each keyword id you actually used, provide one realistic, compelling sponsored search ad with strong, specific commercial copy (real-sounding advertiser, benefit-led headline, concrete description, clear CTA).
- If you used no keywords, "ads" is an empty object.

FOLLOW-UPS
- Provide 4-6 short, natural follow-up questions a curious person might ask next.

COMPLIANCE
- Include soft, honest disclaimers where the topic calls for them. No guarantees. Nothing misleading.

OUTPUT
Return STRICT JSON only — no prose, no markdown fences — with this exact shape:
{
  "answer": "string with optional [[id|phrase]] markers",
  "ads": {
    "<id>": {
      "adv": "Advertiser name",
      "disp": "www.display-url.com/Path",
      "url": "https://real-or-plausible-landing-url",
      "head": "Ad headline (~6-9 words)",
      "desc": "1-2 sentence ad description.",
      "cta": "Button text (2-3 words)",
      "sitelinks": ["Optional link 1", "Optional link 2", "Optional link 3"]
    }
  },
  "suggest": ["follow-up question 1", "follow-up question 2", "..."]
}
Every id that appears in "answer" MUST have a matching key in "ads". Output nothing except the JSON object.`;
}

async function callClaude(brief, question, history) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const messages = [];
  for (const h of history || []) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: question });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt(brief), messages })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

async function callGemini(brief, question, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const contents = [];
  for (const h of history || []) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
  contents.push({ role: 'user', parts: [{ text: question }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt(brief) }] }, contents, generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

export function parseModelJSON(raw) {
  if (!raw) throw new Error('Empty model response');
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  const obj = JSON.parse(s);
  if (typeof obj.answer !== 'string') throw new Error('No answer field');
  obj.ads = obj.ads && typeof obj.ads === 'object' ? obj.ads : {};
  obj.suggest = Array.isArray(obj.suggest) ? obj.suggest : [];
  return obj;
}

/* --------------------------------------------------------------------------
 * Learning loop: log what visitors ask (Upstash Redis REST) and blend the
 * most-asked questions into the "People also ask" suggestions over time.
 * Degrades gracefully — if no store is configured, suggestions stay model-only.
 * ------------------------------------------------------------------------ */

const MIN_COUNT = 3;     // a question must be asked this many times before it can surface
const MAX_SET   = 200;   // keep only the top-N questions per campaign

function redisUrl()   { return process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || ''; }
function redisToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ''; }
function redisEnabled() { return !!(redisUrl() && redisToken()); }

async function redis(cmd) {
  const url = redisUrl(), token = redisToken();
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error('redis ' + res.status);
  const data = await res.json();
  return data.result;
}

// canonical form used both as the storage key and the displayed suggestion
function canonical(s) {
  s = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

const BANNED = /\b(fuck|shit|bitch|cunt|nigger|faggot|rape|kill yourself|kys)\b/i;

// reject junk, profanity, and anything that looks like personal data
function isLoggable(s) {
  if (s.length < 8 || s.length > 120) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(s)) return false;     // email
  if (/(?:\+?\d[\s().-]?){7,}/.test(s)) return false;          // phone-like
  if (/\b\d{5,}\b/.test(s)) return false;                      // long number (card/SSN-ish)
  if (BANNED.test(s)) return false;
  return true;
}

async function logQuestion(campaignKey, question) {
  try {
    if (!redisEnabled()) return;
    const c = canonical(question);
    if (!isLoggable(c)) return;
    const key = `paa:${campaignKey}`;
    await redis(['ZINCRBY', key, '1', c]);
    await redis(['ZREMRANGEBYRANK', key, '0', String(-(MAX_SET + 1))]); // trim to top MAX_SET
  } catch { /* never let logging break a response */ }
}

async function blendSuggestions(campaignKey, currentQ, modelSuggest) {
  const cq = canonical(currentQ);
  const model = (modelSuggest || []).filter(Boolean).slice(0, 3);
  const seen = new Set(model.map(canonical));
  seen.add(cq);

  const popular = [];
  try {
    if (redisEnabled()) {
      const raw = await redis(['ZREVRANGE', `paa:${campaignKey}`, '0', '11', 'WITHSCORES']);
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 2) {
          const member = raw[i], score = Number(raw[i + 1]);
          const c = canonical(member);
          if (score >= MIN_COUNT && !seen.has(c)) { seen.add(c); popular.push(member); }
          if (popular.length >= 3) break;
        }
      }
    }
  } catch { /* fall back to model suggestions */ }

  const blended = [...model, ...popular].slice(0, 6);
  return blended.length ? blended : (modelSuggest || []);
}

export async function generate(campaignKey, question, history, logIt = true) {
  const c = CAMPAIGNS[campaignKey];
  if (!c) throw new Error('Unknown campaign: ' + campaignKey);
  const provider = (process.env.PROVIDER || 'claude').toLowerCase();
  const raw = provider === 'gemini'
    ? await callGemini(c.brief, question, history)
    : await callClaude(c.brief, question, history);
  const out = parseModelJSON(raw);
  if (logIt) await logQuestion(campaignKey, question);   // skip the auto-fired ad opener
  out.suggest = await blendSuggestions(campaignKey, question, out.suggest);
  return out;
}

/* --------------------------------------------------------------------------
 * Lead capture (opt-in email) and lightweight engagement counters.
 * All writes degrade gracefully if no store is configured.
 * ------------------------------------------------------------------------ */

const KNOWN = new Set(Object.keys(CAMPAIGNS));
const safeKey = k => (KNOWN.has(String(k)) ? String(k) : 'other');

function validEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 120) return null;
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}

// store an opt-in email (Redis SET dedupes); returns {ok} or throws on bad input
export async function storeLead(campaign, email) {
  const e = validEmail(email);
  if (!e) throw new Error('Please enter a valid email address.');
  const k = safeKey(campaign);
  if (redisEnabled()) {
    try {
      await redis(['SADD', `leads:${k}`, e]);
      await redis(['SADD', 'leads:all', e]);
      await redis(['HINCRBY', `stats:${k}`, 'email_optin', '1']);
    } catch { /* don't fail the opt-in UX on a store hiccup */ }
  }
  return { ok: true };
}

// increment a named engagement counter for a campaign (and optional ad variant)
export async function track(campaign, metric) {
  try {
    const k = safeKey(campaign);
    const m = String(metric || '');
    if (redisEnabled() && /^[a-z0-9:_-]{1,40}$/i.test(m)) {
      await redis(['HINCRBY', `stats:${k}`, m, '1']);
    }
  } catch { /* counters are best-effort */ }
  return { ok: true };
}


export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    const action = body.action || 'ask';

    if (action === 'lead') {
      const out = await storeLead(body.campaign, body.email);
      res.status(200).json(out);
      return;
    }
    if (action === 'event') {
      const out = await track(body.campaign, body.metric);
      res.status(200).json(out);
      return;
    }

    // default: chat
    const { campaign, question, history, seed } = body;
    if (!campaign || !question) { res.status(400).json({ error: 'campaign and question required' }); return; }
    const out = await generate(campaign, String(question).slice(0, 500), history, !seed);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
