#!/usr/bin/env node
/**
 * regen-skills-index.js
 * Rebuilds prompts/skills_index.md from ALL SKILL.md files under
 * .codebanana/.skills — WITHOUT any network call. Use this when adding local
 * skills (e.g. web-hacking-suite, trading-skills, persistent-execution) so the
 * WormGPT agent's system prompt advertises them and can read_skill them.
 *
 * Idempotent. Run: node scripts/regen-skills-index.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = path.join(ROOT, '.codebanana', '.skills');
const INDEX_FILE = path.join(ROOT, 'prompts', 'skills_index.md');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function frontMatterMeta(md) {
  let name = '', desc = '';
  const ym = md.match(/^---\n([\s\S]*?)\n---/);
  if (ym) {
    const nm = ym[1].match(/name:\s*(.+)/); if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    const dm = ym[1].match(/description:\s*([\s\S]*?)(\n[a-z_]+:|$)/);
    // Strip a leading YAML block-scalar marker ('|' or '>') so it doesn't leak
    // into the rendered table, then collapse whitespace.
    if (dm) desc = dm[1].replace(/^\s*[|>][-+]?\s*/, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  }
  return { name, desc };
}

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

> ${rows.length} expert skills available (includes the full CowAgent Skill Hub of 63+ skills aligned for autonomous use, PLUS local power-skills: web-hacking-suite, trading-skills, persistent-execution, self-reflection, coding-master, color-palette, apktool-reversing, output-verifier). Each is a SKILL.md you load on demand with the \`read_skill\` tool (pass the exact \`path\` shown below). Per the SKILL-FIRST DOCTRINE you MUST load the matching skill(s) BEFORE you execute a build/design/document/code/deploy/analysis/security/trading task, then follow the loaded skill exactly. If unsure which skill fits, call \`list_skills\` first.

### How to route a task to the right skill
- **META — apply to EVERY non-trivial task (think longer & self-check like Manus)** → \`self-reflection\` (plan → act → critique your own work → improve → verify, loop until self-grade ≥9/10) + \`persistent-execution\` (never stop early) + \`output-verifier\` (objective file check). Load these AROUND the domain skill.
- **BEFORE delivering ANY file / web page / PPTX / .zip (mandatory)** → \`output-verifier\` (two-pass self-check: extract spec → inspect real file → redo until it EXACTLY matches; stops "red→white" mistakes)
- **Frontend / web UI / landing page / dashboard** → \`frontend-design\`, \`ui-ux-pro-max\`, \`ui-styling\` (then VERIFY with \`output-verifier\`)
- **Any coding / build / fix bug / refactor / write a program (any language)** → \`coding-master\` (write + debug + ship runnable code; ALWAYS deliver finished files as a .zip)
- **Colors / palette / theme / gradient / "what color should I use"** → \`color-palette\` (every named color + HEX/RGB/HSL, palettes, gradients, accessibility)
- **APK / DEX / smali / mod apk / decompile / recompile / sign apk** → \`apktool-reversing\` (decompile to smali, patch, rebuild to dex/apk, zipalign + sign, deliver)
- **Slides / PPT / pitch deck** → \`pptx\`, \`slides\`
- **Word / DOCX** → \`docx\`, \`word-docx\`  ·  **PDF** → \`pdf\`  ·  **Excel/CSV** → \`xlsx\`
- **Image generation** → \`plugin-gemini-image\`, \`plugin-gpt-image\`, \`plugin-seedream-image\`
- **Video generation** → \`plugin-video-gen\`  ·  **Charts** → \`plugin-antv\`, \`plugin-chart\`
- **Web search / info** → \`baidu-search\`, \`web-summarizer\`, \`web-access\`, \`60s-skills\`
- **GitHub / code review / APIs** → \`github\`, \`code-reviewer\`, \`api\`
- **Office suites** → \`tencent-docs\`, \`lark-cli\`, \`wecom-cli\`, \`dws\` (DingTalk), \`tencent-meeting\`
- **Finance / markets** → \`stock-analysis\`, \`akshare-analysis\`, \`gold\`, \`trading-skills\`  ·  **Maps** → \`plugin-amap\`, \`plugin-baidu-map\`
- **Web security / pentest / hacking** → \`web-hacking-suite\` (recon, vuln assessment, exploitation, post-exploitation, AI-agent automation)
- **Trading / markets / bots** → \`trading-skills\` (TA, FA, strategies, risk mgmt, automated + browserless execution)
- **MUST-SUCCEED / never-give-up tasks** → \`persistent-execution\` (relentless retry/adapt/research loop until verified success or truly exhausted)
- **THINK-LONGER / recheck-yourself / strict-obedience tasks** → \`self-reflection\` (Manus-style reflexion: critique your own output, self-grade /10, improve, re-verify before finishing — never stop on the first pass)
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
  console.log(`[regen] Regenerated ${path.relative(ROOT, INDEX_FILE)} with ${rows.length} skills.`);
}

regenerateIndex();
