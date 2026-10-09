'use strict';

// Runtime autonomy controls. Values live in the existing app_settings store so
// admins can tune long-running agents without a deploy. Environment variables
// remain useful for isolated workers/tests, but the database setting wins.
let db = null;
try { db = require('../db'); } catch (_) {}

const SETTING_KEY = 'agent_max_steps';
const LEGACY_SETTING_KEYS = Object.freeze(['agent_max_iterations', 'agent_max_tool_steps']);
const DEFAULTS = Object.freeze({
  agent_max_steps: 270,
  // Kept as exported aliases for older callers/tests. Runtime resolution uses
  // one global value for both budgets so the admin control is unambiguous.
  agent_max_iterations: 270,
  agent_max_tool_steps: 270,
});
const HARD_MAX = 1000;
const MIN = 1;

function clamp(value, fallback) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN, Math.min(HARD_MAX, n));
}

async function firstStoredValue(keys) {
  if (!db || !db.getSetting) return null;
  for (const key of keys) {
    try {
      const raw = await db.getSetting(key);
      if (raw != null && String(raw).trim() !== '') return raw;
    } catch (_) {
      // A transient settings-store failure must not prevent an AI task from
      // starting; continue to the env/default fallback below.
    }
  }
  return null;
}

async function resolve() {
  // The canonical DB setting wins globally. Legacy keys are read only when the
  // canonical value has never been saved, preserving existing installations.
  const envRaw = process.env.AGENT_MAX_ITERATIONS || process.env.AGENT_MAX_STEPS;
  const fallback = clamp(envRaw, DEFAULTS.agent_max_steps);
  const raw = await firstStoredValue([SETTING_KEY, ...LEGACY_SETTING_KEYS]);
  const maxSteps = clamp(raw, fallback);
  return {
    maxSteps,
    maxIterations: maxSteps,
    maxToolSteps: maxSteps,
  };
}

module.exports = {
  SETTING_KEY,
  LEGACY_SETTING_KEYS,
  DEFAULTS,
  HARD_MAX,
  MIN,
  clamp,
  resolve,
};
