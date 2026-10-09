'use strict';
// LIVE_DESIGN_PROVIDER=novita|upstash|runloop|daytona|githubactions
const assert=require('assert'),fs=require('fs'),path=require('path');
const name=String(process.env.LIVE_DESIGN_PROVIDER||'').toLowerCase();
const mods={novita:'../services/novitaSandbox',upstash:'../services/upstashBox',runloop:'../services/runloop',daytona:'../services/daytona',githubactions:'../services/githubActions'};
if(!mods[name])throw Error('invalid LIVE_DESIGN_PROVIDER');const provider=require(mods[name]);
(async()=>{if(!(await Promise.resolve(provider.enabledAsync?provider.enabledAsync():provider.enabled())))throw Error(`${name} not configured`);let id;try{id=await provider.createSandbox({labels:{test:'design-e2e'}});const root=provider.WORKDIR;
 const files=['services/presentationBuilder.js','services/frontendQuality.js','scripts/test-presentation-frontend.js'];for(const rel of files)await provider.uploadFile(id,`${root}/${path.basename(rel)}`,fs.readFileSync(path.join(__dirname,'..',rel)),path.basename(rel));
 // Test imports are rewritten only in the sandbox copy so production sources stay canonical.
 const cmd=`set -e; sed -i "s#../services/presentationBuilder#./presentationBuilder#;s#../services/frontendQuality#./frontendQuality#" test-presentation-frontend.js; if [ ! -f package.json ]; then npm init -y >/dev/null 2>&1; fi; npm install --no-audit --no-fund --silent pptxgenjs@3.12.0 adm-zip@0.5.18 sharp@0.34.4; node test-presentation-frontend.js`;
 const r=await provider.exec(id,cmd,{cwd:root,timeout:900});assert.equal(r.exitCode,0,r.output);assert(/presentation QA passed/.test(r.output),r.output);assert(/frontend QA passed/.test(r.output),r.output);console.log(`✅ ${name} presentation + frontend E2E passed`);
 }finally{if(id)await provider.deleteSandbox(id).catch(()=>{});}})().catch(e=>{console.error(e);process.exit(1)});
