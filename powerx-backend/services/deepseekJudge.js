// ─────────────────────────────────────────────────────────────────────────────
// deepseekJudge.js — JUDGEMENT REMOVED. HotBot is fully in control.
//
// Per product decision, DeepSeek no longer judges, validates, re-verifies, or
// finishes any answer. The brain race (HotBot GPT-5 first, with Gemini /
// StudentAI / Pollinations / DeepSeek as resilient racers) produces the answer
// and that answer ships UNTOUCHED — for both the chat path (hotbot.js) and the
// autonomous agent path (agentGraph.js).
//
// This module is kept ONLY so existing call sites keep working without code
// changes:
//   • isJudgeEnabled()      → ALWAYS false. With the judge off, hotbot.js ships
//                             the race winner directly and lets DeepSeek rejoin
//                             the race as a normal racer; agentGraph.js ships
//                             the agent's final message unchanged.
//   • runWithJudge()        → returns the supplied answer verbatim (decidedBy:'race').
//   • judgeAnswer()         → always reports the answer as correct (no network call).
//   • deepseekFinish()      → returns the prior answer unchanged (no network call).
//
// No env var can re-enable judging — the behaviour is hard-off by design.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: We intentionally do NOT require ./deepseek or ./hotbot here anymore —
// the judge makes no model calls of its own. HotBot owns the answer end-to-end.

// ── Public: judge a single answer — NO-OP, always "correct" ─────────────────
/**
 * Judgement is disabled. Always reports the candidate answer as correct so any
 * caller that inspects the verdict ships the HotBot answer untouched.
 * @returns {Promise<{correct, confidence, reason, corrected, judge}>}
 */
async function judgeAnswer(question, answer /*, opts */) {
  return {
    correct: true,
    confidence: 1,
    reason: 'judgement disabled — HotBot is in full control',
    corrected: '',
    judge: 'disabled',
  };
}

// ── Public: pipeline — NO-OP, ship the answer as-is ─────────────────────────
/**
 * Judgement pipeline disabled. Returns the supplied answer verbatim. `reverify`
 * and `finish` callbacks are never invoked, so HotBot's answer is final.
 * @returns {Promise<{answer, decidedBy, verdict}>}
 */
async function runWithJudge(cfg = {}) {
  const answer = String(cfg.answer == null ? '' : cfg.answer);
  return {
    answer,
    decidedBy: 'race',
    verdict: { correct: true, reason: 'judgement disabled — HotBot is in full control' },
  };
}

// ── Public: DeepSeek finishes a task — NO-OP, return prior answer ───────────
/**
 * Judgement disabled. Never finishes/overwrites an answer; returns the prior
 * answer unchanged so HotBot's output is what the user receives.
 */
async function deepseekFinish(question, priorAnswer /*, critique, opts */) {
  return String(priorAnswer == null ? '' : priorAnswer);
}

// Always false: the judge is permanently off. hotbot.js / agentGraph.js read
// this and ship the HotBot answer directly (and let DeepSeek rejoin the chat
// race as a normal racer rather than sitting out as a judge).
function isJudgeEnabled() { return false; }

module.exports = {
  judgeAnswer,
  runWithJudge,
  deepseekFinish,
  isJudgeEnabled,
};
