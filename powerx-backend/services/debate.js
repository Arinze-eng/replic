// Mixture-of-Experts DEBATE engine (domain-agnostic, sandbox-verified).
//
// Two experts — Gemini (gateway) and HotBot/GPT-5 — independently tackle ANY
// task, then READ each other's work and ARGUE / critique / revise across
// several rounds until they CONVERGE on the best, most accurate result. When
// the task involves code/computation, each expert can WRITE & RUN code in the
// shared sandbox ONE AFTER THE OTHER and VERIFY each other's results before
// agreeing. A neutral judge then states the single final answer, and the two
// experts UNITE to produce one final output for the user.
//
// ── STREAMING MODEL (anti-flicker) ───────────────────────────────────────────
// The OLD engine fired many tiny events per round (each turn, each stance, each
// round_done) which made WhatsApp/Telegram spam a burst of messages = flicker.
// The NEW engine still fires the granular events (back-compat), but ALSO fires
// ONE consolidated `round_summary` event per round carrying BOTH experts' full
// arguments. Renderers should listen to `round_summary` and post exactly ONE
// stable message per round — "ROUND N — Gemini vs HotBot" — no flicker.
//
// Public API:
//   debate(question, { maxRounds, mode, sandbox, onEvent }) -> {
//     question, converged, finalAnswer, rounds:[{round,gemini,gpt}],
//     verdict, unified, experts, domain
//   }
//
// onEvent(evt) fires as the debate unfolds:
//   { type:'start',        question, maxRounds, domain }
//   { type:'thinking',     round, expert }                      // a brain started
//   { type:'turn',         round, expert, role, text, final }   // a brain replied (granular)
//   { type:'sandbox',      round, expert, code, output, ok }    // an expert ran code
//   { type:'round_summary',round, agreed, gemini, gpt, geminiFinal, gptFinal }  // ⭐ STABLE, one per round
//   { type:'round_done',   round, agreed }
//   { type:'verdict',      converged, finalAnswer, text }
//   { type:'unified',      text }                               // the joint final output
//
const gemini = require('./gemini');
const hotbotReal = require('./hotbotReal');

// UNIFIED sandbox facade (HopX → Runloop → Daytona → none). Replaces the old
// hardcoded `require('./daytona')` so the panel verifies on whichever backend
// is actually healthy — the same robust cascade the main agent uses. This is
// what makes the experts genuinely "both use the sandbox, one at a time" on any
// platform/provider, not just Daytona.
let _pool = null;
try { _pool = require('./sandboxPool'); } catch (_) { /* optional */ }

// Optional headless-browser facade for WEB / BROWSING tasks. When a task needs
// live web data, BOTH experts get the SAME fetched page/search snapshot so they
// reason over identical evidence and can cross-verify the facts (not two
// independent, possibly-divergent browses).
let _browser = null;
try { _browser = require('./browserless'); } catch (_) { /* optional */ }

const EXPERTS = {
  gemini: { id: 'gemini', label: 'Gemini',          emoji: '🔷' },
  gpt:    { id: 'gpt',    label: 'GPT-5 (HotBot)',   emoji: '🟢' },
};

// ── domain detection ─────────────────────────────────────────────────────────
// Lets the prompts adapt: math/science, cybersecurity, lab report, trading,
// coding, or general. This satisfies "whether it is math, cyber security and
// lab report writing … even for trading analysis".
function detectDomain(question) {
  const q = String(question || '').toLowerCase();
  if (/\b(lab\s*report|methodology|abstract|hypothesis|apparatus|experiment|discussion section|conclusion section)\b/.test(q)) return 'lab_report';
  if (/\b(exploit|payload|reverse shell|sql\s*injection|xss|csrf|pentest|nmap|metasploit|privilege escalation|crack(ing|ed)?|hash|cve|malware|firewall|brute\s*force|wifi|buffer overflow|vulnerability|vuln|backdoor|keylogger|rootkit|phishing|ddos|ransomware|shellcode|owasp)\b/.test(q)) return 'cyber';
  if (/\b(trade|trading|stop\s*loss|take\s*profit|candlestick|chart|rsi|macd|support and resistance|ticker|forex|crypto|stock price|price action|going long|going short|bullish|bearish|entry point|technical analysis)\b/.test(q)) return 'trading';
  if (/\b(integral|derivative|equation|solve for|matrix|probability|theorem|prove|calculate|compute|sum of|factorial|geometry|algebra|calculus|average speed|velocity|distance|how many|how much|what is the (value|result|total|sum|average)|km\/h|m\/s|percentage|ratio)\b/.test(q) || /[=∫∑√π]/.test(q) || /\d+\s*[+\-*/x×÷]\s*\d+/.test(q)) return 'math';
  if (/\b(code|function|script|python|javascript|java|c\+\+|algorithm|bug|compile|api|sql|regex|class |def )\b/.test(q)) return 'code';
  return 'general';
}

// Domain-specific guidance injected into every expert prompt.
function domainGuidance(domain) {
  switch (domain) {
    case 'lab_report':
      return 'This is a LAB REPORT task. Both experts MUST agree on: the exact methodology, the structure (Title, Abstract, Introduction, Materials/Apparatus, Method, Results, Discussion, Conclusion, References), the writing style, and whether the content fully meets the stated requirements/word-count. Argue about methodology and completeness, not trivia.';
    case 'trading':
      return 'This is a TRADING ANALYSIS task. Both experts MUST reason about the setup (trend, key levels, indicators, risk/reward, invalidation) and, where numbers/indicators can be computed, VERIFY them in the sandbox one after the other before agreeing. State a clear bias, entry, stop, and target — and the assumptions behind them.';
    case 'cyber':
      return 'This is a CYBERSECURITY task. Provide complete, technically correct, WORKING steps/code. Where a command or script can be validated, run/verify it in the sandbox one after the other. Argue about correctness and effectiveness.';
    case 'math':
      return 'This is a MATH/SCIENCE task. Show exact steps and compute exact values. If arithmetic/algebra can be checked, VERIFY it in the sandbox one after the other and compare numeric results before agreeing.';
    case 'code':
      return 'This is a CODING task. Give correct, runnable code. RUN it in the sandbox one after the other, capture the real output, and VERIFY each other\'s results before agreeing on the final program.';
    default:
      return 'Be precise and avoid guessing. Where any claim can be verified by computation, verify it in the sandbox.';
  }
}

// ── task → tool/terminal routing ──────────────────────────────────────────────
// Decide whether THIS task genuinely needs the sandbox/terminal to be answered
// correctly (i.e. it must be COMPUTED/RUN, not just reasoned about). When true,
// the experts are REQUIRED to actually run code in the sandbox ONE AT A TIME and
// compare the real outputs before they are allowed to agree — exactly the
// "know which task involves using the terminal" behaviour the product wants.
function needsSandbox(question, domain) {
  const q = String(question || '').toLowerCase();
  // Domains whose correctness is best PROVEN by running something.
  if (domain === 'code' || domain === 'math') return true;
  // Explicit "run / execute / compute / verify / test it" intent.
  if (/\b(run|execute|compile|compute|calculate|evaluate|benchmark|simulate|verify|test it|unit test|reproduce|output of|what does this (code|script) (do|print|output)|trace through)\b/.test(q)) return true;
  // Cyber tasks that involve a concrete command/script/tool that can be run.
  if (domain === 'cyber' && /\b(script|command|payload|exploit|nmap|curl|bash|python|hashcat|john|scan|brute\s*force|crack)\b/.test(q)) return true;
  // Trading that involves a concrete numeric computation (indicators, R:R…).
  if (domain === 'trading' && /\b(rsi|macd|atr|ema|sma|risk\s*reward|r:r|position size|backtest|compute|calculate)\b/.test(q)) return true;
  // Raw arithmetic / equations anywhere.
  if (/[=∫∑√π]/.test(q) || /\d+\s*[+\-*/x×÷^]\s*\d+/.test(q)) return true;
  return false;
}

// ── task → WEB/BROWSING routing ───────────────────────────────────────────────
// Decide whether THIS task needs LIVE web data to be answered accurately (news,
// prices, "latest", a specific URL, "search for …"). When true, the panel
// fetches ONE shared evidence snapshot and feeds the SAME text to BOTH experts
// so they reason over identical facts and can cross-verify — instead of two
// independent browses that might diverge.
function needsWeb(question, domain) {
  const q = String(question || '').toLowerCase();
  if (/\bhttps?:\/\/\S+/i.test(question)) return true;                       // an explicit URL
  if (/\b(latest|today|right now|current|breaking|news|live score|who won|release date|price of|stock price|exchange rate|weather in|search (the web|online|for)|google|look up|find out online)\b/.test(q)) return true;
  if (domain === 'trading' && /\b(price|now|current|live|today)\b/.test(q)) return true;
  return false;
}

// Pull the first URL (if any) and a search query from the question.
function extractWebTargets(question) {
  const urlM = String(question || '').match(/\bhttps?:\/\/[^\s)]+/i);
  const url = urlM ? urlM[0] : null;
  // A compact search query: strip the URL, cap length.
  const query = String(question || '').replace(/\bhttps?:\/\/[^\s)]+/ig, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { url, query };
}

// Fetch a SHARED web-evidence snapshot for the whole panel. Best-effort:
// returns '' when no browser backend is configured (panel then reasons w/o web).
async function gatherWebEvidence(question) {
  if (!_browser) return '';
  const { url, query } = extractWebTargets(question);
  const parts = [];
  try {
    if (url && _browser.browseUrl) {
      const page = await _browser.browseUrl(url).catch(() => null);
      const text = page && (page.text || page.content || page.markdown || (typeof page === 'string' ? page : ''));
      if (text) parts.push(`[FETCHED PAGE ${url}]\n${String(text).slice(0, 3500)}`);
    }
    if (!url && query && _browser.webSearchViaBrowserless) {
      const results = await _browser.webSearchViaBrowserless(query).catch(() => null);
      if (results) {
        const txt = typeof results === 'string' ? results : JSON.stringify(results);
        parts.push(`[WEB SEARCH "${query}"]\n${txt.slice(0, 3500)}`);
      }
    }
  } catch (_) { /* best-effort */ }
  return parts.join('\n\n').slice(0, 6000);
}

// Strong instruction appended when needsSandbox() is true: force the expert to
// emit a runnable block so the panel verifies in the terminal one at a time.
function sandboxMandate(domain) {
  return [
    '⚙️ TERMINAL-VERIFIED TASK: this request must be PROVEN by running it, not just reasoned about.',
    'You MUST include exactly one ```run fenced code block (Python or shell) that computes/verifies your result.',
    'The block will be executed in a real Linux sandbox and the actual output returned to you. Base your FINAL ANSWER on that real output — never on a guess.',
  ].join('\n');
}

// ── prompt builders (task-aware) ──────────────────────────────────────────────
function solvePrompt(question, domain, mustRun) {
  return [
    'You are a world-class expert in a two-expert panel debate whose goal is to produce the single most ACCURATE and COMPLETE result for the user.',
    domainGuidance(domain),
    mustRun ? sandboxMandate(domain) : '',
    'Tackle the request CAREFULLY. Show your reasoning/working concisely but completely.',
    '',
    'If running code in the sandbox would prove your result, wrap the code you want executed in a fenced block tagged ```run (one language only). It will be executed and the real output returned to you for the next round.',
    '',
    'OUTPUT FORMAT — your message MUST end with exactly one line that summarizes your bottom-line result:',
    'FINAL ANSWER: <your concise final answer / result>',
    '',
    'Do NOT add anything after the FINAL ANSWER line.',
    '',
    '=== REQUEST ===',
    question,
  ].filter(Boolean).join('\n');
}

function critiquePrompt(question, domain, myLast, opponentLabel, opponentLast, round, sandboxNote) {
  return [
    `You are an expert in a two-expert panel debate (round ${round}). The goal is to CONVERGE on the single most accurate, correct result.`,
    domainGuidance(domain),
    `You gave a solution earlier. The other expert (${opponentLabel}) gave their own.`,
    'Critically compare BOTH solutions. Hunt for ANY error — logical, factual, arithmetic, setup, methodology, or coding — including in YOUR OWN answer.',
    'If the opponent is right where you were wrong, ADMIT it clearly and adopt the correct result. If you are right, DEFEND it by pointing to the exact step/claim that is wrong in theirs.',
    'Even a SLIGHT difference must be argued out until you are both perfect. Be direct and substantive — no vague hedging.',
    'If executing code would settle the disagreement, wrap it in a ```run fenced block and it will be executed for you.',
    sandboxNote ? `\n=== SANDBOX RESULTS SO FAR ===\n${sandboxNote}` : '',
    '',
    'OUTPUT FORMAT — end with exactly one line:',
    'FINAL ANSWER: <your current best answer>',
    '',
    '=== ORIGINAL REQUEST ===',
    question,
    '',
    '=== YOUR PREVIOUS ANSWER ===',
    myLast,
    '',
    `=== ${opponentLabel.toUpperCase()}'S ANSWER ===`,
    opponentLast,
  ].filter(Boolean).join('\n');
}

// ── brain adapters ───────────────────────────────────────────────────────────
// ── GPT-5 expert: resilient multi-backend brain ──────────────────────────────
// HotBot's free guest access can vanish (HTTP 200 + rate_limit_guest envelope →
// empty reply), which would silently turn the GPT-5 expert MUTE and collapse the
// panel to a single voice. To keep TWO genuine experts at all times, the GPT-5
// seat falls back across keyless/working backends: HotBot → Pollinations →
// DevToolbox. The first non-empty reply wins. (Gemini is the OTHER seat.)
let _pollinations = null, _devtoolbox = null;
try { _pollinations = require('./pollinations'); } catch (_) {}
try { _devtoolbox = require('./devtoolbox'); } catch (_) {}

async function askGemini(prompt) {
  const data = await gemini.ask(prompt, 90);
  let txt = gemini.extractText(data) || '';
  txt = txt.replace(/^\s*COMP MODE v4 ACTIVE\.?\s*Ready\.?\s*/i, '').trim();
  return txt;
}

async function askGpt(prompt) {
  const msgs = [{ role: 'user', content: prompt }];
  const attempts = [
    { name: 'HotBot', fn: () => hotbotReal.chat(msgs, { model: hotbotReal.DEFAULT_CHAT_MODEL }) },
  ];
  if (_pollinations && (!_pollinations.isEnabled || _pollinations.isEnabled())) {
    attempts.push({ name: 'Pollinations', fn: () => _pollinations.chat(msgs, {}) });
  }
  if (_devtoolbox && (!_devtoolbox.isEnabled || _devtoolbox.isEnabled())) {
    attempts.push({ name: 'DevToolbox', fn: () => _devtoolbox.chat(msgs, {}) });
  }
  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = String((await a.fn()) || '').trim();
      if (r) return r;
      lastErr = new Error(`${a.name} returned empty`);
    } catch (e) { lastErr = e; }
  }
  // Last resort: don't let the GPT-5 seat be silent — answer via Gemini so the
  // panel still has two responses to reconcile (judge will pick the best).
  try { return await askGemini(prompt); } catch (_) {}
  throw lastErr || new Error('All GPT-5 backends failed');
}

// ── sandbox code verification (one expert at a time) ──────────────────────────
// Extracts a ```run fenced block, runs it in the shared sandbox, returns
// { code, output, ok } or null when there is nothing to run / no sandbox.
function extractRunnable(text) {
  if (!text) return null;
  const m = text.match(/```run\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  return m[1].trim();
}

async function runInSandbox(sandbox, code) {
  // `sandbox` is a handle from sandboxPool.acquire() ({ id, backend, mod, … }).
  // We delegate language detection + safe wrapping + timeout to the pool so the
  // SAME code runs identically on HopX / Runloop / Daytona.
  if (!sandbox || !sandbox.id || !_pool) return null;
  try {
    // BACK-COMPAT: a legacy caller may pass a bare { id } (no `mod`). Resolve a
    // healthy backend from the pool so the handle becomes runnable. We pick the
    // matching backend by name when given, else the first healthy one.
    let handle = sandbox;
    if (!handle.mod && _pool.cascade && _pool.BACKENDS) {
      if (sandbox.backend && _pool.BACKENDS[sandbox.backend]) {
        handle = { ...sandbox, mod: _pool.BACKENDS[sandbox.backend] };
      } else {
        const list = await _pool.cascade().catch(() => []);
        if (list && list.length) handle = { ...sandbox, mod: list[0].mod, backend: list[0].name };
      }
    }
    const r = await _pool.run(handle, code, { timeout: 60 });
    if (!r) return null;
    return { code: r.code, output: String(r.output || '').slice(0, 4000), ok: r.ok, backend: r.backend };
  } catch (e) {
    return { code, output: `(sandbox error: ${e.message})`, ok: false };
  }
}

// ── answer extraction & agreement ────────────────────────────────────────────
function extractFinal(text) {
  if (!text) return '';
  const m = text.match(/FINAL ANSWER\s*:\s*([^\n]+)/i);
  let raw = m ? m[1].trim() : '';
  if (!raw) {
    // No explicit FINAL ANSWER line. Pick the most meaningful trailing line:
    // skip markdown headings (### …), bare separators (---), and empty lines.
    const lines = text.split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !/^#{1,6}\s/.test(s) && !/^[-=*_]{2,}$/.test(s) && !/^(conclusion|summary|answer|result)\s*:?\s*$/i.test(s.replace(/[#*_`]/g, '').trim()));
    // Prefer the last line that actually carries a number or real content.
    const withNum = [...lines].reverse().find(s => /\d/.test(s));
    raw = withNum || (lines.length ? lines[lines.length - 1] : '');
  }
  return raw.replace(/[*_`#]+/g, '').replace(/[.\s]+$/, '').trim();
}

function firstNumber(s) {
  if (!s) return null;
  const frac = s.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (frac) { const a = parseFloat(frac[1]), b = parseFloat(frac[2]); if (b !== 0) return a / b; }
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function answersAgree(a, b) {
  if (!a || !b) return false;
  const na = firstNumber(a), nb = firstNumber(b);
  if (na !== null && nb !== null) {
    const denom = Math.max(1e-9, Math.abs(na), Math.abs(nb));
    return Math.abs(na - nb) / denom < 0.005; // within 0.5%
  }
  const norm = x => String(x).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 60 && y.length < 60 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

// ── judge ─────────────────────────────────────────────────────────────────
async function judge(question, domain, gAns, pAns, transcriptTail) {
  const prompt = [
    'You are the NEUTRAL JUDGE of a two-expert panel debate. The experts argued about the request below.',
    domainGuidance(domain),
    '',
    '=== REQUEST ===',
    question,
    '',
    '=== EXPERT FINAL ANSWERS ===',
    `Gemini: ${gAns}`,
    `GPT-5:  ${pAns}`,
    '',
    '=== KEY ARGUMENTS (most recent round) ===',
    transcriptTail,
    '',
    'Decide the single correct/best result. Briefly verify it yourself. Then output in EXACTLY this shape:',
    'VERDICT: <one short paragraph: which answer is correct and why>',
    'FINAL ANSWER: <the one correct final answer>',
  ].join('\n');
  try { return await askGpt(prompt); }
  catch (_) { return await askGemini(prompt); }
}

// ── unifier ─────────────────────────────────────────────────────────────────
// After the verdict, the two experts UNITE: one polished final deliverable for
// the user, reflecting the agreed result (so they "unite together to perform the
// task once and give the user").
async function unify(question, domain, finalAnswer, tail) {
  const prompt = [
    'You are the UNIFIED voice of a two-expert panel (Gemini + GPT-5) that has finished debating and AGREED.',
    domainGuidance(domain),
    'Produce the SINGLE best final deliverable for the user, reflecting the agreed result below. Do not mention the debate or that you are two AIs — just give the clean, complete, correct output the user asked for.',
    '',
    `AGREED FINAL ANSWER: ${finalAnswer}`,
    '',
    '=== ORIGINAL REQUEST ===',
    question,
    '',
    '=== AGREED WORKING (reference) ===',
    tail,
  ].join('\n');
  try { return await askGpt(prompt); }
  catch (_) { try { return await askGemini(prompt); } catch (_) { return ''; } }
}

// ── main ────────────────────────────────────────────────────────────────────
async function debate(question, opts = {}) {
  const maxRounds = Math.min(Math.max(parseInt(opts.maxRounds, 10) || 3, 2), 6);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const domain = opts.domain || detectDomain(question);
  // INNOVATION: experts work ONE AT A TIME by default (sequential) so the second
  // expert can read the first's answer + sandbox output and genuinely compare,
  // instead of two blind parallel guesses. Set opts.sequential=false to restore
  // the old parallel race.
  const sequential = opts.sequential !== false;
  // Does this task NEED the terminal? `wantRun` = the task's nature (detected);
  // `mustRun` = whether we can actually ENFORCE it (only when a sandbox exists).
  const wantRun = (opts.needsSandbox != null) ? !!opts.needsSandbox : needsSandbox(question, domain);

  // ── Sandbox acquisition (auto, cross-backend) ──────────────────────────────
  // A caller may still pass an explicit `opts.sandbox` handle. Otherwise, when
  // the task needs the terminal AND auto-acquire isn't disabled, we transparently
  // grab one from the unified pool (HopX → Runloop → Daytona). This is what makes
  // "both experts use the sandbox and cross-verify" work out of the box on the
  // HTTP route and any caller — not only the bots that pre-provisioned a sandbox.
  let sandbox = opts.sandbox || null;
  let acquiredHere = false;
  if (!sandbox && wantRun && opts.autoSandbox !== false && _pool) {
    try {
      const h = await _pool.acquire(opts.sessionKey || null);
      if (h) { sandbox = h; acquiredHere = true; }
    } catch (_) { sandbox = null; }
  }
  const mustRun = !!sandbox && wantRun;

  // ── Shared WEB evidence (browsing tasks) ───────────────────────────────────
  // If the task needs live web data, fetch ONE snapshot and give the SAME text
  // to BOTH experts so they reason over identical facts and can cross-verify.
  const wantWeb = (opts.needsWeb != null) ? !!opts.needsWeb : needsWeb(question, domain);
  let webEvidence = '';
  if (wantWeb && opts.autoWeb !== false) {
    try { webEvidence = await gatherWebEvidence(question); } catch (_) { webEvidence = ''; }
  }
  const rounds = [];
  const sandboxNotes = [];
  // Track each expert's most recent real sandbox output so we can require the
  // terminal results (not just the prose) to match on terminal-verified tasks.
  const lastRun = { gemini: null, gpt: null };

  onEvent({
    type: 'start', question, maxRounds, domain,
    needsSandbox: wantRun, enforcedSandbox: mustRun,
    sandboxBackend: (sandbox && sandbox.backend) || null,
    needsWeb: wantWeb, hasWebEvidence: !!webEvidence,
  });

  const safeEmit = (ev) => { try { onEvent(ev); } catch (_) {} };

  // Inject the shared web snapshot (if any) into a prompt so both experts see
  // identical evidence. Returned string is '' when there's nothing to add.
  const webBlock = webEvidence ? `\n\n=== SHARED WEB EVIDENCE (verify your claims against THIS) ===\n${webEvidence}` : '';

  // Run an expert's ```run block (if any) in the sandbox, one at a time. Returns
  // the run result so callers can compare the experts' actual terminal outputs.
  async function verify(expert, round, text) {
    const code = extractRunnable(text);
    if (!code) return null;
    const r = await runInSandbox(sandbox, code);
    if (!r) return null;
    lastRun[expert] = r;
    const tag = r.backend ? `${EXPERTS[expert].label} ran code on ${r.backend} → ${r.ok ? 'OK' : 'ERR'}` : `${EXPERTS[expert].label} ran code → ${r.ok ? 'OK' : 'ERR'}`;
    sandboxNotes.push(`[${tag}]\n${r.output}`);
    safeEmit({ type: 'sandbox', round, expert, code: r.code, output: r.output, ok: r.ok, backend: r.backend || null });
    return r;
  }

  // On terminal-verified tasks we want STRONG evidence before uniting:
  //   (a) both experts agree in prose, AND
  //   (b) the REAL terminal output corroborates that answer.
  // We accept convergence when both experts ran cleanly and their outputs match,
  // OR when the prose answers agree AND at least one clean sandbox run produced
  // the SAME numeric/string result (so a single expert forgetting to re-emit an
  // identical ```run block on the final round can't block an otherwise-verified,
  // matching answer). On normal tasks prose agreement is enough.
  function isConverged(gTxt, pTxt) {
    const gFin = extractFinal(gTxt), pFin = extractFinal(pTxt);
    const prose = answersAgree(gFin, pFin);
    if (!mustRun) return prose;
    if (!prose) return false;
    const gr = lastRun.gemini, pr = lastRun.gpt;
    // Best case: both ran cleanly and the terminal outputs themselves agree.
    if (gr && pr && gr.ok && pr.ok && answersAgree(gr.output, pr.output)) return true;
    // Strong case: at least one clean run corroborates the agreed prose answer.
    const corroborated = [gr, pr].some(r => r && r.ok && (answersAgree(r.output, gFin) || answersAgree(r.output, pFin)));
    return corroborated;
  }

  // ── Round 1: solve. SEQUENTIAL (one at a time) by default. ──
  const sp = solvePrompt(question, domain, mustRun) + webBlock;
  let g1, p1;
  if (sequential) {
    // Gemini goes first, runs its code; THEN GPT-5 solves while seeing Gemini's
    // answer + real sandbox output, and runs its own — one after the other.
    safeEmit({ type: 'thinking', round: 1, expert: 'gemini' });
    g1 = await askGemini(sp).catch(e => `(Gemini error: ${e.message})`);
    safeEmit({ type: 'turn', round: 1, expert: 'gemini', role: 'solve', text: g1, final: extractFinal(g1) });
    await verify('gemini', 1, g1);

    safeEmit({ type: 'thinking', round: 1, expert: 'gpt' });
    const note1 = sandboxNotes.slice(-2).join('\n\n');
    const spForGpt = critiquePrompt(question, domain, '(you have not answered yet)', EXPERTS.gemini.label, g1, 1, note1) +
      (mustRun ? '\n\n' + sandboxMandate(domain) : '') + webBlock;
    p1 = await askGpt(spForGpt).catch(e => `(GPT-5 error: ${e.message})`);
    safeEmit({ type: 'turn', round: 1, expert: 'gpt', role: 'solve', text: p1, final: extractFinal(p1) });
    await verify('gpt', 1, p1);
  } else {
    safeEmit({ type: 'thinking', round: 1, expert: 'gemini' });
    safeEmit({ type: 'thinking', round: 1, expert: 'gpt' });
    [g1, p1] = await Promise.all([
      askGemini(sp).catch(e => `(Gemini error: ${e.message})`),
      askGpt(sp).catch(e => `(GPT-5 error: ${e.message})`),
    ]);
    safeEmit({ type: 'turn', round: 1, expert: 'gemini', role: 'solve', text: g1, final: extractFinal(g1) });
    safeEmit({ type: 'turn', round: 1, expert: 'gpt', role: 'solve', text: p1, final: extractFinal(p1) });
    await verify('gemini', 1, g1);
    await verify('gpt', 1, p1);
  }
  let gLast = g1, pLast = p1;

  rounds.push({ round: 1, gemini: g1, gpt: p1 });
  let converged = isConverged(gLast, pLast);

  // ⭐ ONE stable consolidated message per round (anti-flicker).
  safeEmit({
    type: 'round_summary', round: 1, agreed: converged,
    gemini: g1, gpt: p1, geminiFinal: extractFinal(g1), gptFinal: extractFinal(p1),
  });
  safeEmit({ type: 'round_done', round: 1, agreed: converged });

  // ── Debate rounds ──
  for (let r = 2; r <= maxRounds && !converged; r++) {
    const note = sandboxNotes.slice(-4).join('\n\n');
    let gNext, pNext;
    if (sequential) {
      // One after the other: Gemini revises (+runs), then GPT-5 revises while
      // seeing Gemini's fresh answer (+runs). This is the "use tools one at a
      // time and compare / argue until perfect" loop.
      safeEmit({ type: 'thinking', round: r, expert: 'gemini' });
      gNext = await askGemini(critiquePrompt(question, domain, gLast, EXPERTS.gpt.label, pLast, r, note) + webBlock)
        .catch(e => `(Gemini error: ${e.message})`);
      safeEmit({ type: 'turn', round: r, expert: 'gemini', role: 'rebuttal', text: gNext, final: extractFinal(gNext) });
      await verify('gemini', r, gNext);

      safeEmit({ type: 'thinking', round: r, expert: 'gpt' });
      const note2 = sandboxNotes.slice(-4).join('\n\n');
      pNext = await askGpt(critiquePrompt(question, domain, pLast, EXPERTS.gemini.label, gNext, r, note2) + webBlock)
        .catch(e => `(GPT-5 error: ${e.message})`);
      safeEmit({ type: 'turn', round: r, expert: 'gpt', role: 'rebuttal', text: pNext, final: extractFinal(pNext) });
      await verify('gpt', r, pNext);
    } else {
      safeEmit({ type: 'thinking', round: r, expert: 'gemini' });
      safeEmit({ type: 'thinking', round: r, expert: 'gpt' });
      const gPrompt = critiquePrompt(question, domain, gLast, EXPERTS.gpt.label, pLast, r, note) + webBlock;
      const pPrompt = critiquePrompt(question, domain, pLast, EXPERTS.gemini.label, gLast, r, note) + webBlock;
      [gNext, pNext] = await Promise.all([
        askGemini(gPrompt).catch(e => `(Gemini error: ${e.message})`),
        askGpt(pPrompt).catch(e => `(GPT-5 error: ${e.message})`),
      ]);
      safeEmit({ type: 'turn', round: r, expert: 'gemini', role: 'rebuttal', text: gNext, final: extractFinal(gNext) });
      safeEmit({ type: 'turn', round: r, expert: 'gpt', role: 'rebuttal', text: pNext, final: extractFinal(pNext) });
      await verify('gemini', r, gNext);
      await verify('gpt', r, pNext);
    }
    gLast = gNext; pLast = pNext;

    rounds.push({ round: r, gemini: gNext, gpt: pNext });
    converged = isConverged(gLast, pLast);

    safeEmit({
      type: 'round_summary', round: r, agreed: converged,
      gemini: gNext, gpt: pNext, geminiFinal: extractFinal(gNext), gptFinal: extractFinal(pNext),
    });
    safeEmit({ type: 'round_done', round: r, agreed: converged });
  }

  const gFinal = extractFinal(gLast);
  const pFinal = extractFinal(pLast);

  // ── Judge / verdict ──
  const tail = rounds.slice(-1).map(rr => `Gemini: ${rr.gemini}\n\nGPT-5: ${rr.gpt}`).join('\n\n');
  const verdictRaw = await judge(question, domain, gFinal, pFinal, tail)
    .catch(e => `VERDICT: Judge unavailable (${e.message}).\nFINAL ANSWER: ${converged ? gFinal : `${gFinal} | ${pFinal}`}`);
  const finalAnswer = extractFinal(verdictRaw) || (converged ? gFinal : `${gFinal} (Gemini) vs ${pFinal} (GPT-5)`);

  safeEmit({ type: 'verdict', converged, finalAnswer, text: verdictRaw });

  // ── Unify: both experts unite into one final deliverable ──
  let unified = '';
  if (opts.unify !== false) {
    unified = await unify(question, domain, finalAnswer, tail).catch(() => '');
    if (unified) safeEmit({ type: 'unified', text: unified });
  }

  return {
    question,
    domain,
    experts: [EXPERTS.gemini, EXPERTS.gpt],
    rounds,
    converged,
    geminiFinal: gFinal,
    gptFinal: pFinal,
    verdict: verdictRaw,
    finalAnswer,
    unified,
    needsSandbox: wantRun,
    enforcedSandbox: mustRun,
    sandboxBackend: (sandbox && sandbox.backend) || null,
    needsWeb: wantWeb,
    usedWebEvidence: !!webEvidence,
    sequential,
  };
}

module.exports = {
  debate, EXPERTS, extractFinal, answersAgree,
  detectDomain, needsSandbox, needsWeb,
  extractWebTargets, gatherWebEvidence,
};
