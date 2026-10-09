// mathSolver.js — math-specialist providers (text + image + PDF for math).
//
// Two upstreams, no API key / no signup required:
//   1. MathPanda (https://mathpanda.net)  — text + image(.png/.jpg/.jpeg) + PDF.
//      Laravel app: GET / for a CSRF token + session cookie, then
//      POST /generate (multipart) -> { response: "<markdown+LaTeX>" }.
//   2. AI Math Solver (https://ai.math.figpromptfinder.com/v2/solve/) — IMAGE
//      ONLY. multipart field `file` = image of a math problem ->
//      { problem, steps:[...], final_answer }.
//
// Public helpers:
//   solveText(prompt)                  -> string         (MathPanda)
//   solveImage(buffer, filename, mime) -> string         (MathPanda + figprompt race)
//   solvePdf(buffer, filename)         -> string         (MathPanda)
//   chat(messages)                     -> string         (extracts text, MathPanda)
//
// These are exposed so the agent can route math / image-math / math-PDF tasks
// here. They never touch the general text race, so non-math answers stay clean.
const fetch = require('node-fetch');
const FormData = require('form-data');
const mathQuality = require('./mathQuality');

const MP_BASE = 'https://mathpanda.net';
const FIG_SOLVE = 'https://ai.math.figpromptfinder.com/v2/solve/';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TOKEN_RE = /_token['"]\s*,\s*['"]([^'"]+)['"]/;

// ----- MathPanda session (cookie + CSRF token), cached briefly ----------------
let _mp = { token: null, cookies: null, at: 0 };
const MP_TTL_MS = 10 * 60 * 1000; // 10 min

async function mpBootstrap(force = false) {
  const now = Date.now();
  if (!force && _mp.token && (now - _mp.at) < MP_TTL_MS) return _mp;
  const resp = await fetch(`${MP_BASE}/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`MathPanda homepage HTTP ${resp.status}`);
  const setCookie = resp.headers.raw()['set-cookie'] || [];
  const cookies = setCookie.map(c => c.split(';')[0]).join('; ');
  const html = await resp.text();
  const m = html.match(TOKEN_RE);
  if (!m) throw new Error('MathPanda: CSRF token not found');
  _mp = { token: m[1], cookies, at: now };
  return _mp;
}

/**
 * Core MathPanda call (text and/or file). Returns the markdown/LaTeX reply.
 * @param {string} message    text prompt
 * @param {Object} file       optional { buffer, filename, mime }
 */
async function mathPanda(message, file = null, lang = 'en', _retry = false) {
  const { token, cookies } = await mpBootstrap(_retry);
  const fd = new FormData();
  const request = `${message || 'Please solve the problem in the attached file.'}\n\n${mathQuality.FULL_SOLUTION_INSTRUCTION}`;
  fd.append('chatInput', request);
  fd.append('page', 'index');
  fd.append('_token', token);
  fd.append('lang', lang);
  if (file && file.buffer) {
    fd.append('file_upload', file.buffer, {
      filename: file.filename || 'upload',
      contentType: file.mime || 'application/octet-stream',
    });
  }
  const resp = await fetch(`${MP_BASE}/generate`, {
    method: 'POST',
    headers: {
      ...fd.getHeaders(),
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${MP_BASE}/`,
      Cookie: cookies,
      'User-Agent': UA,
    },
    body: fd,
    signal: AbortSignal.timeout(90000),
  });
  // Stale CSRF -> refresh once.
  if (resp.status === 419 && !_retry) return mathPanda(message, file, lang, true);
  if (resp.status !== 200) throw new Error(`MathPanda HTTP ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  const data = await resp.json().catch(() => ({}));
  if (data.error) throw new Error(`MathPanda: ${data.error}`);
  const reply = String(data.response || '').trim();
  if (!reply) throw new Error('MathPanda: empty response');
  return reply;
}

/** AI Math Solver (figpromptfinder) — IMAGE ONLY. Returns formatted solution. */
async function figSolve(buffer, filename = 'problem.png', mime = 'image/png') {
  const fd = new FormData();
  fd.append('file', buffer, { filename, contentType: mime });
  const resp = await fetch(FIG_SOLVE, {
    method: 'POST', headers: fd.getHeaders(), body: fd, signal: AbortSignal.timeout(60000),
  });
  if (resp.status !== 200) throw new Error(`figSolve HTTP ${resp.status}`);
  const r = await resp.json().catch(() => ({}));
  if (!r || !r.problem) throw new Error('figSolve: no problem parsed');
  // If it couldn't find a problem, treat as failure so the racer falls back.
  if (/couldn't find a clear math problem/i.test(r.problem)) {
    throw new Error('figSolve: no math problem detected');
  }
  const lines = [`**Problem:** ${r.problem}`, ''];
  for (const s of (r.steps || [])) {
    lines.push(`**${s.title || 'Step'}:** ${s.explanation || ''}`);
    if (s.latex) lines.push(`$$${s.latex}$$`);
  }
  if (r.final_answer) lines.push('', `**Answer:** ${r.final_answer}`);
  return lines.join('\n');
}

const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
]);

/** Solve a math text prompt (MathPanda). */
async function solveText(prompt, lang = 'en') {
  return mathPanda(prompt, null, lang);
}

function validateSolution(task, answer) {
  return mathQuality.assess(task, answer);
}

/**
 * Solve a math problem in an IMAGE. Runs MathPanda OCR + figSolve in PARALLEL
 * and returns whichever answers first (resilient + fast).
 */
async function solveImage(buffer, filename = 'problem.png', mime = 'image/png', message = 'Solve the problem in this image.') {
  const racers = [
    withTimeout(mathPanda(message, { buffer, filename, mime }), 90000, 'mathpanda-img'),
    withTimeout(figSolve(buffer, filename, mime), 60000, 'figsolve'),
  ];
  return Promise.any(racers);
}

/** Solve a math problem in a PDF (MathPanda only — figSolve is image-only). */
async function solvePdf(buffer, filename = 'problem.pdf', message = 'Solve the problem in this PDF.') {
  return mathPanda(message, { buffer, filename, mime: 'application/pdf' });
}

/** Extract latest user text and solve via MathPanda (OpenAI-style messages in). */
async function chat(messages, opts = {}) {
  let text = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') { text = m.content; break; }
    if (Array.isArray(m.content)) {
      const t = m.content.filter(p => p && p.type === 'text').map(p => p.text).join(' ').trim();
      if (t) { text = t; break; }
    }
  }
  if (!text) throw new Error('mathSolver.chat: no text');
  return solveText(text, opts.lang || 'en');
}

module.exports = {
  solveText, solveImage, solvePdf, chat, validateSolution,
  mathPanda, figSolve,
  supportsText: () => true, supportsImage: () => true, supportsPdf: () => true,
};