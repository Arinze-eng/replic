// ─────────────────────────────────────────────────────────────────────────────
// agentBrainFusion.js — FUSED, multi-brain reasoning for the AGENT ReAct loop.
//
// PROBLEM this solves (user report: "the AI agent is not strong and can't even
// execute task very strong and firm"):
//   The chat path already uses FUSION (Mixture-of-Agents: several brains draft
//   in parallel → the strongest synthesises one superior answer). But the AGENT
//   ReAct loop (agentEngine.geminiComplete) deliberately used a SINGLE-brain
//   sequential fallback (HotBot → Gemini → Cloudflare) because it must return
//   exactly ONE JSON object {thought,action,args} per step and fusion prose
//   would corrupt that. Result: the part that ACTUALLY EXECUTES tasks ran on the
//   weakest wiring while plain chat got the powerful brain. That mismatch is the
//   root cause of a "weak" agent.
//
// WHAT THIS DOES:
//   A JSON-aware Mixture-of-Agents for the agent loop. Several brains propose
//   the next step IN PARALLEL, each returning a strict {thought,action,args}
//   JSON object. A synthesiser (strongest available brain) then reads every
//   valid proposal and emits the SINGLE BEST next action — merging the best
//   reasoning, discarding invalid/timid steps, and committing firmly to real
//   tool work instead of stalling. This makes the agent decisive, firm and
//   long-horizon capable while keeping the strict single-JSON contract intact.
//
// SAFETY / FALLBACK:
//   • Fully env-gated. AGENT_FUSION=0 → this module is bypassed and the caller
//     keeps its original sequential chain (zero behaviour change).
//   • If fewer than AGENT_FUSION_MIN valid proposals arrive, it ships the best
//     single proposal (no synthesis) — never worse than single-brain.
//   • Every phase is time-boxed to stay under the platform HTTP gateway.
//   • On ANY internal error it throws, and the caller falls back to its chain.
//
// It receives the already-built, timeout-wrapped brain callables from the caller
// so it reuses the EXACT same brains/keys/rotation the agent loop already has —
// no new credentials, no duplicated config.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const _num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const _on = (v, d) => {
  if (v == null) return d;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
};

// ── Config (all env-tunable; safe defaults sized for Render) ────────────────
const FUSION_ENABLED       = () => _on(process.env.AGENT_FUSION, true);        // master switch (default ON)
const FUSION_MIN           = () => _num(process.env.AGENT_FUSION_MIN, 2);      // need >=N valid proposals to synthesise
const FUSION_ENOUGH        = () => _num(process.env.AGENT_FUSION_ENOUGH, 3);   // start synthesis once N proposals arrive
const FUSION_PROPOSER_MS   = () => _num(process.env.AGENT_FUSION_PROPOSER_MS, 55000);
const FUSION_GRACE_MS      = () => _num(process.env.AGENT_FUSION_GRACE_MS, 3500);
const FUSION_SYNTH_MS      = () => _num(process.env.AGENT_FUSION_SYNTH_MS, 45000);
const FUSION_STAGGER_MS    = () => _num(process.env.AGENT_FUSION_STAGGER_MS, 180);

// ── JSON step parsing (mirrors agentEngine.parseAction's tolerance) ─────────
// We only need to know: is this a VALID next-step object with an `action`?
function _extractStepObject(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let candidate = s.slice(start, end + 1);
  // Escape lone backslashes that are illegal JSON string escapes (LaTeX, paths…)
  const fixEscapes = (str) => str.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  const attempts = [candidate, fixEscapes(candidate)];
  for (const a of attempts) {
    try {
      const obj = JSON.parse(a);
      if (obj && typeof obj === 'object' && typeof obj.action === 'string' && obj.action.trim()) {
        return {
          thought: typeof obj.thought === 'string' ? obj.thought : '',
          action: obj.action.trim(),
          args: (obj.args && typeof obj.args === 'object') ? obj.args : {},
          _raw: a,
        };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// Score a proposal: prefer FIRM, real-work actions over timid/stalling ones so
// the synthesiser (and the best-single fallback) lean toward decisive execution.
// This is the "execute strong and firm" bias the user asked for.
const _TIMID_ACTIONS = new Set(['', 'noop', 'wait', 'think', 'sequential_thinking']);
const _STRONG_ACTIONS = new Set([
  'run_code', 'browse', 'power_scrape', 'browser_action', 'fetch_url',
  'write_file', 'edit_file', 'create_pdf', 'create_docx', 'create_slides',
  'create_presentation', 'convert_file', 'deploy_site', 'deploy_render',
  'deploy_github', 'docker_run', 'generate_image', 'solve_captcha', 'read_skill',
]);
function _scoreProposal(p) {
  if (!p) return -1;
  let score = 1;
  const a = String(p.action || '').toLowerCase();
  if (_TIMID_ACTIONS.has(a)) score -= 2;
  if (_STRONG_ACTIONS.has(a)) score += 2;
  if (a === 'plan') score += 1;                 // planning early is good
  if (a === 'finish') score += 0;               // neutral — synth decides
  const argKeys = p.args ? Object.keys(p.args).length : 0;
  if (argKeys > 0) score += 1;                  // concrete args = real work
  if ((p.thought || '').length > 40) score += 1; // reasoned, not blind
  return score;
}

/**
 * Run one fused agent step.
 *
 * @param {Object} o
 * @param {string} o.systemPrompt
 * @param {Array}  o.conversation   [{role, text}]
 * @param {Array}  o.proposers      [[label, asyncFn->string], ...]  (already timeout-wrapped brains)
 * @param {Array}  o.synthesisers   [[label, asyncFn(messages)->string], ...] optional dedicated synth brains
 * @param {Function} o.withTimeout  (promise, ms, label) => promise
 * @param {Function} [o.onBrain]    (label) => void   — record which brain answered
 * @returns {Promise<{text:string, brain:string}>}
 */
async function fusedAgentStep(o) {
  const { systemPrompt, conversation, proposers, withTimeout } = o;
  const onBrain = typeof o.onBrain === 'function' ? o.onBrain : () => {};
  if (!Array.isArray(proposers) || proposers.length === 0) {
    throw new Error('fusedAgentStep: no proposers');
  }

  const ENOUGH = Math.min(FUSION_ENOUGH(), proposers.length);
  const MIN = Math.max(1, Math.min(FUSION_MIN(), proposers.length));

  // ── 1) PROPOSERS — collect JSON-step candidates in parallel ───────────────
  const collected = []; // { label, proposal, raw, score }
  const results = await new Promise((resolve) => {
    let done = false;
    let settled = 0;
    let graceTimer = null;
    const finish = () => { if (done) return; done = true; if (graceTimer) clearTimeout(graceTimer); resolve(collected.slice()); };

    const hardTimer = setTimeout(finish, FUSION_PROPOSER_MS());
    if (hardTimer && hardTimer.unref) hardTimer.unref();

    const maybeEnough = () => {
      const valid = collected.filter(c => c.proposal).length;
      if (valid >= ENOUGH && !graceTimer) {
        // small grace to let one more (slower/stronger) brain land
        graceTimer = setTimeout(finish, FUSION_GRACE_MS());
        if (graceTimer && graceTimer.unref) graceTimer.unref();
      }
    };

    proposers.forEach(([label, fn], i) => {
      setTimeout(() => {
        Promise.resolve()
          .then(() => withTimeout(fn(), FUSION_PROPOSER_MS(), 'agentfusion-prop-' + label))
          .then((raw) => {
            const proposal = _extractStepObject(raw);
            collected.push({ label, proposal, raw: String(raw || ''), score: _scoreProposal(proposal) });
            maybeEnough();
          })
          .catch(() => { /* a failed proposer just doesn't contribute */ })
          .finally(() => { settled += 1; if (settled >= proposers.length) finish(); });
      }, i * FUSION_STAGGER_MS());
    });
  });

  const valid = results.filter(r => r.proposal).sort((a, b) => b.score - a.score);
  if (valid.length === 0) {
    throw new Error('fusedAgentStep: no valid JSON proposals from any brain');
  }

  // Best single proposal is our guaranteed floor (never worse than single-brain).
  const best = valid[0];

  // Not enough diversity to fuse → ship the strongest single proposal.
  if (valid.length < MIN) {
    onBrain('fusion1[' + best.label + ']');
    return { text: best.proposal._raw, brain: 'agentfusion[best:' + best.label + ']' };
  }

  // ── 2) SYNTHESISE — strongest brain merges proposals into ONE firm step ───
  const candBlock = valid.slice(0, 5).map((c, i) =>
    `--- PROPOSAL ${i + 1} (from ${c.label}) ---\n${JSON.stringify({ thought: c.proposal.thought, action: c.proposal.action, args: c.proposal.args })}`
  ).join('\n\n');

  const synthSystem =
    systemPrompt + '\n\n' +
    '## 🧠 STEP SYNTHESISER MODE\n' +
    'Several expert agents independently proposed the NEXT action for the SAME task state. ' +
    'Your job: decide the SINGLE BEST next step and output it as EXACTLY ONE JSON object ' +
    '{"thought": "...", "action": "...", "args": {...}} — nothing else, no prose, no code fence.\n' +
    'Rules:\n' +
    '1. Pick the most CORRECT, DECISIVE, task-advancing action. Prefer real tool work ' +
    '(run_code, browse, write_file, create_*, deploy_*, read_skill…) over timid steps ' +
    '(waiting, empty thinking, re-planning without cause). Be FIRM — commit to executing.\n' +
    '2. Merge the best reasoning; fix any wrong path/url/args/selector you spot in a proposal.\n' +
    '3. Never invent a tool that is not in the protocol above. Keep args valid for the chosen tool.\n' +
    '4. If proposals genuinely conflict, choose the one that best obeys the user and moves the ' +
    'task toward a verified, complete deliverable.\n' +
    '5. Output ONLY the one JSON object. No mention of proposals or synthesis.';

  const synthUser =
    'TASK STATE (conversation so far is in context).\n\n' +
    'CANDIDATE NEXT STEPS:\n' + candBlock + '\n\n' +
    'Now output the single best next-step JSON object.';

  // Build synth conversation: reuse history + append the synthesis instruction.
  const synthConv = (conversation || []).map(m => ({ role: m.role, text: m.text }));
  synthConv.push({ role: 'user', text: synthUser });

  // Prefer dedicated synthesisers if provided; else reuse the proposer brains
  // (strongest first — caller orders them). Each synth call gets the augmented
  // system prompt so it knows it is merging proposals into one step.
  const synthChain = (Array.isArray(o.synthesisers) && o.synthesisers.length)
    ? o.synthesisers
    : proposers;

  for (const [label, fn] of synthChain) {
    try {
      // Synthesisers accept (systemPrompt, conversation) if arity>=2, else (messages).
      const raw = await withTimeout(
        (fn.length >= 2) ? fn(synthSystem, synthConv) : fn(),
        FUSION_SYNTH_MS(),
        'agentfusion-synth-' + label
      );
      const merged = _extractStepObject(raw);
      if (merged) {
        onBrain('fusion[' + label + ']');
        const brains = valid.map(v => v.label).join('+');
        return { text: merged._raw, brain: `agentfusion[${label}:${brains}]` };
      }
    } catch (e) {
      // try next synthesiser
    }
  }

  // Synthesis failed → ship the strongest single proposal (still solid).
  onBrain('fusion1[' + best.label + ']');
  return { text: best.proposal._raw, brain: 'agentfusion[best:' + best.label + ']' };
}

module.exports = {
  fusedAgentStep,
  _extractStepObject,   // exported for tests
  _scoreProposal,       // exported for tests
  FUSION_ENABLED,
};
