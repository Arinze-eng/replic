// TRUE runtime test: require the REAL agentEngine and call the SAME host-tool
// path the live WormGPT agent uses (runHostTool 'list_skills' / 'read_skill'),
// plus assert the boot-time system prompt embeds the full skills index.
'use strict';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
let engine;
try { engine = require('../services/agentEngine'); }
catch (e) { console.error('REQUIRE FAILED:', e.message); process.exit(2); }

let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;console.log('  ✅',m);}else{fail++;console.log('  ❌',m);}};

(async () => {
  console.log('\n=== RUNTIME 1: getAgentSystemPrompt embeds full index ===');
  const sp = engine.getAgentSystemPrompt ? engine.getAgentSystemPrompt() : '';
  ok(typeof sp==='string' && sp.length>50000, `system prompt loaded (${sp.length} chars)`);
  ok(/SKILL-FIRST DOCTRINE/.test(sp), 'prompt contains SKILL-FIRST DOCTRINE');
  ok(/frontend-design/.test(sp), 'prompt lists frontend-design');
  ok(/cowagent-hub/.test(sp), 'prompt references cowagent-hub skills');
  ok(!/\{\{\s*SKILLS_INDEX\s*\}\}/.test(sp), 'no unreplaced SKILLS_INDEX placeholder');

  console.log('\n=== RUNTIME 2: runHostTool("list_skills") ===');
  const list = await engine.runHostTool('list_skills', {});
  const listStr = typeof list==='string'?list:JSON.stringify(list);
  ok(/skills available/i.test(listStr), 'list_skills returns a catalog');
  ok(/frontend-design/.test(listStr), 'list_skills includes frontend-design');
  const count = (listStr.match(/path:/g)||[]).length;
  ok(count>=90, `list_skills enumerates >=90 skills (got ${count})`);

  console.log('\n=== RUNTIME 3: runHostTool("read_skill", frontend-design by name) ===');
  const r1 = await engine.runHostTool('read_skill', { name: 'frontend-design' });
  const r1s = typeof r1==='string'?r1:JSON.stringify(r1);
  ok(/LOADED skill/i.test(r1s), 'read_skill loads by name');
  ok(/Design Workflow|oklch|Tailwind/i.test(r1s), 'loaded body has real design content');

  console.log('\n=== RUNTIME 4: read_skill by explicit path ===');
  const r2 = await engine.runHostTool('read_skill', { path: '.codebanana/.skills/cowagent-hub/frontend-design/SKILL.md' });
  const r2s = typeof r2==='string'?r2:JSON.stringify(r2);
  ok(/LOADED skill/i.test(r2s), 'read_skill loads by path');

  console.log('\n=== RUNTIME 5: read_skill a few other hub skills ===');
  for (const n of ['github','code-reviewer','pptx','baidu-search']) {
    const r = await engine.runHostTool('read_skill', { name: n });
    ok(/LOADED skill/i.test(typeof r==='string'?r:JSON.stringify(r)), `read_skill("${n}") works`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('TEST CRASH:',e);process.exit(3);});
