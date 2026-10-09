'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// heavyTask.js — Heavy-task detection + deliberate-thinking / proof-reading.
//
// The user asked for two coding-side upgrades:
//   1. The agent should KNOW which tasks are HEAVY (big refactors, multi-file
//      builds, deep bug hunts, whole-repo work) vs LIGHT (a one-line fix, a
//      quick question) and INVEST MORE on the heavy ones.
//   2. On heavy tasks the agent should DELIBERATELY SLOW DOWN — plan, think in
//      multiple passes, proof-read its own work, and self-test before finishing
//      — instead of rushing.
//
// This module is pure logic (no I/O, never throws). agentGraph.js uses it to:
//   • classify the task once at loop start (classify),
//   • inject a one-time DELIBERATION brief into the transcript for heavy tasks
//     (deliberationBrief),
//   • decide, when the brain tries to `finish` a heavy coding task, whether it
//     has done enough deep work / self-testing yet (finishGuard).
//
// Everything here is ADDITIVE and gated: light tasks are completely unaffected,
// so fast correct work stays fast.
// ─────────────────────────────────────────────────────────────────────────────

// Signals that a coding/engineering task is HEAVY.
const HEAVY_SIGNALS = [
  /\b(refactor|re-architect|rewrite|overhaul|migrate|port)\b/i,
  /\b(entire|whole|full|complete)\s+(repo|repository|codebase|project|app|system)\b/i,
  /\b(multiple|several|many|all (?:the )?)\s*(files?|modules?|services?|components?|endpoints?)\b/i,
  /\b(debug|root[- ]?cause|deep dive|investigate|trace)\b.*\b(bug|crash|error|failure|regression)\b/i,
  /\b(build|implement|create|develop|write)\b.*\b(feature|system|pipeline|engine|framework|integration|service|app|application|frontend|backend|api)\b/i,
  /\b(from scratch|greenfield|full[- ]?stack|frontend.*backend|backend.*frontend)\b/i,
  /\b(strengthen|harden|optimi[sz]e|improve)\b.*\b(system|engine|abilit|performance|code)\b/i,
  /\b(end[- ]?to[- ]?end|e2e|integration)\s+test/i,
  /\b(deploy|ci\/cd|pipeline|workflow)\b/i,
  /\b(security|pentest|vulnerabilit|exploit|audit)\b/i,
];

// Signals a task is clearly LIGHT (short Q&A, trivial edit) — suppresses heavy
// mode even if a heavy word appears.
const LIGHT_SIGNALS = [
  /^\s*(what|who|when|where|why|how much|is|are|does|do|can|explain|define|tell me)\b/i,
  /\b(one[- ]?liner|quick (?:fix|question)|typo|rename|single line)\b/i,
];

const CODE_CONTEXT = /\b(code|coding|bug|fix|implement|build|script|function|api|refactor|repo|repository|deploy|test|compile|module|class|file|program|feature|debug|server|backend|frontend|database|sql|python|node|javascript|typescript|java|c\+\+|rust|go)\b/i;

/**
 * Classify a task's weight.
 * @returns {{ heavy:boolean, coding:boolean, score:number, reasons:string[] }}
 */
function classify(taskText) {
  const t = String(taskText || '');
  const reasons = [];
  let score = 0;

  const coding = CODE_CONTEXT.test(t);
  for (const re of HEAVY_SIGNALS) {
    if (re.test(t)) { score++; reasons.push(re.source.slice(0, 40)); }
  }
  // Long, multi-sentence requests tend to be heavier.
  const words = (t.trim().match(/\S+/g) || []).length;
  if (words >= 60) { score++; reasons.push('long-request'); }
  if (words >= 150) { score++; reasons.push('very-long-request'); }
  // Multiple explicit sub-goals (numbered list / "and ... and ...").
  const bullets = (t.match(/(^|\n)\s*\d+[.)]/g) || []).length;
  if (bullets >= 2) { score++; reasons.push('multi-goal'); }

  let heavy = coding && score >= 1;
  if (LIGHT_SIGNALS.some(re => re.test(t)) && score < 2) heavy = false;

  return { heavy, coding, score, reasons };
}

/**
 * A one-time DELIBERATION brief injected into the transcript for heavy tasks.
 * It nudges the brain to slow down and work in disciplined passes WITHOUT
 * inventing arbitrary time/step floors — it's guidance the strong-engineer
 * doctrine already endorses, focused for heavy work.
 */
function deliberationBrief(info) {
  const which = info && info.coding ? 'engineering/coding' : 'complex';
  return (
    `[HEAVY TASK DETECTED — DELIBERATE MODE]\n` +
    `This is a HEAVY ${which} task. Do NOT rush. Work like a senior engineer in disciplined passes:\n` +
    `1) UNDERSTAND: restate the true goal + success criteria; read the relevant files/inputs FULLY before changing anything.\n` +
    `2) PLAN: call \`plan\` with concrete ordered steps (explore → change → run/test → fix → verify → deliver).\n` +
    `3) EXPLORE FIRST: for existing code use grep/glob/read before editing; for greenfield work inspect the workspace and then establish the architecture, contracts, data model and acceptance tests before implementation.\n` +
    `4) IMPLEMENT IN FULL: complete frontend, backend, auth/data boundaries and configuration as required; no stubs/TODOs/placeholders or fake success paths.\n` +
    `5) THINK IN MULTIPLE PASSES: in each \`thought\`, weigh options and predict outcomes; after a change, re-read your own diff and PROOF-READ it for bugs/edge cases before moving on.\n` +
    `6) SELF-TEST: actually install dependencies, build/lint/typecheck, run unit tests and exercise integration/E2E/smoke flows. For full-stack work test frontend→API→auth→database boundaries. If anything fails, diagnose the root cause, fix, and run AGAIN until it passes.\n` +
    `7) VERIFY & only then finish: prove it works with a tool observation. "I think it works" is not enough.\n` +
    `Take the time this needs. Correct + complete beats fast.`
  );
}

// Words that indicate the brain actually reasoned/verified in its work.
const DEEP_TOOLS = new Set(['plan', 'grep', 'glob', 'read', 'read_file', 'list_files', 'sequential_thinking', 'mcp_filesystem']);
const EDIT_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'coding']);
const RUN_TOOLS = new Set(['run_code', 'bash', 'docker_run']);
const RUN_FAIL = /\[(?:exit [1-9]|error|timed out|shell error)\]|Traceback|SyntaxError|\bFAILED\b/i;

/**
 * When the brain tries to `finish` a HEAVY coding task, verify it has actually
 * done deep work (explored + implemented + successfully run/tested). Returns a
 * correction string to push back with, or null if it's genuinely done.
 *
 * @param {object} info    classify() result
 * @param {Array}  trace   [{tool,result}] executed so far
 * @param {number} nudges  how many times we've already pushed back (budget)
 */
function finishGuard(info, trace, nudges) {
  if (!info || !info.heavy || !info.coding) return null;   // only heavy coding
  if (nudges >= 2) return null;                            // don't stall forever
  trace = Array.isArray(trace) ? trace : [];
  const tools = trace.map(x => String(x.tool || '').toLowerCase());

  const explored = tools.some(t => DEEP_TOOLS.has(t));
  const edited = tools.some(t => EDIT_TOOLS.has(t)) || trace.some(x => /FILE_WRITTEN|\[write\]|\[edit\]/i.test(String(x.result || '')));
  const ranOk = trace.some(x => RUN_TOOLS.has(String(x.tool || '').toLowerCase()) && !RUN_FAIL.test(String(x.result || '')));

  if (!explored) {
    return '[HEAVY GATE] Before finishing this heavy task, explore the code first (grep/glob/read the relevant files) so your change is grounded, not guessed.';
  }
  if (!edited) {
    return '[HEAVY GATE] This heavy coding task has no implemented change yet. Write/edit the actual code in full before finishing.';
  }
  if (!ranOk) {
    return '[HEAVY GATE] You changed code but have no evidence it runs. Self-test it (run_code/bash/tests), read the output, fix any failure, and re-run until it passes — then finish.';
  }
  return null;
}

module.exports = { classify, deliberationBrief, finishGuard, HEAVY_SIGNALS };
