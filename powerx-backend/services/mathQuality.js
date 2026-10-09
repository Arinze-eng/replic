'use strict';

// Deterministic quality checks for educational mathematics output. These checks
// do not judge mathematical truth; they reject structurally incomplete answers
// (answer-only output, skipped items, unexplained formula-to-result jumps) so the
// agent must expand and verify the work before finishing.
const MATH_TASK = /(?:\bmath(?:s|ematics|ematical)?\b|\balgebra\b|\bcalculus\b|\bprobability\b|\bstatistics\b|\bdifferential equations?\b|\bfourier\b|\blaplace\b|\bintegral\b|\bderivative\b|\bequation\b|\bsolve\b[^\n]{0,80}(?:\d|[=+\-*/^√∫])|[=√∫∑][^\n]{1,120}\?)/i;
const SOFTWARE_CONTEXT = /\b(?:repository|repo|codebase|javascript|typescript|python service|unit test|api endpoint|deploy|docker|npm|github)\b/i;
const STEP_SIGNAL = /\b(?:given|find|target|formula|principle|theorem|step\s*\d+|substitut|rearrang|expand|factor|differentiat|integrat|therefore|hence|because)\b/i;
const VERIFY_SIGNAL = /\b(?:verify|verification|check|substitut(?:e|ing) back|independent check|different method|units? check|domain check|sanity check|re-deriv)\b/i;
const FINAL_SIGNAL = /(?:\b(?:final answer|answer)\b|\\boxed\s*\{|\bboxed\b)/i;
const SKIP_SIGNAL = /\b(?:cannot solve|unable to solve|impossible to calculate|missing information|illegible|incomplete|just the final answer|answers? only|omitted|skipped)\b/i;
const EQUATION_LINE = /(?:^|\n)[^\n]{0,140}(?:=|⇒|→)[^\n]{1,180}/g;
const ITEM_MARKER = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:question\s*)?(\d{1,3}[a-z]?|[a-z]\)|[ivxlcdm]{1,8}[.)])\s*[).:\-]?/gi;

function isMathTask(task) {
  const text = String(task || '');
  return MATH_TASK.test(text) && !SOFTWARE_CONTEXT.test(text);
}

function countItems(text) {
  const seen = new Set();
  let m;
  ITEM_MARKER.lastIndex = 0;
  while ((m = ITEM_MARKER.exec(String(text || ''))) !== null) {
    const key = String(m[1] || '').toLowerCase().replace(/[).]/g, '');
    if (key) seen.add(key);
  }
  return seen.size;
}

function assess(task, answer) {
  const t = String(task || '');
  const a = String(answer || '').trim();
  if (!isMathTask(t)) return { applicable: false, ok: true, reasons: [] };

  const reasons = [];
  const requestedItems = countItems(t);
  const answeredItems = countItems(a);
  const equationLines = (a.match(EQUATION_LINE) || []).length;
  const explicitStepCount = (a.match(/\b(?:step\s*\d+|given|target|formula|rule|principle|theorem|substitut(?:e|ion|ing)?|verify|verification|check)\b/gi) || []).length;
  const finalCount = (a.match(/(?:\bfinal answer\b|\\boxed\s*\{|\bboxed\b)/gi) || []).length;

  if (a.length < 280) reasons.push('solution is too short to show full working');
  if (!STEP_SIGNAL.test(a) || explicitStepCount < 3) reasons.push('missing givens/formula/substitution or meaningful step structure');
  if (equationLines < Math.max(2, requestedItems || 1)) reasons.push('too few visible algebra/calculation transformations');
  if (!FINAL_SIGNAL.test(a)) reasons.push('final answer is not clearly identified');
  if (!VERIFY_SIGNAL.test(a)) reasons.push('no independent verification or substitution check');
  if (SKIP_SIGNAL.test(a)) reasons.push('one or more items appear skipped or unsupported');
  if (requestedItems >= 2 && answeredItems < requestedItems) reasons.push(`only ${answeredItems} of ${requestedItems} detected items are represented`);
  if (requestedItems >= 2 && finalCount < 1) reasons.push('multi-question solution has no explicit final answer summary');

  return {
    applicable: true,
    ok: reasons.length === 0,
    reasons,
    metrics: { requestedItems, answeredItems, equationLines, explicitStepCount, finalCount, chars: a.length },
  };
}

function correction(task, answer) {
  const result = assess(task, answer);
  if (!result.applicable || result.ok) return null;
  return '[MATH COMPLETENESS GATE] The attempted solution is structurally incomplete: ' +
    result.reasons.join('; ') +
    '. Re-solve every item with givens, target, governing rule, substitution, every meaningful algebra/arithmetic step, intermediate values, a clearly marked final answer, and an independent check. Do not silently omit unreadable or difficult items.';
}

const FULL_SOLUTION_INSTRUCTION = `Return a complete worked solution, never an answer-only response. For every numbered item and sub-item: (1) restate the givens and target, (2) name and justify the governing rule, (3) substitute values, (4) show every meaningful algebraic and arithmetic transformation and intermediate value, (5) clearly mark the final answer with units/domain/rounding, and (6) independently verify it by substitution, inverse operation, or a second derivation. Build a source ledger first for a multi-question file; solve every detected item exactly once and explicitly flag unreadable source text rather than guessing or skipping it.`;

module.exports = { isMathTask, countItems, assess, correction, FULL_SOLUTION_INSTRUCTION };
