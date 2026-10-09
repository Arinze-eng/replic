'use strict';

// Runs one bot-agent stage with a resettable inactivity deadline. The deadline
// measures real engine progress (touch()), not total task duration, so legitimate
// long jobs can keep running while a wedged provider/sandbox is aborted and the
// caller can move to its fallback instead of sending reassurance forever.
class BotRunStalledError extends Error {
  constructor(ms, label) {
    super(`${label || 'Agent stage'} produced no progress for ${Math.round(ms / 1000)}s`);
    this.name = 'BotRunStalledError';
    this.code = 'BOT_RUN_STALLED';
    this.stallMs = ms;
  }
}

function positiveMs(value, fallback) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {(ctx:{signal:AbortSignal,touch:Function})=>Promise<any>} run
 * @param {{signal?:AbortSignal,idleMs?:number,label?:string,onStall?:Function}} opts
 */
async function runWithIdleGuard(run, opts = {}) {
  const idleMs = positiveMs(opts.idleMs, 3 * 60 * 1000);
  const child = new AbortController();
  let lastActivity = Date.now();
  let timer = null;
  let settled = false;

  const touch = () => { lastActivity = Date.now(); };
  const abortFromParent = () => {
    if (!child.signal.aborted) child.abort(opts.signal && opts.signal.reason);
  };
  if (opts.signal) {
    if (opts.signal.aborted) abortFromParent();
    else opts.signal.addEventListener('abort', abortFromParent, { once: true });
  }

  const guarded = Promise.resolve().then(() => run({ signal: child.signal, touch }));
  const stalled = new Promise((_, reject) => {
    const checkEvery = Math.max(250, Math.min(5000, Math.floor(idleMs / 4)));
    timer = setInterval(() => {
      if (settled || child.signal.aborted) return;
      if (Date.now() - lastActivity < idleMs) return;
      const error = new BotRunStalledError(idleMs, opts.label);
      // Settle the guard first, then notify/abort the provider. Some providers
      // synchronously resolve a "stopped" result from an abort event; rejecting
      // first guarantees the caller sees a stall and starts its fallback.
      reject(error);
      try { if (typeof opts.onStall === 'function') opts.onStall(error); } catch (_) {}
      if (!child.signal.aborted) child.abort(error);
    }, checkEvery);
    if (timer && timer.unref) timer.unref();
  });

  try {
    return await Promise.race([guarded, stalled]);
  } finally {
    settled = true;
    if (timer) clearInterval(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', abortFromParent);
    // Observe a late rejection from an aborted provider so it cannot become an
    // unhandled rejection after the fallback has already started.
    guarded.catch(() => {});
  }
}

module.exports = { BotRunStalledError, runWithIdleGuard, positiveMs };
