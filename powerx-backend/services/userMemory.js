'use strict';

// Per-user persistent memory that makes the agent smarter over time.
// Stores facts, solutions, and learned skills per user, survives restarts,
// and is loaded at the start of every conversation.
//
// Uses the existing `db.getSetting`/`db.setSetting` (Supabase app_settings table)
// so no new infra is needed. The agent never calls this directly — the server
// loads the memory on each user's message and injects it into the system prompt.

const crypto = require('crypto');
let db = null;
try { db = require('../db'); } catch (_) {}

const VERSION = 1;
const MAX_FACTS = 50;
const MAX_SOLUTIONS = 25;
const MAX_SKILLS = 15;
const MAX_TYPES = 20;

// ─── Key helpers ────────────────────────────────────────────────────────────

function memoryKey(userId) {
  const digest = crypto.createHash('sha256')
    .update(String(userId || 'anonymous'))
    .digest('hex')
    .slice(0, 32);
  return `agent_memory:v${VERSION}:${digest}`;
}

// Past solutions key — stores what worked for the user
function solutionsKey(userId) {
  const digest = crypto.createHash('sha256')
    .update(String(userId || 'anonymous') + ':solutions')
    .digest('hex')
    .slice(0, 32);
  return `agent_solutions:v${VERSION}:${digest}`;
}

// Learned skills key — custom capabilities the user taught the agent
function skillsKey(userId) {
  const digest = crypto.createHash('sha256')
    .update(String(userId || 'anonymous') + ':skills')
    .digest('hex')
    .slice(0, 32);
  return `agent_skills:v${VERSION}:${digest}`;
}

// ─── Empty templates ────────────────────────────────────────────────────────

function emptyMemory() {
  return {
    version: VERSION,
    totalInteractions: 0,
    facts: [],           // { key, value, learnedAt, source }
    preferences: {},     // { concise: 3, detailed: 1, ... }
    projects: {},        // { projectName: lastSeen, description }
    lastUpdated: null,
  };
}

function emptySolutions() {
  return { version: VERSION, solutions: [] };
}

function emptySkills() {
  return { version: VERSION, skills: [] };
}

// ─── Load / Save ────────────────────────────────────────────────────────────

async function loadMemory(userId) {
  if (!userId || !db || !db.getSetting) return emptyMemory();
  try {
    const raw = await db.getSetting(memoryKey(userId));
    if (!raw) return emptyMemory();
    const parsed = JSON.parse(raw);
    return {
      ...emptyMemory(),
      ...parsed,
      facts: Array.isArray(parsed?.facts) ? parsed.facts : [],
      preferences: (parsed && typeof parsed.preferences === 'object') ? parsed.preferences : {},
      projects: (parsed && typeof parsed.projects === 'object') ? parsed.projects : {},
    };
  } catch (_) { return emptyMemory(); }
}

async function saveMemory(userId, mem) {
  if (!userId || !db || !db.setSetting) return false;
  const safe = {
    version: VERSION,
    totalInteractions: Math.min(100000, Number(mem.totalInteractions || 0)),
    facts: (mem.facts || []).slice(0, MAX_FACTS),
    preferences: mem.preferences || {},
    projects: mem.projects || {},
    lastUpdated: new Date().toISOString(),
  };
  try {
    await db.setSetting(memoryKey(userId), JSON.stringify(safe));
    return true;
  } catch (_) { return false; }
}

async function loadSolutions(userId) {
  if (!userId || !db || !db.getSetting) return emptySolutions();
  try {
    const raw = await db.getSetting(solutionsKey(userId));
    if (!raw) return emptySolutions();
    const parsed = JSON.parse(raw);
    return { ...emptySolutions(), ...parsed, solutions: Array.isArray(parsed?.solutions) ? parsed.solutions : [] };
  } catch (_) { return emptySolutions(); }
}

async function saveSolutions(userId, sols) {
  if (!userId || !db || !db.setSetting) return false;
  try {
    await db.setSetting(solutionsKey(userId), JSON.stringify({
      version: VERSION,
      solutions: (sols.solutions || []).slice(0, MAX_SOLUTIONS),
    }));
    return true;
  } catch (_) { return false; }
}

async function loadSkills(userId) {
  if (!userId || !db || !db.getSetting) return emptySkills();
  try {
    const raw = await db.getSetting(skillsKey(userId));
    if (!raw) return emptySkills();
    const parsed = JSON.parse(raw);
    return { ...emptySkills(), ...parsed, skills: Array.isArray(parsed?.skills) ? parsed.skills : [] };
  } catch (_) { return emptySkills(); }
}

async function saveSkills(userId, skills) {
  if (!userId || !db || !db.setSetting) return false;
  try {
    await db.setSetting(skillsKey(userId), JSON.stringify({
      version: VERSION,
      skills: (skills.skills || []).slice(0, MAX_SKILLS),
    }));
    return true;
  } catch (_) { return false; }
}

// ─── Recording ──────────────────────────────────────────────────────────────

async function recordFact(userId, key, value, source = 'conversation') {
  const mem = await loadMemory(userId);
  // Remove duplicate fact with same key
  mem.facts = mem.facts.filter(f => f.key !== key);
  mem.facts.unshift({ key, value, learnedAt: new Date().toISOString(), source });
  // Keep max
  if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(0, MAX_FACTS);
  mem.totalInteractions = (mem.totalInteractions || 0) + 1;
  return saveMemory(userId, mem);
}

async function recordSolution(userId, category, problem, solution, worked = true) {
  const sols = await loadSolutions(userId);
  sols.solutions.unshift({
    id: crypto.randomBytes(4).toString('hex'),
    category,
    problem: String(problem).slice(0, 500),
    solution: String(solution).slice(0, 2000),
    worked,
    learnedAt: new Date().toISOString(),
  });
  if (sols.solutions.length > MAX_SOLUTIONS) sols.solutions = sols.solutions.slice(0, MAX_SOLUTIONS);
  return saveSolutions(userId, sols);
}

async function recordSkill(userId, name, description, trigger, commands) {
  const skills = await loadSkills(userId);
  // Remove duplicate skill with same name
  skills.skills = skills.skills.filter(s => s.name !== name);
  skills.skills.unshift({
    name,
    description: String(description).slice(0, 500),
    trigger: String(trigger).slice(0, 200),
    commands: String(commands || '').slice(0, 3000),
    learnedAt: new Date().toISOString(),
  });
  if (skills.skills.length > MAX_SKILLS) skills.skills = skills.skills.slice(0, MAX_SKILLS);
  return saveSkills(userId, skills);
}

async function recordProject(userId, projectName, description) {
  const mem = await loadMemory(userId);
  if (!mem.projects) mem.projects = {};
  mem.projects[String(projectName).slice(0, 100)] = {
    description: String(description || '').slice(0, 500),
    lastSeen: new Date().toISOString(),
  };
  // Keep only recent projects
  const entries = Object.entries(mem.projects)
    .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen))
    .slice(0, MAX_TYPES);
  mem.projects = {};
  for (const [k, v] of entries) mem.projects[k] = v;
  return saveMemory(userId, mem);
}

// ─── Building the context string for the agent ──────────────────────────────

async function buildContext(userId) {
  const mem = await loadMemory(userId);
  const sols = await loadSolutions(userId);
  const skills = await loadSkills(userId);

  const parts = [];

  // Facts about the user
  if (mem.facts && mem.facts.length > 0) {
    const factLines = mem.facts.slice(0, 10).map(f =>
      `- ${f.key}: ${String(f.value).slice(0, 200)}`
    );
    parts.push('## USER MEMORY (facts I have learned about this user)');
    parts.push(factLines.join('\n'));
  }

  // Past solutions (what worked before)
  if (sols.solutions && sols.solutions.length > 0) {
    const solLines = sols.solutions.slice(0, 5).map(s =>
      `- [${s.category}] ${String(s.problem).slice(0, 150)}`
    );
    parts.push('## PAST SOLUTIONS (what worked for this user before)');
    parts.push(solLines.join('\n'));
  }

  // Learned skills
  if (skills.skills && skills.skills.length > 0) {
    const skillLines = skills.skills.slice(0, 5).map(s =>
      `- ${s.name}: ${String(s.description).slice(0, 200)}`
    );
    parts.push('## LEARNED SKILLS (things the user taught me)');
    parts.push(skillLines.join('\n'));
  }

  // Projects
  if (mem.projects && Object.keys(mem.projects).length > 0) {
    const projLines = Object.entries(mem.projects).slice(0, 5).map(([name, info]) =>
      `- ${name}: ${String(info.description || '').slice(0, 150)}`
    );
    parts.push('## USER PROJECTS');
    parts.push(projLines.join('\n'));
  }

  return parts.join('\n\n');
}

// ─── Auto-detect and record from conversation ───────────────────────────────

async function autoRecord(userId, userMessage, agentResponse, outcome = {}) {
  if (!userId) return false;
  const msg = String(userMessage || '');
  const resp = String(agentResponse || '');

  // Record user preferences
  const mem = await loadMemory(userId);
  mem.totalInteractions = (mem.totalInteractions || 0) + 1;

  // Detect preferences from message
  if (/concise|brief|short/i.test(msg)) {
    mem.preferences.concise = (mem.preferences.concise || 0) + 1;
  }
  if (/detailed|explain|step by step|thorough/i.test(msg)) {
    mem.preferences.detailed = (mem.preferences.detailed || 0) + 1;
  }
  if (/deploy|push|ship|publish/i.test(msg)) {
    mem.preferences.direct_delivery = (mem.preferences.direct_delivery || 0) + 1;
  }
  if (/test|verify|validate|check/i.test(msg)) {
    mem.preferences.test_first = (mem.preferences.test_first || 0) + 1;
  }
  if (/don'?t break|do not break|production|enterprise|careful/i.test(msg)) {
    mem.preferences.production_safe = (mem.preferences.production_safe || 0) + 1;
  }

  // Detect project names
  const projectMatches = msg.match(/(?:repo|project|app)\s+(\S+)/gi);
  if (projectMatches) {
    for (const m of projectMatches) {
      const name = m.replace(/^(?:repo|project|app)\s+/i, '');
      mem.projects[name] = {
        description: '',
        lastSeen: new Date().toISOString(),
      };
    }
  }

  await saveMemory(userId, mem);

  // If outcome mentions a successful solution, record it
  if (outcome.success && outcome.category) {
    await recordSolution(userId, outcome.category, outcome.problem || msg, outcome.solution || resp, true);
  }

  // If user explicitly teaches something ("remember this" / "when I say X, do Y")
  if (/remember|learn|save this|when I say|when i ask/i.test(msg)) {
    const factMatch = msg.match(/remember\s*(?:that\s*)?(.+?)(?:\.|$)/i);
    if (factMatch) {
      await recordFact(userId, 'user_instruction', factMatch[1].trim());
    }
  }

  return true;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  loadMemory, saveMemory,
  loadSolutions, saveSolutions,
  loadSkills, saveSkills,
  recordFact, recordSolution, recordSkill, recordProject,
  buildContext, autoRecord,
  memoryKey, solutionsKey, skillsKey,
};