// ─────────────────────────────────────────────────────────────────────────────
// agentGraph.js — LangGraph state-machine that drives the WormGPT Agent loop.
//
// This replaces the old hand-rolled `for (i < MAX_STEPS)` ReAct loop in
// agentEngine.js with a REAL LangGraph `StateGraph`. The graph models the
// classic agent control-flow as explicit nodes + conditional edges:
//
//        ┌──────────────────────────────────────────────┐
//        │                                                ▼
//   START ──▶ agent ──(route)──▶ tools ──▶ (back to agent)
//                 │
//                 └──(finish / final answer / error)──▶ END
//
//   • agent  — calls the AI brain (the HotBot/GPT-5 brain), parses the JSON
//              action, and records the model's chosen action into state.
//   • tools  — executes the chosen tool (run_code, browse, deploy, …) inside
//              the Daytona/Runloop sandbox via the injected executeTool() and
//              appends the OBSERVATION back into the conversation.
//   • route  — conditional edge: if the model called `finish` (or returned a
//              plain final answer, or the brain errored) → END; otherwise loop
//              back through `tools` → `agent`.
//
// ✨ QUALITY THROUGH CAPABILITY — NO PERSISTENCE NUDGES (CodeBanana-style)
// ----------------------------------------------------------------------------
// The previous version of this file contained a "QUALITY-COMPLETION GATE" /
// "persistence gate": when the brain tried to `finish`, the gate would refuse
// and inject "[QUALITY GATE — NOT DONE YET]" push-backs until artificial floors
// (min seconds, min steps, skill-loaded, a one-shot self-grade) were satisfied.
// In practice that produced stalling and busy-spin rather than genuine quality.
//
// That entire mechanism has been REMOVED. The agent now finishes the instant it
// has actually solved the task. Quality is delivered the way a strong engineer
// delivers it — through a disciplined working method (Understand → Plan →
// Execute with real tool/sandbox steps → Validate by running the work → Wrap
// up), reading before writing, grounding facts via search, and verifying by
// actually executing — all driven by the SYSTEM PROMPT and the TOOLS, not by
// forced nudges. `finish` is honored immediately; fast correct work is great.
//
// The graph still reuses EVERYTHING from agentEngine.js — the same brain, the
// same parseAction, the same tool implementations, the same `ctx`/sandbox `fsx`
// and the same MAX_STEPS budget (enforced here as the graph recursion limit).
// It is a drop-in replacement: `runGraphLoop()` returns the same
// `{ finalMessage }` the old loop produced, so all callers (Telegram / WhatsApp
// / web) are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

const { StateGraph, START, END, Annotation } = require('@langchain/langgraph');
const qualityGate = require('./qualityGate');
const heavyTask = require('./heavyTask');

const AGENT_BUDGET_MIN = 1;
const AGENT_BUDGET_MAX = 1000;
function clampBudget(value, fallback = 270) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(AGENT_BUDGET_MIN, Math.min(AGENT_BUDGET_MAX, n));
}

// ── Graph state channels ───────────────────────────────────────────────────
// `conversation` is an append-only transcript (user/model turns). Each channel
// declares a reducer describing how node return-values merge into state.
const AgentState = Annotation.Root({
  // The running conversation transcript ({ role, text }[]). Appended to.
  conversation: Annotation({
    reducer: (prev, next) => (next ? prev.concat(next) : prev),
    default: () => [],
  }),
  // The action object the brain last chose ({ action, args, thought }).
  pendingAction: Annotation({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  // The final answer to return to the user once the agent finishes.
  finalMessage: Annotation({
    reducer: (_prev, next) => (next !== undefined && next !== null ? next : _prev),
    default: () => '',
  }),
  // Monotonic step counter (mirrors the old `ctx.step`).
  step: Annotation({
    reducer: (_prev, next) => (typeof next === 'number' ? next : _prev),
    default: () => 0,
  }),
  // Model iterations and tool steps are separate budgets. This prevents a
  // malformed/finish-nudge cycle from bypassing the tool-step ceiling.
  iteration: Annotation({
    reducer: (_prev, next) => (typeof next === 'number' ? next : _prev),
    default: () => 0,
  }),
  // Set true when the graph should stop (finish / final answer / error).
  done: Annotation({
    reducer: (_prev, next) => (typeof next === 'boolean' ? next : _prev),
    default: () => false,
  }),
});

/**
 * Build + compile the agent StateGraph.
 *
 * @param {object}   deps
 * @param {function} deps.brain        async (systemPrompt, conversation) => rawText
 * @param {string}   deps.systemPrompt the AGENT_SYSTEM_PROMPT
 * @param {function} deps.parseAction  (raw) => actionObj | null
 * @param {function} deps.executeTool  async (name, args) => observationString
 * @param {object}   deps.ctx          the shared agent ctx (carries .step, .onStep)
 * @param {function} [deps.onStep]     progress callback
 * @returns compiled graph
 */
function buildAgentGraph(deps) {
  const {
    brain, systemPrompt, parseAction, executeTool, ctx, onStep,
    taskText = '', thinkUntilMs = 0,
    maxIterations: requestedMaxIterations = 270,
    maxSteps: requestedMaxSteps = 270,
    signal = null,
  } = deps;
  const maxIterations = clampBudget(requestedMaxIterations);
  const maxSteps = clampBudget(requestedMaxSteps);
  const stopped = () => !!(signal && signal.aborted);

  const stoppedState = (state = {}) => ({
    pendingAction: null,
    finalMessage: '🛑 Task stopped.',
    done: true,
    step: state.step || 0,
    iteration: state.iteration || 0,
  });
  const actionHistory = [];
  const resultHistory = new Map();
  const fingerprint = (name, args) => {
    const keys = ['cmd', 'command', 'code', 'path', 'url', 'query', 'filename', 'name', 'source'];
    const ident = keys.map(k => args && args[k] != null ? `${k}=${String(args[k]).slice(0, 300)}` : '').filter(Boolean).join(';');
    return `${String(name || '').toLowerCase()}|${ident}`;
  };
  // ⏱️ TIME-BOX: when the user asked the agent to think for a fixed duration,
  // don't finish while the window is open — bounce it into a new, different
  // improving action until the deadline. Bounded so a stuck model still ends.
  let keepThinkingBounces = 0;
  const maxKeepThinking = parseInt(process.env.AGENT_KEEP_THINKING_MAX || '60', 10);
  const timeLeftMs = () => (thinkUntilMs ? (thinkUntilMs - Date.now()) : 0);
  const keepThinkingDirective = () => {
    const secs = Math.max(0, Math.round(timeLeftMs() / 1000));
    return (
      `You still have ~${secs}s of dedicated thinking time left and the user asked you to keep ` +
      `working for the full duration. Do NOT finish yet and do NOT repeat a previous step. Take a ` +
      `genuinely DIFFERENT next action that improves the result (new approach/angle, verify or ` +
      `stress-test what you have, research another source, cover an edge case, add depth). ` +
      `Respond with ONE new JSON action.`
    );
  };
  // Bounded, evidence-based finish checks. No time floor or arbitrary step
  // minimum: ask only for missing proof and stop after a small retry budget.
  const progress = { skillLoaded: false, codebaseInspected: false, toolSteps: 0, searched: 0, verified: 0, built: 0 };
  const trace = [];
  let gateNudges = 0;
  const maxGateNudges = parseInt(process.env.AGENT_CORRECTNESS_GATE_NUDGES || '4', 10);

  // ── HEAVY-TASK deliberate mode ─────────────────────────────────────────────
  // Classify the task ONCE. Heavy engineering/coding tasks get (a) a one-time
  // deliberation brief injected so the brain slows down and works in disciplined
  // passes, and (b) a finish guard requiring explore→implement→self-test proof.
  // Light tasks are untouched. Disable entirely with HEAVY_MODE=off.
  const heavyEnabled = String(process.env.HEAVY_MODE || '').toLowerCase() !== 'off';
  const taskInfo = heavyEnabled ? heavyTask.classify(taskText) : { heavy: false, coding: false };
  let briefInjected = false;
  let heavyNudges = 0;
  if (taskInfo.heavy && onStep) {
    try { onStep('🏋️ heavy task detected — engaging deliberate mode (plan → explore → build → self-test → verify)'); } catch (_) {}
  }

  function checkFinish(message) {
    // Heavy-coding evidence guard runs FIRST (explore/implement/self-test).
    if (taskInfo.heavy) {
      const heavyCorrection = heavyTask.finishGuard(taskInfo, trace, heavyNudges);
      if (heavyCorrection) { heavyNudges++; return heavyCorrection; }
    }
    if (gateNudges >= maxGateNudges) return null;
    const gateTrace = progress.codebaseInspected && !trace.some(x => ['inspect_codebase', 'codebase_map'].includes(String(x.tool || '').toLowerCase()))
      ? [{ tool: 'inspect_codebase', result: 'CODEBASE_INVENTORY_COMPLETE' }, ...trace]
      : trace;
    const correction = qualityGate.evaluate(taskText, gateTrace, message);
    if (correction) gateNudges++;
    return correction;
  }

  // ── Node: agent — ask the brain for the next action ──────────────────────
  async function agentNode(state) {
    // Cancellation is checked before every model turn. This is intentionally
    // independent of the sandbox stop flag so host-loop runs halt immediately.
    if (stopped()) return stoppedState(state);
    // Keep ctx.step in sync so tools that read it behave identically.
    ctx.step = state.step;
    // toolsNode can end the run when its independent budget is exhausted. The
    // graph's tools→agent edge is unconditional, so preserve that terminal state
    // without making one extra model call.
    if (state.done) return { done: true, finalMessage: state.finalMessage };
    if (state.iteration >= maxIterations) {
      if (onStep) onStep(`🛑 iteration budget reached (${maxIterations}); returning verified work completed so far.`);
      return { finalMessage: 'Iteration budget reached. I stopped safely and preserved the work completed so far.', done: true };
    }
    const nextIteration = state.iteration + 1;

    // Inject the heavy-task deliberation brief exactly ONCE, before the very
    // first brain call, so the whole run works in deliberate mode.
    if (taskInfo.heavy && !briefInjected) {
      briefInjected = true;
      const brief = heavyTask.deliberationBrief(taskInfo);
      return {
        conversation: [{ role: 'user', text: brief }],
        iteration: nextIteration,
        // No pendingAction / not done → routeAfterAgent loops back into agent,
        // which now sees the brief in the transcript before it plans.
      };
    }

    let raw;
    try {
      if (signal) {
        raw = await Promise.race([
          brain(systemPrompt, state.conversation),
          new Promise((_, reject) => {
            if (signal.aborted) return reject(Object.assign(new Error('Task stopped by user'), { code: 'AGENT_STOPPED' }));
            signal.addEventListener('abort', () => reject(Object.assign(new Error('Task stopped by user'), { code: 'AGENT_STOPPED' })), { once: true });
          }),
        ]);
      } else {
        raw = await brain(systemPrompt, state.conversation);
      }
    } catch (e) {
      if (stopped() || (e && e.code === 'AGENT_STOPPED')) return stoppedState({ ...state, iteration: nextIteration });
      // Brain failure → finish with an error message (same behaviour as before).
      return { finalMessage: `⚠️ AI gateway error: ${e.message}`, done: true, iteration: nextIteration };
    }

    const action = parseAction(raw);
    if (!action || !action.action) {
      const finalMessage = String(raw).replace(/^```[a-z]*|```$/g, '').trim();
      // ⏱️ Time-box: keep exploring until the deadline instead of finishing.
      if (thinkUntilMs && timeLeftMs() > 0 && keepThinkingBounces < maxKeepThinking) {
        keepThinkingBounces++;
        return {
          conversation: [
            { role: 'model', text: `(attempted finish) ${finalMessage}` },
            { role: 'user', text: `OBSERVATION:\n${keepThinkingDirective()}` },
          ],
          pendingAction: null,
          iteration: nextIteration,
        };
      }
      const correction = checkFinish(finalMessage);
      if (correction) {
        return {
          conversation: [
            { role: 'model', text: `(attempted finish) ${finalMessage}` },
            { role: 'user', text: `OBSERVATION:\n${correction}\nChoose a materially different next action.` },
          ],
          pendingAction: null,
          iteration: nextIteration,
        };
      }
      return { finalMessage, done: true, iteration: nextIteration };
    }

    const name = String(action.action).toLowerCase();
    if (onStep) {
      const thought = action.thought ? action.thought : '';
      onStep(`🧠 ${thought ? thought + ' — ' : ''}${name === 'finish' ? 'finalizing' : 'using ' + name}`);
    }

    if (name === 'finish') {
      const finalMessage = action.args && action.args.message
        ? action.args.message
        : (action.thought || 'Done.');
      // ⏱️ Time-box: honour "use N minutes / keep thinking" before finishing.
      if (thinkUntilMs && timeLeftMs() > 0 && keepThinkingBounces < maxKeepThinking) {
        keepThinkingBounces++;
        if (onStep && (keepThinkingBounces === 1 || keepThinkingBounces % 5 === 0)) {
          onStep(`⏱️ still within the requested thinking time — exploring a new angle (${Math.round(timeLeftMs() / 1000)}s left)`);
        }
        return {
          conversation: [
            { role: 'model', text: JSON.stringify(action) },
            { role: 'user', text: `OBSERVATION:\n${keepThinkingDirective()}` },
          ],
          pendingAction: null,
          iteration: nextIteration,
        };
      }
      const correction = checkFinish(finalMessage);
      if (correction) {
        return {
          conversation: [
            { role: 'model', text: JSON.stringify(action) },
            { role: 'user', text: `OBSERVATION:\n${correction}\nChoose a materially different next action.` },
          ],
          pendingAction: null,
          iteration: nextIteration,
        };
      }
      return { finalMessage, done: true, iteration: nextIteration };
    }

    // A real tool was chosen → hand off to the tools node.
    return { pendingAction: action, iteration: nextIteration };
  }

  // ── Node: tools — execute the chosen tool and feed back the observation ───
  async function toolsNode(state) {
    if (stopped()) return stoppedState(state);
    const action = state.pendingAction;
    // SAFETY: bounce back to the agent node if there is no pending tool action
    // rather than dereferencing a null (which used to crash the run).
    if (!action || !action.action) {
      return { pendingAction: null, step: state.step };
    }
    const name = String(action.action).toLowerCase();
    const args = action.args || {};

    if (state.step >= maxSteps) {
      if (onStep) onStep(`🛑 tool-step budget reached (${maxSteps}); stopping before another action.`);
      return { pendingAction: null, finalMessage: 'Tool-step budget reached. I stopped safely and preserved the work completed so far.', done: true };
    }

    // Detect cycles across the recent window, not only consecutive duplicates.
    const fp = fingerprint(name, args);
    const recentRepeats = actionHistory.slice(-12).filter(x => x === fp).length;
    if (fp && recentRepeats >= 2) {
      return {
        conversation: [
          { role: 'model', text: JSON.stringify(action) },
          { role: 'user', text: 'OBSERVATION:\n[LOOP_GUARD] This materially identical action already occurred multiple times recently. Do not execute it again. Diagnose the latest evidence and choose a different file, command, hypothesis, or verification strategy.' },
        ],
        pendingAction: null,
        step: state.step,
      };
    }
    actionHistory.push(fp);
    if (actionHistory.length > 40) actionHistory.shift();

    // Light telemetry only (informs status lines; never gates anything).
    progress.toolSteps++;
    if (name === 'read_skill' || name === 'list_skills') progress.skillLoaded = true;
    if (name === 'inspect_codebase' || name === 'codebase_map') progress.codebaseInspected = true;
    if (name === 'web_search' || name === 'browse' || name === 'fetch_url' || name === 'wolfram_alpha' ||
        name === 'power_scrape' || name === 'power_browse' || name === 'fallback_browse' ||
        name === 'browser_action' || name === 'solve_captcha' || name === 'captcha' || name === 'bypass_captcha') progress.searched++;
    if (/^(write_file|edit_file|run_code|create_pdf|create_docx|create_slides|create_presentation|create_chart|generate_image|edit_image|make_zip|convert_file|deploy_site|deploy_cloudflare_pages|deploy_github|deploy_render|host_media)$/.test(name)) progress.built++;
    if (/^(run_code|read_file|output_verifier|verify|test|fetch_url|browse|power_scrape|wolfram_alpha|browser_action)$/.test(name)) progress.verified++;

    let result;
    // ── ⏱️ ANTI-HANG WATCHDOG (fixes "agent hangs forever on a tool/install") ──
    // A long tool (heavy apt/pip install, big scan, build) used to block this
    // node with ZERO feedback, so the app looked frozen. We now:
    //   1. emit a periodic heartbeat step so the user always sees it working,
    //   2. race the tool against a hard ceiling so a truly stuck call can never
    //      wedge the whole run — it returns a timeout observation and the agent
    //      picks a different next step instead of hanging.
    const TOOL_HARD_MS = parseInt(process.env.AGENT_TOOL_HARD_MS || '360000', 10); // 6 min ceiling
    const HEARTBEAT_MS = parseInt(process.env.AGENT_TOOL_HEARTBEAT_MS || '15000', 10);
    let hb = null, elapsed = 0;
    if (onStep) {
      hb = setInterval(() => {
        elapsed += HEARTBEAT_MS;
        try { onStep(`⏳ still running \`${name}\` (${Math.round(elapsed / 1000)}s)… working on it`); } catch (_) {}
      }, HEARTBEAT_MS);
      if (hb.unref) hb.unref();
    }
    try {
      const toolP = executeTool(name, args);
      const races = [toolP];
      let to;
      if (TOOL_HARD_MS > 0) {
        races.push(new Promise((resolve) => {
          to = setTimeout(() => resolve(
            `[timeout] tool "${name}" exceeded ${Math.round(TOOL_HARD_MS / 1000)}s and was cut off. ` +
            `The step was NOT completed. Do NOT retry the exact same thing — either run it in the ` +
            `background (append \` &\` / use nohup and poll a log/sentinel file), split it into smaller ` +
            `steps, or choose a different approach to make progress.`
          ), TOOL_HARD_MS);
          if (to.unref) to.unref();
        }));
      }
      if (signal) {
        races.push(new Promise((_, reject) => {
          if (signal.aborted) return reject(Object.assign(new Error('Task stopped by user'), { code: 'AGENT_STOPPED' }));
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Task stopped by user'), { code: 'AGENT_STOPPED' })), { once: true });
        }));
      }
      result = await Promise.race(races);
      if (to) clearTimeout(to);
    } catch (e) {
      if (stopped() || (e && e.code === 'AGENT_STOPPED')) return stoppedState(state);
      result = `[error] tool ${name} crashed: ${e.message}`;
    } finally {
      if (hb) clearInterval(hb);
    }
    const resultText = String(result);
    trace.push({ tool: name, args, result: resultText.slice(0, 6000) });
    if (trace.length > 80) trace.splice(0, trace.length - 80);

    // If the same action keeps producing the same observation, make the lack of
    // progress explicit so the next model turn explores rather than retries.
    const resultSig = resultText.replace(/\s+/g, ' ').slice(0, 1200);
    const previousResult = resultHistory.get(fp);
    resultHistory.set(fp, resultSig);
    const stagnation = previousResult && previousResult === resultSig
      ? '\n\n[PROGRESS_GUARD] This action produced the same result as before. Treat that approach as exhausted and choose a materially different next step.'
      : '';

    // Append the model's action + the observation to the transcript, exactly
    // like the original loop did, and advance the step counter.
    return {
      conversation: [
        { role: 'model', text: JSON.stringify(action) },
        {
          role: 'user',
          text: `OBSERVATION:\n${resultText.slice(0, 9000)}${stagnation}\n\nContinue. Respond with the next JSON step (or finish).`,
        },
      ],
      pendingAction: null,
      step: state.step + 1,
    };
  }

  // ── Conditional edge: where to go after the agent node ────────────────────
  //   • done                    → END
  //   • has a real pendingAction → run it in the tools node
  //   • otherwise → loop back to the agent node so it thinks again.
  function routeAfterAgent(state) {
    if (state.done) return END;
    if (state.pendingAction && state.pendingAction.action) return 'tools';
    return 'agent';
  }

  const graph = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent, { tools: 'tools', agent: 'agent', [END]: END })
    .addEdge('tools', 'agent');

  return graph.compile();
}

/**
 * Run the agent loop via LangGraph and return the final answer.
 *
 * Drop-in replacement for the old inner `for` loop. The seeded `conversation`
 * (already containing the TASK turn + history) is passed in; the graph mutates
 * the shared `ctx` exactly as before, so deliverables collected by the tools
 * are available to the caller's finalize stage.
 *
 * @returns {Promise<{ finalMessage: string, steps: number }>}
 */
async function runGraphLoop(deps) {
  const { conversation } = deps;
  const maxSteps = clampBudget(deps.maxSteps, 270);
  const maxIterations = clampBudget(deps.maxIterations, 270);
  const app = buildAgentGraph({ ...deps, maxSteps, maxIterations });

  // LangGraph counts EVERY node visit toward the recursion limit. Each agent
  // step = up to 2 node visits (agent → tools), so budget 2× + a small margin
  // to faithfully preserve the old MAX_STEPS "thinking steps" semantics.
  const recursionLimit = (maxSteps * 2) + maxIterations + 8;

  let finalState;
  try {
    finalState = await app.invoke(
      { conversation, step: 0, iteration: 0, done: false, finalMessage: '', pendingAction: null },
      { recursionLimit },
    );
  } catch (e) {
    // Hitting the recursion limit (agent never called finish) is not fatal:
    // return whatever we have so deliverables still flow to the user.
    if (/recursion/i.test(e.message || '')) {
      return { finalMessage: '', steps: maxSteps };
    }
    throw e;
  }

  return {
    finalMessage: finalState.finalMessage || '',
    steps: (finalState.step || 0) + 1,
  };
}

module.exports = { buildAgentGraph, runGraphLoop, AgentState, clampBudget, AGENT_BUDGET_MAX };
