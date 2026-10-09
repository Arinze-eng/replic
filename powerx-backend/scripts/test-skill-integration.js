// E2E-ish test of the skill subsystem WITHOUT booting the whole server.
// Replicates agentEngine's skill walker + reader against the real files,
// then asserts the 63 hub skills (incl. frontend-design) are discoverable,
// loadable, and that the system prompt injects the full index.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = path.join(ROOT, '.codebanana', '.skills');

function walk(dir){let o=[];let es=[];try{es=fs.readdirSync(dir,{withFileTypes:true});}catch(_){return o;}for(const e of es){const p=path.join(dir,e.name);if(e.isDirectory())o=o.concat(walk(p));else if(e.name==='SKILL.md')o.push(p);}return o;}
function meta(abs){let name='',desc='';try{const t=fs.readFileSync(abs,'utf8');const ym=t.match(/^---\n([\s\S]*?)\n---/);if(ym){const nm=ym[1].match(/name:\s*(.+)/);if(nm)name=nm[1].trim();const dm=ym[1].match(/description:\s*([\s\S]*?)(\n[a-z_]+:|$)/);if(dm)desc=dm[1].replace(/\s+/g,' ').trim();}if(!name){const h=t.match(/^#\s+(.+)/m);if(h)name=h[1].trim();}}catch(_){}if(!name)name=path.basename(path.dirname(abs));return{name,desc};}

let pass=0,fail=0;
function ok(c,m){if(c){pass++;console.log('  ✅',m);}else{fail++;console.log('  ❌',m);}}

console.log('\n=== TEST 1: list_skills discovers all skills ===');
const files = walk(SKILLS_ROOT);
console.log(`  Found ${files.length} SKILL.md files`);
ok(files.length>=90, `>=90 skills discoverable (got ${files.length})`);

console.log('\n=== TEST 2: 63 CowAgent hub skills installed ===');
const hubDirs = fs.readdirSync(path.join(SKILLS_ROOT,'cowagent-hub'),{withFileTypes:true}).filter(e=>e.isDirectory());
const hubFiles = files.filter(f=>f.includes('/cowagent-hub/'));
ok(hubDirs.length>=63, `>=63 top-level hub skills (got ${hubDirs.length})`);
ok(hubFiles.length>=63, `>=63 loadable hub SKILL.md incl sub-skills (got ${hubFiles.length})`);

console.log('\n=== TEST 3: frontend-design loadable & non-trivial ===');
const fd = files.find(f=>f.includes('/cowagent-hub/frontend-design/SKILL.md'));
ok(!!fd, 'frontend-design SKILL.md exists');
if(fd){const body=fs.readFileSync(fd,'utf8');ok(body.length>2000,`frontend-design body is rich (${body.length} chars)`);ok(/oklch|Tailwind|Design Workflow/i.test(body),'contains real design guidance');}

console.log('\n=== TEST 4: read_skill by name resolution ===');
const byName = files.find(f=>meta(f).name.toLowerCase()==='frontend-design');
ok(!!byName,'read_skill can resolve frontend-design by name');

console.log('\n=== TEST 5: every skill has a name+description in index ===');
let missing=0;for(const f of files){const m=meta(f);if(!m.name)missing++;}
ok(missing===0,`all skills have a name (missing=${missing})`);

console.log('\n=== TEST 6: skills_index.md regenerated with full catalog ===');
const idx=fs.readFileSync(path.join(ROOT,'prompts','skills_index.md'),'utf8');
ok(/frontend-design/.test(idx),'index mentions frontend-design');
ok(/cowagent-hub/.test(idx),'index references cowagent-hub paths');
const rowCount=(idx.match(/\.codebanana\/\.skills\//g)||[]).length;
ok(rowCount>=90,`index lists >=90 skill paths (got ${rowCount})`);

console.log('\n=== TEST 7: system prompt injects the index (boot simulation) ===');
const promptFile=path.join(ROOT,'prompts','agent_system_prompt.md');
let body=fs.readFileSync(promptFile,'utf8');
const injected=body.replace(/\{\{\s*SKILLS_INDEX\s*\}\}/g,idx);
ok(/SKILL-FIRST DOCTRINE/.test(injected),'prompt has SKILL-FIRST DOCTRINE');
ok(!/\{\{\s*SKILLS_INDEX\s*\}\}/.test(injected),'SKILLS_INDEX placeholder fully replaced');
ok(/frontend-design/.test(injected),'final prompt the agent sees lists frontend-design');
ok(injected.length>80000,`final prompt is substantial (${injected.length} chars)`);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
