#!/usr/bin/env node
/**
 * install-cowhub-skills.js
 * Fetches the full CowAgent Skill Hub catalog (skills.cowagent.ai) and installs
 * every skill's SKILL.md (plus any extra files) into
 *   .codebanana/.skills/cowagent-hub/<name>/...
 * Then regenerates prompts/skills_index.md so the WormGPT agent's system prompt
 * knows about EVERY skill and (per SKILL-FIRST DOCTRINE) loads the right one
 * before acting.
 *
 * Idempotent: safe to re-run. Skips files that already match.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HUB = 'https://skills.cowagent.ai';
const ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = path.join(ROOT, '.codebanana', '.skills');
const HUB_DIR = path.join(SKILLS_ROOT, 'cowagent-hub');
const INDEX_FILE = path.join(ROOT, 'prompts', 'skills_index.md');

async function getJSON(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function frontMatterMeta(md) {
  let name = '', desc = '';
  const ym = md.match(/^---\n([\s\S]*?)\n---/);
  if (ym) {
    const nm = ym[1].match(/name:\s*(.+)/); if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    const dm = ym[1].match(/description:\s*([\s\S]*?)(\n[a-z_]+:|$)/);
    if (dm) desc = dm[1].replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  }
  return { name, desc };
}

async function fetchAllSkills() {
  const all = [];
  let page = 1;
  const limit = 50;
  while (true) {
    const data = await getJSON(`${HUB}/api/skills?limit=${limit}&page=${page}`);
    const batch = data.skills || [];
    all.push(...batch);
    const total = data.total || all.length;
    if (all.length >= total || batch.length === 0) break;
    page++;
  }
  // De-dup by name
  const seen = new Set();
  return all.filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true; });
}

async function fetchFiles(name) {
  try {
    const data = await getJSON(`${HUB}/api/skills/${encodeURIComponent(name)}/files`);
    return data.files || [];
  } catch (e) {
    return [];
  }
}

async function main() {
  ensureDir(HUB_DIR);
  console.log('[cowhub] Fetching catalog from', HUB);
  const skills = await fetchAllSkills();
  console.log(`[cowhub] Catalog: ${skills.length} skills`);

  const installed = [];
  for (const s of skills) {
    const dir = path.join(HUB_DIR, s.name);
    ensureDir(dir);
    const files = await fetchFiles(s.name);
    let wroteSkillMd = false;

    for (const f of files) {
      if (!f || !f.path) continue;
      // Guard against path escape
      const safe = f.path.replace(/^\/+/, '').replace(/\.\.[/\\]/g, '');
      const dest = path.join(dir, safe);
      if (!dest.startsWith(dir)) continue;
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, String(f.content == null ? '' : f.content), 'utf8');
      if (safe.toLowerCase() === 'skill.md') wroteSkillMd = true;
    }

    // If the hub returned no SKILL.md file, synthesize one from metadata so the
    // agent still has a loadable skill that captures what the tool does.
    if (!wroteSkillMd) {
      const summary = (s.summary && s.summary.trim()) ? `\n\n${s.summary.trim()}\n` : '';
      const envLine = (s.requires_env && s.requires_env.length)
        ? `\n> **Requires env:** ${s.requires_env.join(', ')}` : '';
      const homepage = s.homepage ? `\n> **Homepage:** ${s.homepage}` : '';
      const md = `---\nname: ${s.name}\ndescription: ${(s.description || '').replace(/\n/g, ' ')}\n---\n\n# ${s.display_name || s.name}\n\n**Category:** ${s.category} · **Tags:** ${(s.tags || []).join(', ') || 'none'} · **Author:** ${s.author}${homepage}${envLine}\n\n${s.description || ''}${summary}\n\n## How to use\n\nWhen a task matches this skill's purpose, follow the method implied by its description and the tool's homepage. If the skill requires an external API key (see "Requires env" above), use the configured credentials. Produce client-ready, high-quality output.\n`;
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
    }
    installed.push(s);
    process.stdout.write('.');
  }
  console.log(`\n[cowhub] Installed ${installed.length} hub skills into ${path.relative(ROOT, HUB_DIR)}`);

  regenerateIndex();
}

// ── Rebuild prompts/skills_index.md from ALL SKILL.md under .codebanana/.skills
function walk(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name === 'SKILL.md') out.push(p);
  }
  return out;
}

function regenerateIndex() {
  const files = walk(SKILLS_ROOT).sort();
  const rows = files.map(abs => {
    let md = '';
    try { md = fs.readFileSync(abs, 'utf8'); } catch (_) {}
    let { name, desc } = frontMatterMeta(md);
    if (!name) { const h = md.match(/^#\s+(.+)/m); if (h) name = h[1].trim(); }
    if (!name) name = path.basename(path.dirname(abs));
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    return { name, desc: (desc || '').slice(0, 180), rel };
  });

  const header = `# AVAILABLE SKILLS INDEX

> ${rows.length} expert skills available (includes the full CowAgent Skill Hub of 63+ skills aligned for autonomous use). Each is a SKILL.md you load on demand with the \`read_skill\` tool (pass the exact \`path\` shown below). Per the SKILL-FIRST DOCTRINE you MUST load the matching skill(s) BEFORE you execute a build/design/document/code/deploy/analysis task, then follow the loaded skill exactly. If unsure which skill fits, call \`list_skills\` first.

### How to route a task to the right skill
- **Frontend / web UI / landing page / dashboard** → \`frontend-design\`, \`ui-ux-pro-max\`, \`ui-styling\`
- **Slides / PPT / pitch deck** → \`pptx\`, \`slides\`
- **Word / DOCX** → \`docx\`, \`word-docx\`  ·  **PDF** → \`pdf\`  ·  **Excel/CSV** → \`xlsx\`
- **Image generation** → \`plugin-gemini-image\`, \`plugin-gpt-image\`, \`plugin-seedream-image\`
- **Video generation** → \`plugin-video-gen\`  ·  **Charts** → \`plugin-antv\`, \`plugin-chart\`
- **Web search / info** → \`baidu-search\`, \`web-summarizer\`, \`web-access\`, \`60s-skills\`
- **GitHub / code review / APIs** → \`github\`, \`code-reviewer\`, \`api\`
- **Office suites** → \`tencent-docs\`, \`lark-cli\`, \`wecom-cli\`, \`dws\` (DingTalk), \`tencent-meeting\`
- **Finance** → \`stock-analysis\`, \`akshare-analysis\`, \`gold\`  ·  **Maps** → \`plugin-amap\`, \`plugin-baidu-map\`
- **Research / writing** → \`research\`, \`research-and-write\`, \`write-post\`, \`mckinsey-research\`, \`thesis-helper\`, \`official-writing\`, \`legal\`, \`resume-assistant\`
- **Data analysis** → \`eda-reporter\`  ·  **Streamlit apps** → \`developing-with-streamlit\` (+ sub-skills)

| # | Skill | What it does | path (for read_skill) |
|---|-------|--------------|------------------------|
`;
  const body = rows.map((r, i) =>
    `| ${i + 1} | **${r.name}** | ${(r.desc || '(no description)').replace(/\|/g, '\\|')} | \`${r.rel}\` |`
  ).join('\n');

  ensureDir(path.dirname(INDEX_FILE));
  fs.writeFileSync(INDEX_FILE, header + body + '\n', 'utf8');
  console.log(`[cowhub] Regenerated ${path.relative(ROOT, INDEX_FILE)} with ${rows.length} skills.`);
}

main().catch(e => { console.error('[cowhub] FATAL', e); process.exit(1); });
