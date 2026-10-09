'use strict';

// Privacy-preserving, bounded online adaptation for the agent.
// Profiles are isolated per opaque session scope, stored in the existing
// app_settings KV store, and contain only compact behavioural preferences and
// aggregate outcomes — never raw prompts, credentials, or file contents.
const crypto = require('crypto');
let db = null;
try { db = require('../db'); } catch (_) {}

const VERSION = 1;
const MAX_SIGNALS = 16;
const MAX_EVENTS = 40;

function profileKey(scope) {
  const digest = crypto.createHash('sha256').update(String(scope || 'anonymous')).digest('hex').slice(0, 32);
  return `agent_adaptation:v${VERSION}:${digest}`;
}

function emptyProfile() {
  return {
    version: VERSION,
    interactions: 0,
    successful: 0,
    preferences: {},
    taskTypes: {},
    lastUpdated: null,
  };
}

function boundedInc(obj, key, amount = 1) {
  if (!key) return;
  obj[key] = Math.max(-MAX_EVENTS, Math.min(MAX_EVENTS, Number(obj[key] || 0) + amount));
  const entries = Object.entries(obj).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, MAX_SIGNALS);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k] = v;
}

async function load(scope) {
  if (!scope || !db || !db.getSetting) return emptyProfile();
  try {
    const raw = await db.getSetting(profileKey(scope));
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw);
    return {
      ...emptyProfile(),
      ...parsed,
      preferences: parsed && typeof parsed.preferences === 'object' ? parsed.preferences : {},
      taskTypes: parsed && typeof parsed.taskTypes === 'object' ? parsed.taskTypes : {},
    };
  } catch (_) { return emptyProfile(); }
}

async function save(scope, profile) {
  if (!scope || !db || !db.setSetting) return false;
  const safe = {
    version: VERSION,
    interactions: Math.min(100000, Number(profile.interactions || 0)),
    successful: Math.min(100000, Number(profile.successful || 0)),
    preferences: profile.preferences || {},
    taskTypes: profile.taskTypes || {},
    lastUpdated: new Date().toISOString(),
  };
  try {
    await db.setSetting(profileKey(scope), JSON.stringify(safe));
    return true;
  } catch (_) { return false; }
}

function inferSignals(text) {
  const s = String(text || '');
  const out = { preferences: [], taskTypes: [] };
  const prefRules = [
    ['concise', /\b(concise|brief|short answer|no explanation)\b/i],
    ['detailed', /\b(detailed|thorough|explain|step[- ]by[- ]step)\b/i],
    ['autonomous', /\b(don'?t ask|do not ask|just do it|proceed|autonomous)\b/i],
    ['test_first', /\b(test|verify|validation|analy[sz]er|lint|build)\b/i],
    ['production_safe', /\b(production|enterprise|don'?t break|do not break|backward compatible)\b/i],
    ['direct_delivery', /\b(deploy|push|ship|publish)\b/i],
  ];
  const typeRules = [
    ['coding', /\b(code|repo|repository|bug|implement|refactor|dart|flutter|javascript|python|api)\b/i],
    ['deployment', /\b(deploy|render|cloudflare|release|production)\b/i],
    ['research', /\b(research|search|investigate|compare)\b/i],
    ['document', /\b(report|document|pdf|docx|spreadsheet|presentation)\b/i],
  ];
  for (const [name, re] of prefRules) if (re.test(s)) out.preferences.push(name);
  for (const [name, re] of typeRules) if (re.test(s)) out.taskTypes.push(name);
  return out;
}

function topPositive(obj, limit) {
  return Object.entries(obj || {}).filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
}

function context(profile) {
  if (!profile || !profile.interactions) return '';
  const prefs = topPositive(profile.preferences, 5);
  const tasks = topPositive(profile.taskTypes, 3);
  if (!prefs.length && !tasks.length) return '';
  const guidance = {
    concise: 'Keep progress and the final answer concise.',
    detailed: 'Include implementation detail when it improves correctness.',
    autonomous: 'Use reasonable defaults and avoid non-blocking questions.',
    test_first: 'Prefer executable validation and inspect failures before finishing.',
    production_safe: 'Preserve compatibility, isolation, and rollback safety.',
    direct_delivery: 'When authorized, carry work through verification and delivery.',
  };
  const lines = prefs.map(p => guidance[p]).filter(Boolean);
  return [
    'PER-USER ADAPTATION (learned behavioural signals; lower priority than safety and the current request):',
    ...lines.map(x => `- ${x}`),
    tasks.length ? `- Likely recurring work areas: ${tasks.join(', ')}. Prepare the most relevant checks proactively.` : '',
    '- Treat these as predictions, not facts; the current request always wins.',
  ].filter(Boolean).join('\n');
}

async function prepare(scope, task) {
  const profile = await load(scope);
  const signals = inferSignals(task);
  return { profile, signals, context: context(profile) };
}

async function learn(scope, prepared, outcome = {}) {
  if (!scope) return false;
  const profile = prepared && prepared.profile ? prepared.profile : await load(scope);
  const signals = prepared && prepared.signals ? prepared.signals : inferSignals(outcome.task || '');
  profile.interactions = Number(profile.interactions || 0) + 1;
  const success = outcome.success !== false;
  if (success) profile.successful = Number(profile.successful || 0) + 1;
  const weight = success ? 1 : -1;
  for (const p of signals.preferences || []) boundedInc(profile.preferences, p, weight);
  for (const t of signals.taskTypes || []) boundedInc(profile.taskTypes, t, weight);
  return save(scope, profile);
}

module.exports = { profileKey, inferSignals, context, prepare, learn, load };
