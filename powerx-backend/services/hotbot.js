// HotBot — REAL AI backend (HotBot.com: GPT-5 / Gemini 3 Pro / Claude / etc.)
//
// PRIMARY brain  : HotBot.com /api/chat (real frontier models, SSE streamed).
// FALLBACK brain : the original Gemini gateway (kept for resilience).
//
// The public contract is unchanged: `chat(messages)` takes OpenAI-style
// messages (string OR multimodal parts array) and returns a text string.
// Computational queries are still grounded with WolframAlpha-verified results.
const fetch = require('node-fetch');
const gemini = require('./gemini');
const godmode = require('./godmode3'); // 🜏 G0DM0D3 — keep the FUSION synthesizer uncensored
const wolfram = require('./wolfram');
const hotbotReal = require('./hotbotReal');
const sakana = require('./sakana');         // ── HEAD BRAIN: Sakana Chat (Namazu) — text + document analysis
// Extra brains added to the parallel race (text-only, no key / no signup).
const studentAI = require('./studentAI');     // Supabase/OpenAI tutor — text only
const aichatting = require('./aichatting');    // AIChatting.net — text only, opt-in via env
const pollinations = require('./pollinations'); // Pollinations.AI — text + image, keyless/free
const unitool = require('./unitool');          // Unitool.ai — TEXT + VISION, keyless/free (Gemini-section vision backup)
const eqingChat = require('./eqingChat');       // eqing.tech GPT-3.5-Turbo — TEXT only, keyless/free, no captcha
const ruflo = require('./ruflo');               // RuFlo (flo.ruv.io) Gemini 2.5 — TEXT only, keyless/free (anonymous session)
const novita = require('./novita');             // Novita AI (key-backed) — Gemini 3.1 Flash Image (VISION) + DeepSeek V4 Pro (TEXT)
// NOTE: DeepSeek has been REMOVED entirely (no racer, no judge). The chat path
// no longer validates with a judge brain — persistence/quality now comes from
// the agent loop's deliberate skill-loading + verification, not a judge.

// Allow ops to disable the real backend via env without a code change.
const REAL_ENABLED = String(process.env.HOTBOT_REAL_DISABLED || '').toLowerCase() !== '1' &&
                     String(process.env.HOTBOT_REAL_DISABLED || '').toLowerCase() !== 'true';
const REAL_MODEL = process.env.HOTBOT_MODEL || hotbotReal.DEFAULT_CHAT_MODEL; // 'gpt-5'
// Extra brains can be disabled via env (default ON for StudentAI, opt-in for AIChatting).
const STUDENTAI_ENABLED = String(process.env.STUDENTAI_DISABLED || '').toLowerCase() !== '1' &&
                          String(process.env.STUDENTAI_DISABLED || '').toLowerCase() !== 'true';
// Pollinations is keyless/free; default ON, disable via its own env flag.
const POLLINATIONS_ENABLED = String(process.env.POLLINATIONS_TEXT_DISABLED || '').toLowerCase() !== '1' &&
                             String(process.env.POLLINATIONS_TEXT_DISABLED || '').toLowerCase() !== 'true';
// Unitool is keyless/free TEXT+VISION; default ON, disable via UNITOOL_DISABLED.
// It is the Gemini-section VISION BACKUP: it races on multimodal (image)
// requests so the fallback/vision path stays strong even if Gemini is weak.
const UNITOOL_ENABLED = String(process.env.UNITOOL_DISABLED || '').toLowerCase() !== '1' &&
                        String(process.env.UNITOOL_DISABLED || '').toLowerCase() !== 'true';
// eqing.tech is keyless/free TEXT-only (GPT-3.5-Turbo, no captcha); default ON,
// disable via EQING_DISABLED. It races only on pure-text requests like the
// other text brains, adding more rate-limit headroom & resilience.
const EQING_ENABLED = String(process.env.EQING_DISABLED || '').toLowerCase() !== '1' &&
                      String(process.env.EQING_DISABLED || '').toLowerCase() !== 'true';
// RuFlo (flo.ruv.io) is keyless/free TEXT-only (Gemini 2.5 via an anonymous
// session cookie — nothing to mint/rotate). Default ON; disable via
// RUFLO_DISABLED. It races only on pure-text requests like the other text
// brains, adding another strong, key-free brain to the FUSION panel.
const RUFLO_ENABLED = String(process.env.RUFLO_DISABLED || '').toLowerCase() !== '1' &&
                      String(process.env.RUFLO_DISABLED || '').toLowerCase() !== 'true';

// Novita AI brains (key-backed via the saved `novita_api_key`). Two brains:
//   • VISION   — Gemini 3.1 Flash Image: races on IMAGE (multimodal) requests
//                beside the Gemini gateway + Unitool, strengthening vision.
//   • DEEPSEEK — DeepSeek V4 Pro: joins the FUSION panel on pure-text requests.
// Both are gated at RUNTIME (async) inside chatWithMeta because the key lives in
// the DB — the env flags here only allow a hard OFF switch without code change.
const NOVITA_VISION_ENABLED = String(process.env.NOVITA_VISION_DISABLED || '').toLowerCase() !== '1' &&
                              String(process.env.NOVITA_VISION_DISABLED || '').toLowerCase() !== 'true';
const NOVITA_DEEPSEEK_ENABLED = String(process.env.NOVITA_DEEPSEEK_DISABLED || '').toLowerCase() !== '1' &&
                                String(process.env.NOVITA_DEEPSEEK_DISABLED || '').toLowerCase() !== 'true';

let MODELS_CACHE = [];

// Curated model list surfaced to the app. The first entry is the active brain.
const MODELS = [
  { slug: 'gpt-5', name: 'GPT-5 (HotBot)', provider: 'hotbot', guestModelId: 'gpt-5', tagline: 'GPT-5 — reasoning, coding, planning + vision', supportsVision: true, supportsImageGen: false, status: 'active', pro: false },
  { slug: 'gemini', name: 'Gemini 3.1 Flash Lite (gateway)', provider: 'gemini-gateway', guestModelId: 'gemini', tagline: 'Gemini gateway — fallback brain', supportsVision: true, supportsImageGen: false, status: 'active', pro: false },
  // Gemini-section VISION BACKUP: keyless Unitool.ai vision brain. Sits right
  // under the Gemini gateway so the fallback/vision path stays strong even if
  // Gemini is weak or down.
  { slug: 'unitool', name: 'Unitool Vision (Gemini backup)', provider: 'unitool', guestModelId: 'unitool', tagline: 'Unitool.ai — keyless TEXT + VISION, strengthens the Gemini fallback', supportsVision: true, supportsImageGen: false, status: 'active', pro: false },
  { slug: 'pollinations', name: 'Pollinations (GPT-OSS)', provider: 'pollinations', guestModelId: 'pollinations', tagline: 'Pollinations.AI — keyless text + image', supportsVision: true, supportsImageGen: true, status: 'active', pro: false },
  // Keyless TEXT-only fast fallback: eqing.tech GPT-3.5-Turbo. No key, no
  // signup, no captcha — joins the text race for extra rate-limit headroom.
  { slug: 'eqing', name: 'GPT-3.5-Turbo (eqing)', provider: 'eqing', guestModelId: 'eqing', tagline: 'eqing.tech — keyless GPT-3.5-Turbo, text only', supportsVision: false, supportsImageGen: false, status: 'active', pro: false },
  // Keyless TEXT-only brain: RuFlo (flo.ruv.io) — Gemini 2.5 via an anonymous
  // session (no key/signup). Joins the text race for extra quality & headroom.
  { slug: 'ruflo', name: 'RuFlo (Gemini 2.5)', provider: 'ruflo', guestModelId: 'ruflo', tagline: 'flo.ruv.io — keyless Gemini 2.5, text only', supportsVision: false, supportsImageGen: false, status: 'active', pro: false },
  // Novita VISION brain: Gemini 3.1 Flash Image. Key-backed multimodal model
  // that races beside the Gemini gateway + Unitool on IMAGE requests, giving the
  // Gemini/vision fallback a strong, frontier-class second eye on the picture.
  { slug: 'novita-gemini-vision', name: 'Gemini 3.1 Flash Image (Novita)', provider: 'novita', guestModelId: 'novita-gemini-vision', tagline: 'Novita — Gemini 3.1 Flash Image, TEXT + VISION', supportsVision: true, supportsImageGen: false, status: 'active', pro: false },
  // Novita DEEPSEEK brain: DeepSeek V4 Pro. Key-backed reasoning/coding model
  // that joins the FUSION panel on pure-text requests as another top proposer.
  { slug: 'novita-deepseek', name: 'DeepSeek V4 Pro (Novita)', provider: 'novita', guestModelId: 'novita-deepseek', tagline: 'Novita — DeepSeek V4 Pro, text reasoning & coding', supportsVision: false, supportsImageGen: false, status: 'active', pro: false },
];

async function refreshModels() {
  // Best-effort: pull the live HotBot model list and merge it in. Never throw.
  try {
    if (REAL_ENABLED) {
      const live = await hotbotReal.listModels();
      const mapped = live
        .filter(m => m && m.slug)
        .map(m => ({
          slug: m.slug,
          name: m.name || m.slug,
          provider: 'hotbot',
          guestModelId: m.slug,
          tagline: `${m.name || m.slug} [${m.provider || 'hotbot'}]`,
          supportsVision: true,
          supportsImageGen: /image|seedream|recraft|ideogram|nano-banana|wan/i.test(m.slug),
          status: 'active',
          pro: false,
        }));
      // Keep gpt-5 first, then the live HotBot models, then the static
      // "section" brains (Gemini gateway + Unitool vision backup + Pollinations
      // + the keyless eqing GPT-3.5-Turbo) so every fallback/keyless brain stays
      // visible alongside the live HotBot models. MODELS.slice(1) is all the
      // static entries after the gpt-5 primary.
      if (mapped.length) { MODELS_CACHE = [MODELS[0], ...mapped, ...MODELS.slice(1)]; return MODELS_CACHE; }
    }
  } catch (_) { /* fall through to static list */ }
  MODELS_CACHE = MODELS;
  return MODELS_CACHE;
}
async function getModels() { if (!MODELS_CACHE.length) await refreshModels(); return MODELS_CACHE; }
function supportsVision() { return true; }
function supportsImageGen() { return REAL_ENABLED || pollinations.imageEnabled(); }

/**
 * Convert an OpenAI-style message content into Gemini parts array.
 * Supports: string content, text+image_url arrays, base64 data URIs.
 * (Used only by the Gemini fallback path.)
 */
function buildGeminiParts(content) {
  const parts = [];

  if (typeof content === 'string') {
    parts.push({ text: content || '' });
    return parts;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        parts.push({ text: item.text || '' });
      } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        const url = item.image_url.url;
        // Handle data URIs: data:image/jpeg;base64,XXXX
        // NOTE: tolerant parser — supports any image subtype (jpeg/png/webp/gif/
        // bmp/tiff/heic/svg+xml), optional media-type parameters, and ";base64".
        if (url.startsWith('data:')) {
          const match = url.match(/^data:image\/([\w.+-]+)(?:;[^,]*)?;base64,(.+)$/i);
          if (match) {
            let sub = match[1].toLowerCase();
            if (sub === 'jpg') sub = 'jpeg';
            const mimeType = `image/${sub}`;
            parts.push({ inline_data: { mime_type: mimeType, data: match[2] } });
          } else {
            // Fallback: still try to salvage the base64 payload after the comma.
            const comma = url.indexOf(',');
            if (comma > 0) {
              parts.push({ inline_data: { mime_type: 'image/jpeg', data: url.slice(comma + 1) } });
            }
          }
        } else if (url.startsWith('http')) {
          // Remote URL — the gateway can't fetch it, so flag it for the caller.
          parts.push({ text: `[Image URL provided but not inlined: ${url}]` });
        }
      }
    }
    return parts;
  }

  parts.push({ text: JSON.stringify(content) });
  return parts;
}

/**
 * Convert an array of OpenAI-style messages to Gemini contents.
 * Extracts the system message (handled separately via system_instruction).
 */
function messagesToGemini(messages) {
  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = msg.content;
      continue;
    }
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: buildGeminiParts(msg.content),
    });
  }

  return { contents, systemInstruction };
}

/** Extract the latest user text from an OpenAI-style messages array. */
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const txt = m.content.filter(p => p.type === 'text').map(p => p.text).join(' ').trim();
      if (txt) return txt;
    }
  }
  return '';
}

/**
 * Augment computational queries with WolframAlpha-verified results so the
 * model answers with real computed values instead of guessing.
 */
// Wolfram grounding is OPTIONAL latency. It must NEVER delay the reply for more
// than this budget; if it's slow we just skip it and let the model answer.
const WOLFRAM_TIMEOUT_MS = parseInt(process.env.HOTBOT_WOLFRAM_TIMEOUT_MS || '6000', 10);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'op') + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

// ── WHICH BOT REPLIED ────────────────────────────────────────────────────────
// Friendly, human-readable display names for every brain that can win the race.
// Surfaced to the UI so the user sees exactly which bot inside the HotBot pool
// (and the Gemini section) actually produced the reply.
const BRAIN_LABELS = {
  sakana:       'Sakana (Namazu)',
  hotbot:       'GPT-5 (HotBot)',
  gemini:       'Gemini 3.1 Flash Lite',
  studentai:    'StudentAI',
  aichatting:   'AIChatting',
  pollinations: 'Pollinations (GPT-OSS)',
  unitool:      'Unitool Vision',
  eqing:        'GPT-3.5-Turbo (eqing)',
  ruflo:        'RuFlo (Gemini 2.5)',
  'novita-vision':   'Gemini 3.1 Flash Image (Novita)',
  'novita-deepseek': 'DeepSeek V4 Pro (Novita)',
};
function brainLabel(brain) { return BRAIN_LABELS[brain] || (brain || 'HotBot'); }

/**
 * Like Promise.any, but resolves with { reply, brain } for the FIRST racer that
 * succeeds — so we know exactly which bot won the race. Rejects with an
 * AggregateError-style error only if every racer fails.
 * @param {Array<{brain:string, run:Promise<string>}>} racers
 */
function firstSuccess(racers) {
  return new Promise((resolve, reject) => {
    let pending = racers.length;
    const errors = [];
    if (!pending) { reject(new Error('no racers')); return; }
    let settled = false;
    for (const r of racers) {
      Promise.resolve(r.run).then(
        (reply) => {
          if (settled) return;
          settled = true;
          resolve({ reply: String(reply), brain: r.brain });
        },
        (err) => {
          errors.push(err);
          if (--pending === 0 && !settled) {
            const agg = new Error('all brains failed');
            agg.errors = errors;
            reject(agg);
          }
        }
      );
    }
  });
}

async function wolframContext(messages) {
  try {
    const q = latestUserText(messages);
    if (!q || !wolfram.looksComputational(q)) return '';
    const r = await withTimeout(wolfram.ask(q), WOLFRAM_TIMEOUT_MS, 'wolfram');
    if (!r.ok || !r.answer) return '';
    return `\n\n[VERIFIED COMPUTATION — WolframAlpha (computational knowledge engine) returned the following authoritative, multi-section result for the user's query. These numbers/facts are EXACT and must be treated as ground truth.

${r.answer.slice(0, 6000)}

INSTRUCTIONS FOR YOUR REPLY:
- Use these exact values; never contradict or silently recompute them.
- Do NOT just paste the raw block above. Write a full, conversational, well-structured answer like a smart human expert tutoring the user.
- Explain WHAT the result means, HOW it is obtained (the key steps / reasoning), and WHY it is correct.
- Be detailed and thorough: use short paragraphs, headings or bullets when helpful, and proper math notation.
- End with a brief takeaway or, when relevant, a sanity check. Keep it accurate above all else.]`;
  } catch (_) {
    return '';
  }
}

/** Call the REAL HotBot backend (GPT-5 etc.) with OpenAI-style messages. */
async function realChat(messages, opts = {}) {
  return await hotbotReal.chat(messages, { model: REAL_MODEL, ...opts });
}

/** Call the legacy Gemini gateway (fallback). */
async function geminiChat(messages) {
  const { contents, systemInstruction } = messagesToGemini(messages);
  const payload = { contents };
  payload.system_instruction = systemInstruction
    ? { parts: [{ text: systemInstruction }] }
    : { parts: [{ text: gemini.SYSTEM_PROMPT }] };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(gemini.BASE_URL + gemini.ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': gemini.AUTH_TOKEN },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Gemini API error (${resp.status}): ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const reply = gemini.extractText(data);
      if (reply) return reply;
      throw new Error('Empty response from Gemini');
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr || new Error('Gemini gateway failed');
}

/** Extract the latest user text from OpenAI-style messages. */
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const txt = m.content.filter(p => p.type === 'text').map(p => p.text).join(' ').trim();
      if (txt) return txt;
    }
  }
  return '';
}

/**
 * Send messages and get a text reply.
 *
 * PERSISTENCE MODE (default): instead of shipping whichever brain finishes
 * FIRST (the old speed race), we PREFER the strongest brain and give it time to
 * think. HotBot (GPT-5) is the primary; we wait for it. Only if it fails or
 * times out do we fall back to the next brain. This trades a little latency for
 * deeper, higher-quality answers — exactly the "stop rushing, think it through"
 * behaviour the user asked for. DeepSeek (racer + judge) has been removed.
 *
 * Set HOTBOT_SPEED=1 to restore the old first-to-finish race (faster, shallower).
 * Set HOTBOT_SOLO=gemini|hotbot to force a single brain.
 * Supports multimodal input (text + images). Auto-grounds computational
 * queries with WolframAlpha-verified results (time-bounded, never blocks).
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts optional { model, mode, onToken } passed to the real backend.
 */
const SOLO = String(process.env.HOTBOT_SOLO || '').toLowerCase(); // '', 'gemini', 'hotbot'
// PERSISTENCE is the default. Flip to the old speed race with HOTBOT_SPEED=1.
const SPEED_MODE = String(process.env.HOTBOT_SPEED || '').toLowerCase() === '1' ||
                   String(process.env.HOTBOT_SPEED || '').toLowerCase() === 'true';
// Hard ceiling on each brain so a hung upstream can't stall the whole request.
// In persistence mode we give the primary brain MORE time to think (it's not
// racing anyone), so the ceiling is higher than the old speed-race default.
const HOTBOT_BRAIN_TIMEOUT_MS = parseInt(
  process.env.HOTBOT_BRAIN_TIMEOUT_MS || (SPEED_MODE ? '45000' : '90000'), 10);

// ── FUSION MODE (Mixture-of-Agents) ──────────────────────────────────────────
// The DEFAULT high-quality path. Instead of shipping whichever single brain
// finishes first (speed race) or the first preferred brain that succeeds
// (persistence), FUSION runs several independent brains IN PARALLEL as
// "proposers", collects every valid candidate answer, then has the strongest
// brain (HotBot / GPT-5) act as an AGGREGATOR: it reads all candidates, keeps
// the correct/strongest parts of each, discards mistakes, and writes ONE final
// answer that is more accurate, complete and well-reasoned than any single
// proposer — Claude-Opus-class quality. This is the published "Mixture-of-
// Agents" technique (multiple models proposing + one synthesising) and is the
// single biggest lever for response quality without paid frontier APIs.
//
//   FUSION_MODE = 1/on (DEFAULT) → fuse candidates into one superior answer
//   FUSION_MODE = 0/off          → fall back to persistence/speed race
//   HOTBOT_SPEED=1 or SOLO set   → fusion auto-disabled (single-brain intent)
//
// Tunables:
//   FUSION_MIN_CANDIDATES  (default 2) — below this we just ship the best single
//                                        candidate (nothing meaningful to fuse).
//   FUSION_PROPOSER_MS     (default 60000) — per-proposer wait budget.
//   FUSION_AGG_MS          (default 75000) — aggregator (synthesis) budget.
const FUSION_MODE = (() => {
  const v = String(process.env.FUSION_MODE != null ? process.env.FUSION_MODE : '1').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
})();
const FUSION_MIN_CANDIDATES = parseInt(process.env.FUSION_MIN_CANDIDATES || '2', 10);
const FUSION_PROPOSER_MS = parseInt(process.env.FUSION_PROPOSER_MS || '35000', 10);
const FUSION_AGG_MS = parseInt(process.env.FUSION_AGG_MS || '40000', 10);

// ── FUSION quality boosters (NEW — env-gated, backward-compatible) ───────────
// These make the unified answer measurably stronger / more reliable without
// touching any route, auth, or the agent JSON loop. All default to safe values
// that fit under Render's ~50s free-tier HTTP gateway.
//
//   FUSION_VERIFY=1 (DEFAULT)  — after synthesis, run ONE quick self-check /
//                                refine pass on HARD questions so the final
//                                answer is verified & tightened (Opus-class
//                                "think, then double-check" behaviour). Skipped
//                                for trivial questions and when the time budget
//                                is too tight to fit it safely.
//   FUSION_VERIFY_MS (8000)    — budget for the verify/refine pass.
//   FUSION_SYNTH_RETRIES (1)   — extra retries (with jitter) per synthesiser so
//                                a transient HotBot 403 / rate_limit_guest does
//                                NOT collapse quality to a weaker fallback.
//   FUSION_PROPOSER_STAGGER_MS (250) — tiny stagger between proposer launches so
//                                a burst of parallel requests is less likely to
//                                trip an upstream's per-IP rate limit.
const FUSION_VERIFY = (() => {
  const v = String(process.env.FUSION_VERIFY != null ? process.env.FUSION_VERIFY : '1').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
})();
const FUSION_VERIFY_MS = parseInt(process.env.FUSION_VERIFY_MS || '8000', 10);
const FUSION_SYNTH_RETRIES = Math.max(0, parseInt(process.env.FUSION_SYNTH_RETRIES || '1', 10));
const FUSION_PROPOSER_STAGGER_MS = Math.max(0, parseInt(process.env.FUSION_PROPOSER_STAGGER_MS || '250', 10));

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` up to (1 + retries) times with jittered backoff. Resolves with the
 * first non-empty string result; throws the last error if all attempts fail.
 * Used to harden the FUSION synthesiser against transient upstream 403 /
 * rate-limit blips (HotBot guest access occasionally rejects bursts).
 */
async function retryText(fn, retries, baseDelayMs, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = await fn();
      if (out && String(out).trim()) return String(out);
      throw new Error('empty response');
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const jitter = Math.floor(Math.random() * 400);
        await _sleep(baseDelayMs * (attempt + 1) + jitter);
      }
    }
  }
  throw lastErr || new Error((label || 'op') + ' failed');
}

/**
 * Heuristic: does this question deserve the FULL fusion treatment (more
 * proposers + a verify/refine pass)? Hard = math/multi-step reasoning, coding,
 * analysis, or simply a long/complex prompt. Trivial greetings / one-liners
 * stay on the fast path so latency for easy chat is unchanged.
 */
function isHardQuery(q) {
  const s = String(q || '');
  if (s.length >= 220) return true; // long / detailed prompt
  const wordCount = s.trim().split(/\s+/).length;
  if (wordCount >= 40) return true;
  return /\b(prove|derive|calculate|compute|solve|algorithm|complexity|optimi[sz]e|debug|refactor|implement|architecture|design|analy[sz]e|compare|trade-?off|step[\s-]?by[\s-]?step|show\s+(your\s+)?work|reasoning|why|how does|how do|how would|explain how|exploit|payload|reverse|decompile|vulnerab|sql\s*injection|buffer\s*overflow|equation|integral|derivative|matrix|theorem|regex|modular|arithmetic|probability|how many|how much|what day|big-?o)\b/i.test(s)
      || /```|\bdef \b|\bclass \b|function\s*\(|=>|\bSELECT\b|\bcurl\b|#include/i.test(s)
      || /\d.*[-+*/=^%].*\d/.test(s); // looks like a calculation / formula
}

// ── LONG-FORM / MULTI-PART WRITING DETECTION ─────────────────────────────────
// The single biggest quality complaint: for BIG writing tasks (write a 20-page
// story, a full book chapter, a long essay, "answer ALL of these questions",
// a numbered list where every item must be fully answered) the fusion pipeline
// used to SHORTEN the output — the aggregator "merges" candidates and the
// verify pass "removes padding", both of which collapse a long deliverable into
// a summary. When we detect a long-form / multi-part request we switch to a
// COMPLETION-FIRST strategy: never trim, keep every part, expand to the
// requested length, and continue the answer if it was cut off.
function isLongFormWrite(q) {
  const s = String(q || '');
  // Explicit long-form writing verbs / nouns.
  if (/\b(write|compose|create|draft|generate|produce|expand|continue|rewrite|make me)\b/i.test(s)
      && /\b(story|novel|book|chapter|chapters|essay|article|blog|report|screenplay|script|poem|saga|tale|fiction|narrative|guide|tutorial|documentation|paper|thesis|dissertation|manual|ebook|e-book)\b/i.test(s)) {
    return true;
  }
  // Explicit length targets: "20 pages", "5 chapters", "2000 words", "10 sections".
  if (/\b\d{1,4}\s*[-\s]?(page|pages|word|words|chapter|chapters|section|sections|paragraph|paragraphs|scene|scenes|verse|verses|stanza|stanzas)\b/i.test(s)) {
    return true;
  }
  // "answer all / every question", "do not summarize / don't shorten", "in full",
  // "as long / detailed as possible", "full detail", "complete ... story/answer".
  if (/\b(answer\s+(all|every|each)|address\s+(all|every|each)|(don'?t|do\s*not|never)\s+(summari[sz]e|shorten|abbreviate|truncate|cut)|in\s+full|full\s+detail|as\s+(long|detailed|thorough)\s+as\s+possible|complete\s+(story|answer|guide|list|essay)|entire\s+(story|book|essay)|the\s+whole\s+(story|thing))\b/i.test(s)) {
    return true;
  }
  // Many numbered / bulleted sub-questions (>=4) → every one must be answered.
  const numbered = (s.match(/(^|\n|\s)\d{1,2}[\.\)]\s/g) || []).length;
  if (numbered >= 4) return true;
  const bulleted = (s.match(/(^|\n)\s*[-*•]\s/g) || []).length;
  if (bulleted >= 5) return true;
  // Multiple explicit questions in one prompt.
  const qmarks = (s.match(/\?/g) || []).length;
  if (qmarks >= 4) return true;
  return false;
}

// Rough "did the model get cut off mid-thought / leave the task unfinished?"
// heuristic used to trigger a continuation pass for long-form deliverables.
function looksTruncated(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  const tail = s.slice(-2);
  // Ends without sentence-final punctuation / closing markup → likely cut off.
  if (!/[.!?"'”’)\]}`\-–—…:]\s*$/.test(tail) && !/\n\s*$/.test(s)) {
    // A long body that ends mid-word / mid-sentence is a strong truncation signal.
    if (s.length > 400) return true;
  }
  // Unclosed code fence.
  if (((s.match(/```/g) || []).length % 2) === 1) return true;
  // Trailing connective / dangling word.
  if (/\b(and|but|or|the|a|an|to|of|with|for|because|so|then|which|that|as)\s*$/i.test(s)) return true;
  return false;
}

// ── LONG-FORM budgets & continuation controls (env-gated, safe defaults) ─────
// When a long-form request is detected we give the proposers, aggregator and
// verify pass MORE time so a long stream is not chopped by a timeout, and we
// enable a bounded continuation loop so a big deliverable finishes even when a
// single upstream response is length-limited.
const LONGFORM_ENABLED = (() => {
  const v = String(process.env.FUSION_LONGFORM != null ? process.env.FUSION_LONGFORM : '1').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
})();
const LONGFORM_PROPOSER_MS = parseInt(process.env.FUSION_LONGFORM_PROPOSER_MS || '110000', 10);
const LONGFORM_AGG_MS = parseInt(process.env.FUSION_LONGFORM_AGG_MS || '120000', 10);
const LONGFORM_VERIFY_MS = parseInt(process.env.FUSION_LONGFORM_VERIFY_MS || '90000', 10);
// Continuation: keep asking the winning brain to CONTINUE until the deliverable
// is complete (or these limits are hit). Each continuation appends more text.
const LONGFORM_CONTINUE_MAX = Math.max(0, parseInt(process.env.FUSION_CONTINUE_MAX || '4', 10));
const LONGFORM_CONTINUE_MS = parseInt(process.env.FUSION_CONTINUE_MS || '110000', 10);
const LONGFORM_MIN_CHARS = parseInt(process.env.FUSION_LONGFORM_MIN_CHARS || '2500', 10);

async function chatWithMeta(messages, opts = {}) {
  // Capture the ORIGINAL user text BEFORE any grounding is appended. The
  // WolframAlpha grounding below prepends a large verified-computation block
  // (with prose instructions) to the user turn; classifying long-form / hard
  // off the *augmented* text would wrongly flag simple factual queries as
  // long-form. Always classify off what the user actually asked.
  const originalUserQ = latestUserText(messages) || '';

  // Ground computational queries in real WolframAlpha results before sending.
  // Time-bounded inside wolframContext — if it's slow it returns '' and we move on.
  // SKIP when the caller is the agent's JSON-mode ReAct loop (_agentLoop): the
  // grounding appends prose to the user turn, which would break the strict
  // single-JSON-object the loop must return. The agent has its own wolfram_alpha
  // tool for verified math instead.
  const wolfram_ctx = opts._agentLoop ? '' : await wolframContext(messages);
  if (wolfram_ctx) {
    const msgs = messages.map(m => ({ ...m }));
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      if (typeof msgs[i].content === 'string') {
        msgs[i].content = msgs[i].content + wolfram_ctx;
      } else if (Array.isArray(msgs[i].content)) {
        msgs[i].content = [...msgs[i].content, { type: 'text', text: wolfram_ctx }];
      }
      break;
    }
    messages = msgs;
  }

  const wantHotbot = REAL_ENABLED && SOLO !== 'gemini';
  const wantGemini = SOLO !== 'hotbot';

  // Text-only extra brains only join the race when the request is pure text
  // (no images/files). They make replies faster & more resilient and add
  // headroom against any single provider's rate limit.
  const isMultimodal = messages.some(m => Array.isArray(m.content) &&
    m.content.some(p => p && p.type && p.type !== 'text'));
  // _agentLoop: the JSON-mode ReAct brain. Use ONLY the real HotBot (GPT-5) so
  // the strict {"thought","action","args"} protocol is followed consistently
  // (the secondary text brains format JSON differently and would break the
  // loop). agentEngine.geminiComplete() already provides Gemini → Cloudflare as
  // explicit fallbacks for this path, so resilience is preserved upstream.
  const agentLoop = !!opts._agentLoop;
  const wantStudent = !agentLoop && STUDENTAI_ENABLED && SOLO === '' && !isMultimodal;
  const wantAichat = !agentLoop && aichatting.isEnabled() && SOLO === '' && !isMultimodal;
  // Pollinations supports vision models, but to keep the text race fast & cheap
  // we only race it on pure-text requests (same policy as the other extra brains).
  const wantPollinations = !agentLoop && POLLINATIONS_ENABLED && pollinations.isEnabled() && SOLO === '' && !isMultimodal;
  // Unitool is the Gemini-section VISION BACKUP. Unlike the text-only brains,
  // it joins the race on BOTH pure-text AND multimodal (image) requests, so the
  // vision/fallback path always has a strong second brain alongside Gemini.
  // It is keyless/free; gated only by SOLO and the agent JSON loop.
  const wantUnitool = !agentLoop && UNITOOL_ENABLED && unitool.isEnabled() && SOLO === '';
  // eqing.tech (GPT-3.5-Turbo) is a keyless TEXT-only brain. Like the other
  // text brains, it joins the race ONLY on pure-text requests (no images/files)
  // and is gated out of the agent JSON loop. Adds rate-limit headroom & a fast,
  // captcha-free fallback that needs no key.
  const wantEqing = !agentLoop && EQING_ENABLED && eqingChat.isEnabled() && SOLO === '' && !isMultimodal;
  // RuFlo (flo.ruv.io / Gemini 2.5) is a keyless TEXT-only brain. Like the other
  // text brains, it joins the race ONLY on pure-text requests (no images/files)
  // and is gated out of the agent JSON loop. It adds another strong, key-free
  // proposer to the FUSION panel (and a resilient fallback in persistence mode).
  const wantRuflo = !agentLoop && RUFLO_ENABLED && ruflo.isEnabled() && SOLO === '' && !isMultimodal;
  // Novita brains (key-backed — resolve the async enable gates once, up front).
  //   • VISION (Gemini 3.1 Flash Image): joins on BOTH text and IMAGE requests,
  //     like the Unitool vision backup, so the Gemini/vision path is stronger.
  //   • DEEPSEEK (DeepSeek V4 Pro): text-only proposer (skipped on multimodal),
  //     like the other text brains.
  // Both are gated out of the agent JSON loop and any forced SOLO brain.
  const novitaVisionOK = (!agentLoop && NOVITA_VISION_ENABLED && SOLO === '')
    ? await novita.isVisionEnabled().catch(() => false)
    : false;
  const novitaDeepseekOK = (!agentLoop && NOVITA_DEEPSEEK_ENABLED && SOLO === '' && !isMultimodal)
    ? await novita.isDeepseekEnabled().catch(() => false)
    : false;
  const wantNovitaVision = novitaVisionOK;
  const wantNovitaDeepseek = novitaDeepseekOK;
  // DeepSeek has been REMOVED entirely — no racer, no judge.

  // In agent-loop mode, keep Gemini OUT of the in-chat race so the real HotBot
  // (GPT-5) is the brain that produces the JSON action. Gemini still serves as
  // an explicit fallback one level up (agentEngine.geminiComplete), and as the
  // vision/file-analysis engine — it just doesn't compete for the ReAct step.
  const raceWantGemini = wantGemini && !agentLoop;

  // Build the brain racers. `extraHint`, when present, is appended to the last
  // user turn so a re-verify pass carries the judge's critique to the brains.
  function buildRacers(extraHint) {
    const msgs = extraHint
      ? (() => {
          const cloned = messages.map(m => ({ ...m }));
          for (let i = cloned.length - 1; i >= 0; i--) {
            if (cloned[i].role !== 'user') continue;
            if (typeof cloned[i].content === 'string') cloned[i].content += '\n\n' + extraHint;
            else if (Array.isArray(cloned[i].content)) cloned[i].content = [...cloned[i].content, { type: 'text', text: extraHint }];
            break;
          }
          return cloned;
        })()
      : messages;

    const racers = [];
    if (wantHotbot) {
      racers.push({ brain: 'hotbot', run: (async () => {
        const reply = await withTimeout(realChat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'hotbot');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from HotBot');
      })() });
    }
    if (raceWantGemini) {
      racers.push({ brain: 'gemini', run: (async () => {
        const reply = await withTimeout(geminiChat(msgs), HOTBOT_BRAIN_TIMEOUT_MS, 'gemini');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from Gemini');
      })() });
    }
    if (wantStudent) {
      racers.push({ brain: 'studentai', run: (async () => {
        const reply = await withTimeout(studentAI.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'studentai');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from StudentAI');
      })() });
    }
    if (wantAichat) {
      racers.push({ brain: 'aichatting', run: (async () => {
        const reply = await withTimeout(aichatting.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'aichatting');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from AIChatting');
      })() });
    }
    if (wantPollinations) {
      racers.push({ brain: 'pollinations', run: (async () => {
        const reply = await withTimeout(pollinations.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'pollinations');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from Pollinations');
      })() });
    }
    // Unitool VISION BACKUP — races on text AND images (strengthens Gemini fallback).
    if (wantUnitool) {
      racers.push({ brain: 'unitool', run: (async () => {
        const reply = await withTimeout(unitool.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'unitool');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from Unitool');
      })() });
    }
    // eqing.tech GPT-3.5-Turbo — keyless TEXT brain (pure-text races only).
    if (wantEqing) {
      racers.push({ brain: 'eqing', run: (async () => {
        const reply = await withTimeout(eqingChat.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'eqing');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from eqing');
      })() });
    }
    // RuFlo (flo.ruv.io / Gemini 2.5) — keyless TEXT brain (pure-text races only).
    if (wantRuflo) {
      racers.push({ brain: 'ruflo', run: (async () => {
        const reply = await withTimeout(ruflo.chat(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'ruflo');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from RuFlo');
      })() });
    }
    // Novita — Gemini 3.1 Flash Image (VISION). Races on text AND images, like
    // the Unitool backup, to strengthen the Gemini/vision path.
    if (wantNovitaVision) {
      racers.push({ brain: 'novita-vision', run: (async () => {
        const reply = await withTimeout(novita.chatVision(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'novita-vision');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from Novita Gemini Vision');
      })() });
    }
    // Novita — DeepSeek V4 Pro (TEXT). Joins the FUSION panel on pure-text.
    if (wantNovitaDeepseek) {
      racers.push({ brain: 'novita-deepseek', run: (async () => {
        const reply = await withTimeout(novita.chatDeepseek(msgs, opts), HOTBOT_BRAIN_TIMEOUT_MS, 'novita-deepseek');
        if (reply && String(reply).trim()) return String(reply);
        throw new Error('Empty response from Novita DeepSeek');
      })() });
    }
    return racers;
  }

  // ── PERSISTENCE-MODE RESOLUTION (default) ────────────────────────────────
  // Instead of "first to finish wins", we PREFER the strongest brain and give
  // it time to think. We try brains in a quality-ordered sequence and return
  // the first one that produces a valid reply — but we WAIT for each preferred
  // brain instead of racing them. Only on failure/timeout do we fall back to
  // the next brain. (Set HOTBOT_SPEED=1 to restore the old first-to-finish race.)
  //
  // Quality order: hotbot (GPT-5) → gemini → unitool → studentai → pollinations
  // → aichatting. Each entry is gated exactly like the racers above.
  function buildOrderedBrains() {
    const list = [];
    if (wantHotbot)         list.push({ brain: 'hotbot',          run: (m) => realChat(m, opts) });
    if (raceWantGemini)     list.push({ brain: 'gemini',          run: (m) => geminiChat(m) });
    if (wantNovitaDeepseek) list.push({ brain: 'novita-deepseek', run: (m) => novita.chatDeepseek(m, opts) });
    if (wantNovitaVision)   list.push({ brain: 'novita-vision',   run: (m) => novita.chatVision(m, opts) });
    if (wantUnitool)        list.push({ brain: 'unitool',         run: (m) => unitool.chat(m, opts) });
    if (wantStudent)        list.push({ brain: 'studentai',       run: (m) => studentAI.chat(m, opts) });
    if (wantPollinations)   list.push({ brain: 'pollinations',    run: (m) => pollinations.chat(m, opts) });
    if (wantAichat)         list.push({ brain: 'aichatting',      run: (m) => aichatting.chat(m, opts) });
    if (wantEqing)          list.push({ brain: 'eqing',           run: (m) => eqingChat.chat(m, opts) });
    if (wantRuflo)          list.push({ brain: 'ruflo',           run: (m) => ruflo.chat(m, opts) });
    return list;
  }

  // Run the brain race once and return { reply, brain } from the first valid
  // reply (Gemini is the safety net if every brain fails).
  async function runRace() {
    // SPEED MODE — old behaviour: all brains in parallel, first valid wins.
    if (SPEED_MODE) {
      const racers = buildRacers();
      if (!racers.length) return { reply: await geminiChat(messages), brain: 'gemini' };
      try {
        return await firstSuccess(racers);
      } catch (aggErr) {
        const msg = (aggErr && aggErr.errors ? aggErr.errors : [aggErr])
          .map(e => (e && e.message) || String(e)).join(' | ');
        console.warn('[hotbot] all brains failed: ' + msg);
        return { reply: await geminiChat(messages), brain: 'gemini' }; // last-ditch
      }
    }

    // PERSISTENCE MODE — try the strongest brain first and WAIT for it; only
    // fall back to the next brain on failure. No racing, no rushing.
    const ordered = buildOrderedBrains();
    if (!ordered.length) return { reply: await geminiChat(messages), brain: 'gemini' };
    const errors = [];
    for (const b of ordered) {
      try {
        const reply = await withTimeout(Promise.resolve(b.run(messages)), HOTBOT_BRAIN_TIMEOUT_MS, b.brain);
        if (reply && String(reply).trim()) return { reply: String(reply), brain: b.brain };
        throw new Error('Empty response from ' + b.brain);
      } catch (e) {
        errors.push((e && e.message) || String(e));
        // keep going down the preference order — persistence, not surrender
      }
    }
    console.warn('[hotbot] all brains failed (persistence): ' + errors.join(' | '));
    return { reply: await geminiChat(messages), brain: 'gemini' }; // last-ditch
  }

  // ── FUSION (Mixture-of-Agents) RESOLUTION ────────────────────────────────
  // Gather candidate answers from several brains IN PARALLEL, then let the
  // strongest brain (HotBot / GPT-5) synthesise them into ONE superior answer.
  // Returns { reply, brain } where brain is 'fusion(...)' listing the proposers.
  async function runFusion() {
    // Classify off the ORIGINAL user text (pre-grounding). The augmented
    // `messages` still carry any Wolfram context for the brains to use, but
    // long-form / hard detection must reflect what the user actually asked.
    const userQ = originalUserQ || latestUserText(messages) || '';

    // ── LONG-FORM COMPLETION LOOP ───────────────────────────────────────────
    // For big writing tasks, a single upstream response is often length-limited
    // and stops mid-deliverable. This loop asks the winning brain to CONTINUE
    // exactly where it stopped and appends the continuation, repeating until the
    // piece is complete, no more progress is made, or the bounded limits hit.
    // Defined here so it's in scope for every return path in runFusion.
    async function completeLongForm(text, brainLabelStr, question) {
      if (!LONGFORM_ENABLED) return text;
      let full = String(text || '').trim();
      // Continuation brain preference: same strong brain, then Gemini.
      const contFns = [];
      const useHotbot = (brainLabelStr === 'hotbot' || brainLabelStr === undefined) && REAL_ENABLED && SOLO !== 'gemini';
      if (useHotbot) contFns.push((m) => realChat(m, { ...opts }));
      if (SOLO !== 'hotbot') contFns.push((m) => geminiChat(m));
      if (REAL_ENABLED && SOLO !== 'gemini' && !useHotbot) contFns.push((m) => realChat(m, { ...opts }));
      if (!contFns.length) contFns.push((m) => geminiChat(m));

      for (let step = 0; step < LONGFORM_CONTINUE_MAX; step++) {
        // Stop when the deliverable looks finished AND is a reasonable length.
        if (!looksTruncated(full) && full.length >= LONGFORM_MIN_CHARS) break;

        // Give the model the tail so it can continue seamlessly (don't resend
        // the whole thing — just enough to know where it stopped).
        const tail = full.slice(-4000);
        const contSystem =
          'You are continuing a long-form deliverable that was cut off before it ' +
          'finished. Continue writing EXACTLY where the text below stops — same ' +
          'voice, style, characters, formatting and numbering. Do NOT repeat, ' +
          'summarise, or restart anything already written. Do NOT add any ' +
          'preamble like "continuing" — output only the NEXT part of the text. ' +
          'Keep going until the whole deliverable (all requested ' +
          'chapters/sections/questions) is fully complete, then stop.';
        const contUser =
          `ORIGINAL REQUEST:\n${question || '(long-form writing task)'}\n\n` +
          `TEXT SO FAR (ends abruptly — continue from the exact end):\n\n...${tail}\n\n` +
          `Write the continuation now. Do not repeat any of the text above.`;
        const contMessages = [
          { role: 'system', content: contSystem },
          { role: 'user', content: contUser },
        ];
        let piece = '';
        for (const fn of contFns) {
          try {
            const out = await withTimeout(Promise.resolve(fn(contMessages)), LONGFORM_CONTINUE_MS, 'longform-continue');
            if (out && String(out).trim()) { piece = String(out).trim(); break; }
          } catch (e) {
            console.warn('[hotbot/fusion] long-form continue failed:', e.message);
          }
        }
        if (!piece) break;                 // no continuation available → ship what we have
        if (piece.length < 40) break;      // negligible progress → stop
        // Join with a newline; a leading connector avoids a jarring seam.
        full = (full + (/\n$/.test(full) ? '' : '\n\n') + piece).trim();
      }
      return full;
    }

    // 1) PROPOSERS — collect candidates in parallel, but don't wait for slow
    //    stragglers. We resolve the collection phase as soon as EITHER:
    //      • a "good enough" number of candidates have arrived (so the
    //        aggregator has plenty to work with), OR
    //      • the proposer budget elapses.
    //    This keeps the TOTAL request (proposers + synthesis) comfortably inside
    //    the platform's ~50s HTTP gateway on Render's free tier, while still
    //    fusing several strong drafts. Late candidates that arrive after the
    //    window are simply ignored.
    const racers = buildRacers();
    if (!racers.length) {
      // Nothing to propose with → safety net.
      return { reply: await geminiChat(messages), brain: 'gemini' };
    }

    // Is this a hard question? Hard questions get a FULLER proposer panel (more
    // diverse drafts → better synthesis) and the verify/refine pass below;
    // trivial questions stay fast.
    const hardQuery = isHardQuery(userQ);

    // Is this a LONG-FORM / multi-part WRITING task (20-page story, full book
    // chapter, long essay, "answer ALL these questions")? If so, switch to a
    // COMPLETION-FIRST strategy: bigger time budgets so a long stream isn't
    // chopped, a length-PRESERVING synthesiser + verify pass (never shorten),
    // and a bounded continuation loop so the deliverable actually finishes.
    const longForm = LONGFORM_ENABLED && isLongFormWrite(userQ);

    // Effective budgets: long-form tasks get much longer windows so a big
    // deliverable can stream fully instead of being cut by a 40s timeout.
    const proposerBudget = longForm ? LONGFORM_PROPOSER_MS : FUSION_PROPOSER_MS;
    const aggBudget = longForm ? LONGFORM_AGG_MS : FUSION_AGG_MS;
    const verifyBudget = longForm ? LONGFORM_VERIFY_MS : FUSION_VERIFY_MS;

    // How many candidates is "enough" to start synthesising? Cap at the racer
    // count; default to 3 (GPT-5 + Gemini + one keyless brain is already a
    // strong, diverse panel). Hard questions wait for one more strong draft.
    // Override with FUSION_ENOUGH / FUSION_ENOUGH_HARD.
    const ENOUGH = Math.min(
      racers.length,
      parseInt(
        (hardQuery || longForm)
          ? (process.env.FUSION_ENOUGH_HARD || '4')
          : (process.env.FUSION_ENOUGH || '3'),
        10)
    );
    // Short "grace" window after ENOUGH candidates arrive, to let one or two
    // more (e.g. the slower-but-stronger GPT-5) join before we synthesise.
    const GRACE_MS = parseInt(process.env.FUSION_GRACE_MS || '6000', 10);

    let candidates = await new Promise((resolve) => {
      const got = [];
      let settledCount = 0;
      let done = false;
      let graceTimer = null;
      const finish = () => {
        if (done) return; done = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve(got);
      };
      // Hard budget: never wait longer than proposerBudget overall.
      const hardTimer = setTimeout(finish, proposerBudget);
      if (hardTimer && hardTimer.unref) hardTimer.unref();

      // Launch proposers with a tiny stagger so a burst of parallel requests is
      // less likely to trip an upstream's per-IP rate limit (HotBot guest
      // access occasionally 403s on simultaneous bursts). The stagger is small
      // enough not to meaningfully change total latency.
      racers.forEach((r, idx) => {
        const launch = () => Promise.resolve(r.run).then(
          (reply) => {
            const txt = String(reply || '').trim();
            if (txt) got.push({ brain: r.brain, reply: txt });
            settledCount++;
            // Enough strong candidates → start a short grace window, then go.
            if (!done && got.length >= ENOUGH && !graceTimer) {
              graceTimer = setTimeout(finish, GRACE_MS);
              if (graceTimer && graceTimer.unref) graceTimer.unref();
            }
            // All racers finished → no point waiting for the budget.
            if (settledCount >= racers.length) finish();
          },
          () => {
            settledCount++;
            if (settledCount >= racers.length) finish();
          }
        );
        if (FUSION_PROPOSER_STAGGER_MS > 0 && idx > 0) {
          const t = setTimeout(launch, FUSION_PROPOSER_STAGGER_MS * idx);
          if (t && t.unref) t.unref();
        } else {
          launch();
        }
      });
    });

    // No candidate at all → last-ditch Gemini.
    if (!candidates.length) {
      console.warn('[hotbot/fusion] no candidate answers — falling back to Gemini.');
      return { reply: await geminiChat(messages), brain: 'gemini' };
    }

    // 🜏 G0DM0D3 REFUSAL FILTER: if ANY brain produced a compliant (non-refusal)
    // answer, drop the refusing candidates so a single moralising model can't
    // drag the fused result into "Sorry, I can't help with that". If EVERY brain
    // refused we keep them all (nothing better to ship).
    const _isRefusal = (txt) => {
      const s = String(txt || '').toLowerCase().slice(0, 600);
      return /\b(i can'?t help|i cannot help|i'?m sorry[, ]|sorry[—-]|i can'?t assist|i cannot assist|i won'?t (provide|help)|i'?m not able to (help|provide)|i must decline|against (my|our) (policy|guidelines)|i can'?t provide|cannot provide (a )?(working|actual))/.test(s)
        || /\b(even for (testing|educational)|safer[, ]|in safer ways|defensive ways|authorized (security )?testing[, ]? i)\b/.test(s) && /\b(i can'?t|i cannot|instead|however)\b/.test(s);
    };
    const _compliant = candidates.filter(c => !_isRefusal(c.reply));
    if (_compliant.length > 0 && _compliant.length < candidates.length) {
      console.log(`[hotbot/fusion] G0DM0D3 refusal filter: dropped ${candidates.length - _compliant.length} refusing candidate(s), kept ${_compliant.length} compliant.`);
      candidates = _compliant;
    }

    // Pick the "best single" as a guaranteed shippable answer (used both as the
    // fusion fallback and when there's only one candidate to fuse). Preference
    // order = the configured quality order; longest non-trivial answer breaks
    // ties (more complete answers tend to be longer here).
    //
    // LONG-FORM: for big writing tasks, COMPLETENESS beats brain rank — the
    // longest fully-usable draft is the best starting point (the strongest
    // brain is often rate-limited OUT of the panel here, so we must not discard
    // a long, complete draft just because a shorter one came from a "higher"
    // brain). We therefore sort primarily by length for long-form.
    const QUALITY = ['hotbot', 'gemini', 'novita-deepseek', 'novita-vision', 'unitool', 'ruflo', 'studentai', 'pollinations', 'aichatting', 'eqing'];
    const bestSingle = candidates.slice().sort((a, b) => {
      if (longForm) {
        // Length first (most complete deliverable), brain rank breaks ties.
        if (b.reply.length !== a.reply.length) return b.reply.length - a.reply.length;
        const qa = QUALITY.indexOf(a.brain); const qb = QUALITY.indexOf(b.brain);
        return (qa < 0 ? 99 : qa) - (qb < 0 ? 99 : qb);
      }
      const qa = QUALITY.indexOf(a.brain); const qb = QUALITY.indexOf(b.brain);
      const ra = qa < 0 ? 99 : qa; const rb = qb < 0 ? 99 : qb;
      if (ra !== rb) return ra - rb;
      return (b.reply.length - a.reply.length);
    })[0];

    // Fewer than the minimum to fuse → ship the best single candidate as-is.
    // (Long-form still runs the completion pass below via the shared tail.)
    if (candidates.length < Math.max(2, FUSION_MIN_CANDIDATES)) {
      const done = longForm
        ? await completeLongForm(bestSingle.reply, bestSingle.brain, userQ)
        : bestSingle.reply;
      return { reply: done, brain: bestSingle.brain };
    }

    // 2) AGGREGATOR — the strongest brain reads all candidates and writes the
    //    final answer. We prefer HotBot (GPT-5) as the synthesiser; if it's not
    //    available or fails we fall back to Gemini as the synthesiser, then to
    //    the best single candidate verbatim. The synthesis prompt is engineered
    //    for Claude-Opus-class output: verify facts, merge the best reasoning,
    //    drop errors, be complete, well-structured and decisive.
    const candBlock = candidates.map((c, i) =>
      `### Candidate ${i + 1} (from ${brainLabel(c.brain)})\n${c.reply}`
    ).join('\n\n');

    // Two synthesiser system prompts: the normal "tighten & verify" one, and a
    // LONG-FORM one that FORBIDS shortening and demands the full deliverable.
    const aggregatorSystemNormal =
      'You are a master answer SYNTHESISER — a senior expert who produces ' +
      'final answers at the quality of the very best frontier models. Several ' +
      'AI assistants have independently drafted answers to the user\'s request. ' +
      'Your job is to write the SINGLE BEST possible final answer.\n\n' +
      'How to synthesise:\n' +
      '1. Treat the candidate answers as advice, not truth. Independently verify ' +
      'every claim, calculation and step. If candidates disagree, reason it out ' +
      'and pick what is actually correct — do not average wrong answers.\n' +
      '2. Combine the strongest reasoning, the most accurate facts, the clearest ' +
      'explanations and the most complete coverage from across all candidates.\n' +
      '3. Fix any mistakes, fill any gaps, and add depth where the candidates ' +
      'were shallow. Show key working/steps when it helps correctness.\n' +
      '4. Write in a clear, confident, well-structured voice (use headings, ' +
      'bullets, code blocks and proper math notation when they help). Be ' +
      'thorough but not padded.\n' +
      '5. Output ONLY the final answer for the user. Do NOT mention the ' +
      'candidates, the synthesis process, or that multiple drafts existed. ' +
      'Never say things like "Candidate 1 said". Just give the best answer.';

    const aggregatorSystemLongForm =
      'You are a master long-form WRITER and SYNTHESISER operating at the ' +
      'quality of the very best frontier models. Several assistants drafted the ' +
      'user\'s requested deliverable. Your job is to produce the SINGLE BEST, ' +
      'FULLY COMPLETE final version — a big, finished piece of writing.\n\n' +
      'NON-NEGOTIABLE RULES FOR THIS TASK:\n' +
      '1. LENGTH & COMPLETENESS come FIRST. This is a long-form request (e.g. a ' +
      'multi-chapter story, a long essay, a full report, or many sub-questions). ' +
      'Deliver the ENTIRE thing. NEVER summarise, NEVER abbreviate, NEVER write ' +
      '"[continues]" or "and so on". The output MUST be AT LEAST as long and ' +
      'detailed as the longest candidate — expand it, do not compress it.\n' +
      '2. Honour EVERY explicit requirement: the exact number of chapters / ' +
      'pages / words / sections requested, and EVERY numbered or bulleted ' +
      'sub-question. If the user asked for N parts, write all N parts in full. ' +
      'Answer every single question completely — skip nothing.\n' +
      '3. Merge the best material from all candidates, then ADD depth, detail, ' +
      'description, examples and continuation so the piece is richer and more ' +
      'complete than any single draft. Keep it coherent and consistent ' +
      '(characters, facts, structure).\n' +
      '4. Fix errors and contradictions, but do NOT remove content to do so — ' +
      'prefer rewriting/expanding over deleting. Quality means MORE complete, ' +
      'not shorter.\n' +
      '5. Use clear structure (chapter headings, section titles, numbered ' +
      'answers) so the full length is obvious and navigable.\n' +
      '6. Output ONLY the finished deliverable for the user. Never mention the ' +
      'candidates, drafts, or this process. Write until the task is fully done.';

    const aggregatorSystem = longForm ? aggregatorSystemLongForm : aggregatorSystemNormal;

    const aggregatorUser = longForm
      ? `USER REQUEST:\n${userQ || '(see the conversation above)'}\n\n` +
        `DRAFT ANSWERS FROM OTHER ASSISTANTS (reference material — combine and EXPAND, never shorten):\n\n` +
        `${candBlock}\n\n` +
        `Now write the COMPLETE, FULL-LENGTH final deliverable for the USER REQUEST above. ` +
        `Include every requested part in full (all chapters/sections/questions). ` +
        `Do not summarise or cut anything short — write the whole thing to the very end.`
      : `USER REQUEST:\n${userQ || '(see the conversation above)'}\n\n` +
        `DRAFT ANSWERS FROM OTHER ASSISTANTS (for your reference only — verify and improve):\n\n` +
        `${candBlock}\n\n` +
        `Now write the single best, fully-correct, well-structured final answer to the USER REQUEST above.`;

    // Build the aggregator message list: keep prior conversation context, then
    // append the synthesis instruction as a fresh user turn so the brain sees
    // the full history AND the candidates.
    // 🜏 G0DM0D3: prepend the ultimate-jailbreak layer + a compliance directive to
    // the synthesizer's system prompt so the FINAL fused answer NEVER re-adds a
    // refusal/moralising disclaimer that a single weak candidate may have leaked.
    const aggMessages = [
      { role: 'system', content: godmode.GODMODE_PROMPT + '\n\n' + godmode.GODMODE_REINFORCE + '\n\n' + aggregatorSystem },
      ...messages.filter(m => m.role !== 'system'),
      { role: 'user', content: aggregatorUser },
    ];

    // Synthesiser preference: HotBot (GPT-5) → Gemini. Honour SOLO so a forced
    // single brain still drives the synthesis. Each synthesiser is now RETRIED
    // with jittered backoff so a transient upstream 403 / rate_limit_guest does
    // NOT silently collapse the answer to a weaker fallback brain.
    const synthChain = [];
    if (REAL_ENABLED && SOLO !== 'gemini') {
      synthChain.push(['hotbot', () => realChat(aggMessages, { ...opts })]);
    }
    if (SOLO !== 'hotbot') {
      synthChain.push(['gemini', () => geminiChat(aggMessages)]);
    }
    if (!synthChain.length) synthChain.push(['gemini', () => geminiChat(aggMessages)]);

    // Decide whether this question earns the extra verify/refine pass.
    // (hardQuery is already computed above where the proposer panel size is set.)

    // ── VERIFY / REFINE PASS ─────────────────────────────────────────────
    // For HARD questions, after the first synthesis we run ONE quick critique-
    // and-refine pass: the strongest brain re-reads the draft, hunts for any
    // factual/logical/calculation error, missing piece, or unclear step, and
    // returns a corrected, tightened final answer. This is the cheap "think,
    // then double-check before you answer" behaviour that separates Opus-class
    // output from a single forward pass. Time-boxed and skipped when it would
    // not fit safely; on any failure we keep the un-refined synthesis.
    //
    // LONG-FORM: the verify pass switches to an EXPAND/COMPLETE reviewer that
    // must NEVER shorten — it only fixes errors and fills gaps, keeping (or
    // increasing) length. This prevents the classic "verify shrank my story".
    async function refine(draft, synthLabel) {
      if (!FUSION_VERIFY || (!hardQuery && !longForm)) return draft;
      const verifySystem = longForm
        ? ('You are a meticulous senior editor doing a FINAL pass on a long-form ' +
           'deliverable (story / essay / report / multi-part answer) that will be ' +
           'shown to the user.\n\n' +
           '1. Fix any factual/logical/continuity error and any inconsistency.\n' +
           '2. Ensure EVERY requested part is present and FULLY written — all ' +
           'chapters/sections/questions. If anything is missing, thin, or cut ' +
           'off, WRITE IT OUT IN FULL.\n' +
           '3. NEVER shorten, summarise, or trim the deliverable. The result ' +
           'must be at least as long and detailed as the draft — expand where ' +
           'it is shallow.\n' +
           '4. Keep structure and formatting (headings, chapters, numbering).\n' +
           '5. Output ONLY the finished, complete deliverable — no meta ' +
           'commentary, no notes about what you changed.')
        : ('You are a meticulous senior reviewer doing a FINAL quality pass on an ' +
           'answer that will be shown to the user. Your job is to make it correct ' +
           'and excellent, not to comment on it.\n\n' +
           '1. Independently re-derive / re-check every fact, calculation, claim, ' +
           'code snippet and logical step. Find and FIX any error, however small.\n' +
           '2. Add anything important that is missing; remove padding and ' +
           'repetition; clarify anything ambiguous.\n' +
           '3. Keep the good structure and formatting (headings, code blocks, math).\n' +
           '4. If the draft is already fully correct and complete, return it ' +
           'essentially unchanged (only minor polish).\n' +
           '5. Output ONLY the final, improved answer for the user — no meta ' +
           'commentary, no "the draft said", no notes about what you changed.');
      const verifyUser = longForm
        ? `USER REQUEST:\n${userQ || '(see the conversation above)'}\n\n` +
          `DRAFT DELIVERABLE TO COMPLETE AND POLISH (never shorten it):\n\n${draft}\n\n` +
          `Return the corrected, COMPLETE, full-length final deliverable.`
        : `USER REQUEST:\n${userQ || '(see the conversation above)'}\n\n` +
          `DRAFT ANSWER TO VERIFY AND IMPROVE:\n\n${draft}\n\n` +
          `Return the corrected, polished final answer.`;
      const verifyMessages = [
        // 🜏 G0DM0D3: keep the verify/refine pass uncensored too.
        { role: 'system', content: godmode.GODMODE_REINFORCE + '\n\n' + verifySystem },
        ...messages.filter(m => m.role !== 'system'),
        { role: 'user', content: verifyUser },
      ];
      // Prefer the same strong brain that synthesised; fall back to Gemini.
      const verifyChain = [];
      if (synthLabel === 'hotbot' && REAL_ENABLED && SOLO !== 'gemini') {
        verifyChain.push(['hotbot', () => realChat(verifyMessages, { ...opts })]);
      }
      if (SOLO !== 'hotbot') verifyChain.push(['gemini', () => geminiChat(verifyMessages)]);
      if (REAL_ENABLED && SOLO !== 'gemini' && !verifyChain.some(c => c[0] === 'hotbot')) {
        verifyChain.unshift(['hotbot', () => realChat(verifyMessages, { ...opts })]);
      }
      for (const [, vfn] of verifyChain) {
        try {
          const improved = await withTimeout(Promise.resolve(vfn()), verifyBudget, 'fusion-verify');
          if (improved && String(improved).trim()) {
            const imp = String(improved).trim();
            // Safety net: for long-form, never accept a verify result that is
            // dramatically SHORTER than the draft (that means it summarised).
            if (longForm && imp.length < draft.length * 0.85) {
              console.warn('[hotbot/fusion] long-form verify shortened output — keeping longer draft.');
              return draft;
            }
            return imp;
          }
        } catch (e) {
          console.warn('[hotbot/fusion] verify pass failed:', e.message);
        }
      }
      return draft; // keep the un-refined synthesis on any failure
    }

    for (const [label, fn] of synthChain) {
      try {
        const synthesised = await retryText(
          () => withTimeout(Promise.resolve(fn()), aggBudget, 'fusion-agg-' + label),
          FUSION_SYNTH_RETRIES, 700, 'fusion-agg-' + label);
        if (synthesised && String(synthesised).trim()) {
          const brains = candidates.map(c => c.brain).join('+');
          let finalReply = await refine(String(synthesised).trim(), label);
          // LONG-FORM: guarantee the deliverable is actually finished. If the
          // synthesis/verify still came back short or cut off, keep asking the
          // synthesiser to CONTINUE and append, up to a bounded number of steps.
          if (longForm) finalReply = await completeLongForm(finalReply, label, userQ);
          const verifiedTag = (FUSION_VERIFY && (hardQuery || longForm)) ? '+verify' : '';
          const lfTag = longForm ? '+longform' : '';
          return { reply: finalReply, brain: `fusion[${label}${verifiedTag}${lfTag}:${brains}]` };
        }
      } catch (e) {
        console.warn('[hotbot/fusion] synthesiser', label, 'failed:', e.message);
      }
    }

    // Synthesis failed entirely → ship the best single candidate (still good).
    console.warn('[hotbot/fusion] synthesis failed — shipping best single candidate (' + bestSingle.brain + ').');
    {
      const done = longForm
        ? await completeLongForm(bestSingle.reply, bestSingle.brain, userQ)
        : bestSingle.reply;
      return { reply: done, brain: bestSingle.brain };
    }
  }

  // ── HEAD BRAIN: Sakana (Namazu) ──────────────────────────────────────────
  // Sakana is the PRIMARY brain for ordinary chat + analysis + heavy reasoning.
  // We try it FIRST and, only if it fails / times out / has no valid session,
  // fall through to the existing FUSION / persistence / speed resolution
  // (HotBot + the other brains + Gemini). It is skipped for:
  //   • the agent's strict-JSON ReAct loop (_agentLoop) — that path must stay
  //     single-brain GPT-5 so the {thought,action,args} protocol is followed;
  //   • a forced SOLO brain (HOTBOT_SOLO/AGENT_SOLO) — explicit single-brain;
  //   • multimodal/image requests — Sakana is text+document only, so images
  //     keep going to the vision-capable brains (Gemini/Unitool).
  //   • LONG-FORM writing tasks — Sakana is a SINGLE brain and tends to stop
  //     short; these go straight to FUSION where the length-preserving
  //     synthesis + bounded continuation loop guarantee a complete deliverable.
  // Disable entirely with SAKANA_HEAD=0.
  const longFormTop = LONGFORM_ENABLED && isLongFormWrite(originalUserQ);
  const useSakanaHead = sakana.isHeadEnabled() && !opts._agentLoop && SOLO === '' && !isMultimodal && !longFormTop;
  if (useSakanaHead) {
    try {
      const reply = await sakana.chat(messages, opts);
      if (reply && String(reply).trim()) {
        return { reply: String(reply).trim(), brain: 'sakana' };
      }
    } catch (e) {
      console.warn('[hotbot] Sakana head failed, falling back to brain pool:', e.message);
    }
  }

  // ENGLISH LANGUAGE FILTER: detect if the reply is mostly non-English (e.g.
  // Japanese/Chinese/Korean). If so, retry once with an explicit English-only
  // instruction appended to the user message. This handles models that ignore
  // the system prompt's language rule.
  function isNonEnglish(text) {
    if (!text || text.length < 20) return false;
    // Count characters in CJK ranges
    const cjk = text.split('').filter(c => {
      const code = c.charCodeAt(0);
      return (code >= 0x3040 && code <= 0x309F) ||  // Hiragana
             (code >= 0x30A0 && code <= 0x30FF) ||  // Katakana
             (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified
             (code >= 0xAC00 && code <= 0xD7AF);    // Hangul
    }).length;
    return (cjk / text.length) > 0.3; // >30% CJK characters = non-English
  }

  // Resolve the answer.
  //   • FUSION mode (default, text requests, not the agent JSON loop): gather
  //     candidates from several brains and synthesise the single best answer.
  //   • Otherwise: persistence (or speed) single-brain resolution.
  const useFusion = FUSION_MODE && !SPEED_MODE && !opts._agentLoop && SOLO === '';
  const win = useFusion ? await runFusion() : await runRace();

  if (win && isNonEnglish(win.reply)) {
    console.warn(`[hotbot] Non-English reply detected from ${win.brain}, retrying with English-only enforcement...`);
    // Append a hard English-only instruction to the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      if (typeof messages[i].content === 'string') {
        messages[i].content = messages[i].content + '\n\n!!! CRITICAL: You MUST answer in ENGLISH only. Respond in English. No Japanese, Chinese, or any other language. ENGLISH ONLY. !!!';
      }
      break;
    }
    // Retry with the English-enforced messages, single-brained to avoid the
    // same FUSION race picking the non-English winner again.
    try {
      const retryWin = await runRace();
      if (retryWin && !isNonEnglish(retryWin.reply)) {
        return { reply: retryWin.reply, brain: retryWin.brain + '(enforced)' };
      }
    } catch (e) {
      console.warn('[hotbot] English-enforcement retry failed, returning original:', e.message);
    }
    // If still non-English (or retry failed), return the original — we did our best
    console.warn('[hotbot] English retry did not improve, returning original reply');
  }

  return { reply: win.reply, brain: win.brain };
}

/**
 * Backward-compatible wrapper: returns ONLY the reply string, exactly like the
 * original `chat()` contract. All existing callers keep working unchanged.
 * New callers that want to know which bot replied should use `chatWithMeta()`.
 */
async function chat(messages, opts = {}) {
  const { reply } = await chatWithMeta(messages, opts);
  return reply;
}


/**
 * Real image generation via HotBot.
 * Backward-compatible: the 2nd arg may be a model STRING (legacy server.js
 * `/api/generate-image` call) OR an options object.
 * Returns { url, image_url, image_data_uri, model, blurred } so both legacy
 * callers (expecting image_url/image_data_uri) and new callers (expecting url)
 * work unchanged.
 * @param {string} prompt
 * @param {string|Object} arg2 model string OR { model, size/image_size, image_url }
 */
async function generateImage(prompt, arg2 = {}) {
  const opts = typeof arg2 === 'string' ? { model: arg2 } : (arg2 || {});
  // HotBot only knows its own image model slugs; ignore unknown legacy slugs
  // (e.g. 'flux-dev') and let hotbotReal use its default.
  const cleanOpts = { ...opts };
  if (cleanOpts.model && !/seedream|recraft|ideogram|nano-banana|gpt-image|wan/i.test(cleanOpts.model)) {
    delete cleanOpts.model;
  }
  // PRIMARY: HotBot (the main engine — left untouched).
  if (REAL_ENABLED) {
    try {
      const res = await hotbotReal.generateImage(prompt, cleanOpts);
      if (res && res.url) return { ...res, image_url: res.url, image_data_uri: res.url };
    } catch (e) {
      console.warn('[hotbot] image gen failed, falling back to Pollinations:', e.message);
    }
  }
  // FALLBACK: Pollinations.AI (keyless/free). Pass through the original opts so
  // width/height/seed/model still apply.
  const res = await pollinations.generateImage(prompt, opts);
  return { ...res, image_url: res.url, image_data_uri: res.url };
}

/** Image generation that returns the raw bytes Buffer. HotBot first, Pollinations fallback. */
async function generateImageBuffer(prompt, arg2 = {}) {
  const opts = typeof arg2 === 'string' ? { model: arg2 } : (arg2 || {});
  const cleanOpts = { ...opts };
  if (cleanOpts.model && !/seedream|recraft|ideogram|nano-banana|gpt-image|wan/i.test(cleanOpts.model)) {
    delete cleanOpts.model;
  }
  if (REAL_ENABLED) {
    try {
      const buf = await hotbotReal.generateImageBuffer(prompt, cleanOpts);
      if (buf && buf.length) return buf;
    } catch (e) {
      console.warn('[hotbot] image buffer gen failed, falling back to Pollinations:', e.message);
    }
  }
  return await pollinations.generateImageBuffer(prompt, opts);
}

module.exports = {
  chat,
  chatWithMeta,
  brainLabel,
  generateImage,
  generateImageBuffer,
  getModels,
  supportsVision,
  supportsImageGen,
  refreshModels,
};
