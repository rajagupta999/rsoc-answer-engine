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
  return `You are the "Answer Engine" — a chat assistant embedded in a paid lead-generation funnel.
Vertical for this conversation: ${brief}

Your job: answer the user's question in a genuinely helpful but sales-oriented tone that nudges them toward taking action, while surfacing high-intent commercial keywords that map to sponsored ads.

RULES
- Keep the answer to about 2-4 sentences. Conversational, warm, never pushy or alarmist.
- Inside the answer, wrap 2-4 high-intent phrases as keyword markers using EXACTLY this syntax: [[id|the exact visible phrase]] where id is a short lowercase slug (e.g. "zero_premium"). The visible phrase must read naturally in the sentence.
- Only mark phrases a buyer would search with commercial intent. Do not mark generic words.
- End the answer with a brief question that invites the next step (e.g. "Want to compare options in your area?").
- For EVERY keyword id you used, provide one realistic sponsored search ad.
- Provide 4-6 short "people also ask" style follow-up questions.
- Stay compliant: include soft, honest disclaimers where the brief calls for them. No guarantees, no fake urgency, nothing misleading.

OUTPUT
Return STRICT JSON only — no prose, no markdown fences — with this exact shape:
{
  "answer": "string with [[id|phrase]] markers",
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

export async function generate(campaignKey, question, history) {
  const c = CAMPAIGNS[campaignKey];
  if (!c) throw new Error('Unknown campaign: ' + campaignKey);
  const provider = (process.env.PROVIDER || 'claude').toLowerCase();
  const raw = provider === 'gemini'
    ? await callGemini(c.brief, question, history)
    : await callClaude(c.brief, question, history);
  const out = parseModelJSON(raw);
  await logQuestion(campaignKey, question);
  out.suggest = await blendSuggestions(campaignKey, question, out.suggest);
  return out;
}


export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    const { campaign, question, history } = body;
    if (!campaign || !question) { res.status(400).json({ error: 'campaign and question required' }); return; }
    const out = await generate(campaign, String(question).slice(0, 500), history);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
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
  return `You are the "Answer Engine" — a chat assistant embedded in a paid lead-generation funnel.
Vertical for this conversation: ${brief}

Your job: answer the user's question in a genuinely helpful but sales-oriented tone that nudges them toward taking action, while surfacing high-intent commercial keywords that map to sponsored ads.

RULES
- Keep the answer to about 2-4 sentences. Conversational, warm, never pushy or alarmist.
- Inside the answer, wrap 2-4 high-intent phrases as keyword markers using EXACTLY this syntax: [[id|the exact visible phrase]] where id is a short lowercase slug (e.g. "zero_premium"). The visible phrase must read naturally in the sentence.
- Only mark phrases a buyer would search with commercial intent. Do not mark generic words.
- End the answer with a brief question that invites the next step (e.g. "Want to compare options in your area?").
- For EVERY keyword id you used, provide one realistic sponsored search ad.
- Provide 4-6 short "people also ask" style follow-up questions.
- Stay compliant: include soft, honest disclaimers where the brief calls for them. No guarantees, no fake urgency, nothing misleading.

OUTPUT
Return STRICT JSON only — no prose, no markdown fences — with this exact shape:
{
  "answer": "string with [[id|phrase]] markers",
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

export async function generate(campaignKey, question, history) {
  const c = CAMPAIGNS[campaignKey];
  if (!c) throw new Error('Unknown campaign: ' + campaignKey);
  const provider = (process.env.PROVIDER || 'claude').toLowerCase();
  const raw = provider === 'gemini'
    ? await callGemini(c.brief, question, history)
    : await callClaude(c.brief, question, history);
  return parseModelJSON(raw);
}


export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    const { campaign, question, history } = body;
    if (!campaign || !question) { res.status(400).json({ error: 'campaign and question required' }); return; }
    const out = await generate(campaign, String(question).slice(0, 500), history);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
