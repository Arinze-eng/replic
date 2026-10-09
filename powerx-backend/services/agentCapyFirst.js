// ─────────────────────────────────────────────────────────────────────────────
// services/agentCapyFirst.js — "Capy first" wrapper for the WormGPT agent loop.
//
// The APK's primary agent endpoint (/api/agent/run) and the durable job resume
// path both drive `agentEngine.runAgent`. The project spec requires that for
// ANY task the user gives, **Capy.ai runs FIRST and is polled** (it owns its own
// cloud sandbox and returns files of any type), and ONLY if Capy fails / times
// out / blocks / returns nothing usable do we fall back to the existing engine
// (sandboxAgent → host loop → brain). This wrapper implements exactly that
// without changing the SSE contract the shipped APK depends on:
//
//   runAgent-compatible result:  { message, files:[{path,name,mime}], steps, workdir }
//
// Capy's deliverables come back as in-memory buffers; we materialise them into a
// temp workdir so the SAME `packageAgentFiles` hosting + base64 back-compat path
// works unchanged. The workdir is returned so the caller cleans it up.
//
// Capy is tried only when it is BOTH configured AND enabled as the head
// (capy_head / CAPY_HEAD). When off, this wrapper is a transparent pass-through
// to the real engine — so the enterprise behaviour is never altered unless the
// admin/env turns Capy on (which is already the case in production).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const stemSolutionPublisher = require('./stemSolutionPublisher');
const attachmentText = require('./attachmentText');
const os = require('os');
const path = require('path');

let capy = null;
try { capy = require('./capy'); } catch (_) { capy = null; }

// Long-poll ceiling for the AGENT path. The async /api/capy job uses the full
// admin-settable ceiling; here we resolve THE SAME admin-settable value at
// call-time (capy.getCeilingMs(): capy_timeout_ms → CAPY_POLL_CEILING_MS → 30m
// default) so "poll any task for a long time" — and the admin's chosen timeout —
// holds for the APK agent too, including brand-new Capy sessions. Detached from
// the HTTP request (the engine runs via runAgentJob), so it is NOT bound by the
// gateway. The constants below are only the LAST-RESORT fallback if the runtime
// lookup ever fails.
const AGENT_CEILING_FALLBACK_MS = parseInt(
  process.env.CAPY_AGENT_CEILING_MS || process.env.CAPY_POLL_CEILING_MS || String(30 * 60 * 1000),
  10,
);
const AGENT_INTERVAL_MS = parseInt(
  process.env.CAPY_AGENT_INTERVAL_MS || process.env.CAPY_POLL_INTERVAL_MS || '6000',
  10,
);

// Resolve the effective Capy ceiling at call-time (admin-settable, no redeploy).
async function _resolveAgentCeilingMs() {
  try {
    if (capy && typeof capy.getCeilingMs === 'function') {
      const ms = await capy.getCeilingMs();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  } catch (_) { /* fall through to env/default */ }
  return AGENT_CEILING_FALLBACK_MS;
}

function sanitizeName(name, idx) {
  let n = String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!n) n = `capy_file_${idx || 0}`;
  return n;
}

// Write Capy's in-memory file buffers to a temp workdir and return the
// runAgent-shaped file list ({ path, name, mime }).
function materialiseFiles(capyFiles) {
  const files = [];
  let workdir = null;
  if (Array.isArray(capyFiles) && capyFiles.length) {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capyagent_'));
    capyFiles.forEach((f, i) => {
      if (!f || !f.buffer || !Buffer.isBuffer(f.buffer) || !f.buffer.length) return;
      const name = sanitizeName(f.name, i);
      const p = path.join(workdir, `${Date.now()}_${i}_${name}`);
      try {
        fs.writeFileSync(p, f.buffer);
        files.push({ path: p, name, mime: f.mime || undefined });
      } catch (_) { /* skip unwritable file */ }
    });
  }
  return { files, workdir };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🛟 SAFE FALLBACK — guarantee the in-house engine ALWAYS returns a deliverable.
//
// Symptom this fixes ("after Capy starts, nothing — no fallback finishes the
// task"): when Capy is the head, runs, and then yields nothing (or errors), the
// wrapper hands the task to `fallbackRun` (agentEngine.runAgent = the racers:
// sandbox → DeepSeek → HotBot → Gemini). If THAT engine itself throws, the raw
// exception used to bubble all the way out of runAgentCapyFirst, so the bot's
// outer catch printed a generic "❌ Task failed" with NO answer — the task never
// "finished". WhatsApp only *appeared* to work because its fallback usually
// succeeded; on Telegram a heavier task after a long Capy poll would surface the
// bare failure. Wrapping the fallback here means the caller ALWAYS gets a
// result object it can deliver, so both channels behave identically: Capy first,
// then the racers, and if everything fails the user still gets a clear final
// message instead of silence. Never throws.
async function _safeFallback(opts, fallbackRun, onStep) {
  if (opts && opts.signal && opts.signal.aborted) {
    return { message: '🛑 Task stopped.', files: [], steps: 0, workdir: null, brain: 'stopped', stopped: true };
  }
  try {
    const out = await fallbackRun(opts);
    // Normalise: the engine should return { message, files, steps, workdir, brain },
    // but guard against an empty/undefined result so we never deliver "nothing".
    if (out && (String(out.message || '').trim() || (Array.isArray(out.files) && out.files.length))) {
      return out;
    }
    // Fallback engine returned nothing usable — still finish the task with a
    // clear message rather than leaving the user hanging.
    try { onStep('🤖 The in-house agent finished but produced no output — returning a status so the task always completes.'); } catch (_) {}
    return {
      message: (out && String(out.message || '').trim())
        ? out.message
        : '🤖 I worked on your task but could not produce a final answer this time. Please try rephrasing it or send it again.',
      files: (out && Array.isArray(out.files)) ? out.files : [],
      steps: (out && out.steps) || 0,
      workdir: (out && out.workdir) || null,
      brain: (out && out.brain) || 'agent',
    };
  } catch (e) {
    // The in-house engine itself threw. Do NOT let this bubble out as a bare
    // exception (which the bot would show as "❌ Task failed" with no answer).
    // Return a deliverable error message so the task always finishes cleanly.
    const msg = (e && e.message ? e.message : String(e || 'error'));
    try { onStep('🤖 The in-house agent hit an error (' + msg.slice(0, 120) + ') — returning a clear message so the task still completes.'); } catch (_) {}
    return {
      message: '🤖 Sorry — I could not complete this task right now (' + msg.slice(0, 200) + '). ' +
        'Please try again in a moment.',
      files: [],
      steps: 0,
      workdir: null,
      brain: 'agent-error',
    };
  }
}

/**
 * Should Capy run first for this task? True only when Capy is configured AND
 * enabled as the head. Never throws.
 */
async function shouldUseCapy() {
  if (!capy) return false;
  try {
    const head = await capy.isHeadEnabled();
    if (!head) return false;
    const key = await capy.getKey();
    return !!key;
  } catch (_) { return false; }
}

/**
 * runAgent-compatible entry point. Tries Capy FIRST; on any failure / empty /
 * timeout / blocked result, falls back to `fallbackRun` (the real engine).
 *
 * @param {object} opts  the SAME opts passed to agentEngine.runAgent
 *                       ({ task, attachments, history, onStep, onEvent, sessionKey, systemPrompt })
 * @param {function} fallbackRun  the real engine fn (agentEngine.runAgent)
 * @returns {Promise<{message, files, steps, workdir, brain}>}
 */
async function runAgentCapyFirst(opts, fallbackRun) {
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const task = String(opts.task || '').trim();
  const isStopped = () => !!(opts && opts.signal && opts.signal.aborted);

  // Extract attachment text BEFORE handing control to any cloud agent. Capy
  // previously received only public URLs and could hang downloading them or
  // answer without ever reading them. Deterministic text is now supplied
  // directly to every model and carried into the in-house fallback unchanged.
  let preExtractedContext = String(opts.preExtractedAttachmentContext || '');
  if (!preExtractedContext && Array.isArray(opts.attachments) && opts.attachments.length) {
    try {
      const pre = await attachmentText.extractAttachments(opts.attachments, { onStep });
      preExtractedContext = pre.context || '';
      opts = { ...opts, preExtractedAttachmentContext: preExtractedContext };
    } catch (_) { /* existing file/tool paths remain available */ }
  }
  const taskWithExtractedText = preExtractedContext
    ? `${task}\n\n=== PRE-EXTRACTED ATTACHMENT CONTENT (read this directly; do not wait for another extractor) ===\n${preExtractedContext}\n=== END PRE-EXTRACTED ATTACHMENT CONTENT ===`
    : task;

  // 📵 CHANNEL-SCOPED KILL-SWITCH: Capy OFF for Telegram ONLY (admin toggle).
  // When the caller is the WormGPT Telegram bot (opts.source === 'telegram') AND
  // the admin has turned "Capy off for Telegram" ON, we bypass Capy ENTIRELY for
  // this task and hand it straight to the in-house engine — regardless of
  // capy_head or capy_only. Web/APK are unaffected (they don't pass this source),
  // so they keep using Capy exactly as before. Server-side only → no APK rebuild.
  if (String(opts.source || '').toLowerCase() === 'telegram' && capy &&
      typeof capy.isCapyDisabledForTelegram === 'function') {
    let tgOff = false;
    try { tgOff = await capy.isCapyDisabledForTelegram(); } catch (_) { tgOff = false; }
    if (tgOff) {
      onStep('📵 Capy is turned OFF for Telegram by the admin — using the in-house agent for this task…');
      return await _safeFallback(opts, fallbackRun, onStep);
    }
  }

  // 📵 CHANNEL-SCOPED TOGGLE: Capy on/off for WhatsApp ONLY (admin toggle).
  // When the caller is the WormGPT WhatsApp bot (opts.source === 'whatsapp') AND
  // the admin has turned "Capy off for WhatsApp" ON, bypass Capy ENTIRELY for
  // this task and hand it straight to the in-house engine — regardless of
  // capy_head or capy_only. Web/APK/Telegram are unaffected. Server-side only →
  // no APK rebuild. Default OFF, so WhatsApp keeps using Capy-first unless flipped.
  if (String(opts.source || '').toLowerCase() === 'whatsapp' && capy &&
      typeof capy.isCapyDisabledForWhatsapp === 'function') {
    let waOff = false;
    try { waOff = await capy.isCapyDisabledForWhatsapp(); } catch (_) { waOff = false; }
    if (waOff) {
      onStep('📵 Capy is turned OFF for WhatsApp by the admin — using the in-house agent for this task…');
      return await _safeFallback(opts, fallbackRun, onStep);
    }
  }

  const useCapy = await shouldUseCapy();
  // 🧠 CAPY-ONLY MODE (admin toggle). When ON, we must NOT fall back to the
  // other brains / in-house engine if Capy fails — ONLY Capy may answer. We
  // resolve it once here (best-effort; defaults OFF so behaviour is unchanged).
  let capyOnly = false;
  try { if (capy && typeof capy.isCapyOnly === 'function') capyOnly = await capy.isCapyOnly(); } catch (_) { capyOnly = false; }

  if (useCapy && task) {
    try {
      // Resolve the admin-settable ceiling for THIS task (new sessions included).
      const agentCeilingMs = await _resolveAgentCeilingMs();
      onStep('🦫 Capy is taking this task first (its own cloud sandbox; polling up to ' +
        Math.round(agentCeilingMs / 60000) + ' min)…');

      // Make user-attached files VISIBLE to Capy. Capy reads attachmentUrls over
      // the internet, so local upload buffers must first be hosted on a public,
      // no-auth file host. Upload them (best-effort) and pass the direct URLs.
      // On any upload failure we still proceed and the engine fallback below
      // receives the raw buffers, so nothing breaks.
      const attachmentUrls = Array.isArray(opts.attachmentUrls) ? opts.attachmentUrls.slice() : [];
      let attachNote = '';
      const bufAttachments = (Array.isArray(opts.attachments) ? opts.attachments : [])
        .filter(a => a && a.buffer && Buffer.isBuffer(a.buffer) && a.buffer.length);
      // 🆕 Does THIS turn ship a freshly-attached file? Track it so we can (a)
      // always tell Capy to focus on the NEW file and (b) if we ultimately fail
      // to make ANY new file visible to Capy, defer to the in-house engine that
      // CAN read the raw buffer — never let Capy answer the NEW file request out
      // of stale carry-over memory (the "capy doesn't pick the new file" bug).
      const hasNewFilesThisTurn = bufAttachments.length > 0 || (Array.isArray(opts.attachmentUrls) && opts.attachmentUrls.length > 0);
      let hostedCount = (Array.isArray(opts.attachmentUrls) ? opts.attachmentUrls.length : 0);
      if (bufAttachments.length && capy && typeof capy.uploadBuffersToPublic === 'function') {
        try {
          onStep(`📎 Hosting ${bufAttachments.length} attached file(s) so Capy can read them…`);
          const hosted = await capy.uploadBuffersToPublic(
            bufAttachments.map(a => ({ name: a.name, buffer: a.buffer, mime: a.mime })),
            { onStep: (s) => { try { onStep(String(s)); } catch (_) {} }, max: 8, userId: opts.sessionKey || opts.userId }
          );
          for (const h of hosted) if (h && h.url) { attachmentUrls.push(h.url); hostedCount++; }
          if (hosted.length) {
            // 🆕 Flag these as the NEW files for THIS turn and tell Capy to focus
            // on them (not any file from an earlier turn). This, together with
            // the buildPrompt/preamble directives in capy.js, fixes "a new file
            // comes in but it still talks about the previous file".
            attachNote =
              '\n\n🆕 The user JUST attached ' + hosted.length + ' NEW file(s) for THIS request, ' +
              'provided as attachmentUrls (download and analyse THESE — they are the ' +
              'subject of this message; ignore any file from earlier turns unless ' +
              'explicitly asked): ' +
              hosted.map(h => `${h.name} → ${h.url}`).join(' ; ') + '.';
          }
          if (hosted.length < bufAttachments.length) {
            onStep(`📎 Hosted ${hosted.length}/${bufAttachments.length} file(s) for Capy.`);
          }
        } catch (e) {
          onStep('📎 Attachment hosting failed (' + (e && e.message ? e.message.slice(0, 80) : 'error') + ') — continuing.');
        }
      }

      // 🆕 CRITICAL FIX — never answer a NEW-file request from stale memory.
      // If the user attached a file THIS turn but we could NOT make ANY file
      // visible to Capy (all public hosts failed), Capy would otherwise reply
      // about the PREVIOUS task from carry-over memory. In that case, skip Capy
      // and hand the task (WITH the raw buffers) to the in-house engine, which
      // reads the buffers directly — so the new file is always processed.
      if (hasNewFilesThisTurn && hostedCount === 0) {
        if (capyOnly) {
          onStep('🦫 Could not make the new file visible to Capy and Capy-only mode is ON — cannot process the attachment right now.');
          return {
            message: '🦫 I received your file but could not make it available to Capy (the only enabled brain) right now. ' +
              'Please try re-sending it in a moment, or an admin can turn Capy-only mode off in the panel so the backup engine (which reads the file directly) can handle it.',
            files: [],
            steps: 0,
            workdir: null,
            brain: 'capy-only',
          };
        }
        onStep('📎 Could not host the new file for Capy — handing this task (with the file) to the in-house agent so your NEW file is processed…');
        return await _safeFallback(opts, fallbackRun, onStep);
      }

      // 🆕 Even when hosting succeeded, guarantee the new-file focus directive is
      // present so Capy never drifts back to a previous file/task.
      if (hasNewFilesThisTurn && hostedCount > 0 && !attachNote) {
        attachNote =
          '\n\n🆕 The user JUST provided ' + hostedCount + ' NEW file(s) for THIS request via attachmentUrls — ' +
          'download and analyse THOSE. This new file is the subject of this message; do NOT reuse or ' +
          'refer to any file from an earlier turn unless the user explicitly asks.';
      }

      const stemInstruction = stemSolutionPublisher.classifyTask(task).publish
        ? '\n\n' + stemSolutionPublisher.SYSTEM_PROMPT_CONTRACT
        : '';
      const out = await capy.runForSession(
        {
          message: taskWithExtractedText + attachNote + stemInstruction,
          attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
          // 🧠 Per-account memory: same account (sessionKey) → same Capy thread
          // (continuous memory); a different account → its own thread. When no
          // sessionKey is present, runForSession behaves exactly like run().
          sessionKey: opts.sessionKey || undefined,
        },
        {
          ceilingMs: agentCeilingMs,
          intervalMs: AGENT_INTERVAL_MS,
          signal: opts.signal,
          onStep: (s) => { try { onStep(String(s)); } catch (_) {} },
        },
      );

      if (isStopped()) return { message: '🛑 Task stopped.', files: [], steps: 0, workdir: null, brain: 'stopped', stopped: true };
      const reply = (out && out.reply ? String(out.reply) : '').trim();
      const capyFiles = (out && Array.isArray(out.files)) ? out.files : [];

      if (reply || capyFiles.length) {
        const { files, workdir } = materialiseFiles(capyFiles);
        onStep(`🦫 Capy finished (files: ${files.length}).`);
        return await stemSolutionPublisher.postProcessResult(opts, {
          message: reply || '✅ Task complete (Capy).',
          files,
          steps: 0,
          workdir,
          brain: 'capy',
        });
      }
      // Capy produced nothing usable.
      if (capyOnly) {
        // 🧠 CAPY-ONLY MODE: do NOT fall back to the other brains. Return a
        // clear Capy message so the user knows Capy (the only allowed brain)
        // couldn't complete this one — the enterprise flow never silently
        // switches to another engine.
        onStep('🦫 Capy returned nothing usable — Capy-only mode is ON, so no other brain is used.');
        return {
          message: '🦫 Capy is the only brain enabled right now and it could not complete this task. ' +
            'Please try again in a moment, or an admin can turn Capy-only mode off in the panel to allow the backup brains.',
          files: [],
          steps: 0,
          workdir: null,
          brain: 'capy-only',
        };
      }
      onStep('🦫 Capy returned nothing usable — falling back to the in-house agent…');
    } catch (e) {
      // A user stop is final: never interpret cancellation as provider failure
      // and never start the fallback engine after /stop.
      if (isStopped() || /Capy run aborted/i.test(String(e && e.message || ''))) {
        return { message: '🛑 Task stopped.', files: [], steps: 0, workdir: null, brain: 'stopped', stopped: true };
      }
      // Capy failed / timed out / errored.
      if (capyOnly) {
        onStep('🦫 Capy failed — Capy-only mode is ON, so no other brain is used.');
        return {
          message: '🦫 Capy is the only brain enabled right now and it hit an error (' +
            (e && e.message ? e.message.slice(0, 140) : 'error') + '). ' +
            'Please try again shortly, or an admin can turn Capy-only mode off in the panel to allow the backup brains.',
          files: [],
          steps: 0,
          workdir: null,
          brain: 'capy-only',
        };
      }
      onStep('🦫 Capy unavailable (' + (e && e.message ? e.message.slice(0, 140) : 'error') +
        ') — falling back to the in-house agent…');
    }
  } else if (capyOnly && task) {
    // Capy-only mode is ON but Capy isn't usable as the head (disabled / no key).
    // Do NOT fall through to the other brains — tell the user Capy must be set up.
    onStep('🦫 Capy-only mode is ON but Capy is not enabled/configured as the head.');
    return {
      message: '🦫 Capy-only mode is ON, but Capy is not currently enabled or configured. ' +
        'An admin needs to enable Capy (and set its API key) in the panel, or turn Capy-only mode off to use the backup brains.',
      files: [],
      steps: 0,
      workdir: null,
      brain: 'capy-only',
    };
  }

  // Fallback: the real engine (sandboxAgent → host loop → brain). Wrapped so a
  // fallback error never leaves the user with silence — the task ALWAYS finishes
  // with a deliverable message (fixes "after Capy starts, nothing finishes").
  return await _safeFallback(opts, fallbackRun, onStep);
}

module.exports = {
  runAgentCapyFirst,
  shouldUseCapy,
  // Back-compat alias: the ceiling is now resolved at call-time, but keep the
  // export so any external require doesn't break. Reflects the fallback value.
  AGENT_CEILING_MS: AGENT_CEILING_FALLBACK_MS,
  AGENT_CEILING_FALLBACK_MS,
  AGENT_INTERVAL_MS,
};
