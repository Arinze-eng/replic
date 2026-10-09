#!/usr/bin/env node
'use strict';

// Cross-provider capability benchmark. It runs materially different, isolated
// project tasks and requires every case to pass. A partial score is diagnostic,
// never represented as success.
// This is intentionally broader than the former single-package smoke test.
const providerName = String(process.env.LIVE_CODING_PROVIDER || process.argv[2] || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  upstash: require('../services/upstashBox'),
  upstashbox: require('../services/upstashBox'),
  daytona: require('../services/daytona'),
  runloop: require('../services/runloop'),
  githubactions: require('../services/githubActions'),
};
const mod = providers[providerName];
if (!mod) throw new Error('provider must be novita, upstash, daytona, runloop, or githubactions');
const root = mod.WORKDIR;

const benchmark = String.raw`set -u
rm -rf powerx-benchmark && mkdir -p powerx-benchmark && cd powerx-benchmark
PASS=0; TOTAL=7; REPORT=benchmark-results.tsv
printf 'case\tcategory\tstatus\tevidence\n' > "$REPORT"
record(){ if test "$3" -eq 0; then PASS=$((PASS+1)); printf '%s\t%s\tPASS\t%s\n' "$1" "$2" "$4" >> "$REPORT"; else printf '%s\t%s\tFAIL\t%s\n' "$1" "$2" "$4" >> "$REPORT"; fi; }

# 1: TypeScript-style frontend/backend contract and runtime integration.
mkdir -p ts-fullstack
cat > ts-fullstack/app.js <<'JS'
const normalize = x => String(x ?? '').trim().toLowerCase();
function apiCreate(body){ if(!normalize(body.name)) return {status:400}; return {status:201,body:{id:'p1',name:body.name.trim()}}; }
function render(form){ const r=apiCreate(form); return r.status===201 ? 'Created: '+r.body.name : 'Validation error'; }
module.exports={apiCreate,render};
JS
cat > ts-fullstack/test.js <<'JS'
const a=require('assert/strict'),m=require('./app');
a.equal(m.apiCreate({name:'  '} ).status,400); a.equal(m.render({name:' PowerX '}),'Created: PowerX'); console.log('TS_FULLSTACK_OK');
JS
node ts-fullstack/test.js >/tmp/c1 2>&1; C1=$?; record c1 typescript_fullstack "$C1" "frontend-api validation boundary"

# 2: Python service with integration tests and persisted state.
mkdir -p py-service
cat > py-service/service.py <<'PY'
import sqlite3
class Service:
 def __init__(self,p): self.db=sqlite3.connect(p); self.db.execute('create table if not exists jobs(id text primary key,state text)')
 def submit(self,i): self.db.execute('insert into jobs values(?,?)',(i,'queued')); self.db.commit()
 def complete(self,i): self.db.execute('update jobs set state=? where id=?',('done',i)); self.db.commit()
 def state(self,i): return self.db.execute('select state from jobs where id=?',(i,)).fetchone()[0]
PY
cat > py-service/test_service.py <<'PY'
import tempfile,os
from service import Service
p=tempfile.mktemp(); a=Service(p); a.submit('j1'); a.complete('j1'); assert a.state('j1')=='done'; a.db.close(); b=Service(p); assert b.state('j1')=='done'; os.unlink(p); print('PY_SERVICE_OK')
PY
(cd py-service && python3 test_service.py) >/tmp/c2 2>&1; C2=$?; record c2 python_integration "$C2" "sqlite persistence across service restart"

# 3: Medium monorepo with changes across packages.
mkdir -p monorepo/packages/core monorepo/packages/api monorepo/packages/web
cat > monorepo/packages/core/index.js <<'JS'
exports.money = n => Number(n).toFixed(2);
JS
cat > monorepo/packages/api/index.js <<'JS'
const {money}=require('../core'); exports.quote=n=>({total:money(n)});
JS
cat > monorepo/packages/web/index.js <<'JS'
const {quote}=require('../api'); exports.view=n=>'Total $'+quote(n).total;
JS
cat > monorepo/test.js <<'JS'
const a=require('assert/strict'),w=require('./packages/web'); a.equal(w.view(3.5),'Total $3.50'); console.log('MONOREPO_OK');
JS
node monorepo/test.js >/tmp/c3 2>&1; C3=$?; record c3 monorepo_cross_package "$C3" "core-api-web package chain"

# 4: Database migration with backward-compatible API projection.
mkdir -p migration
cat > migration/test.py <<'PY'
import sqlite3
c=sqlite3.connect(':memory:'); c.executescript('create table users(id integer primary key,name text); insert into users(name) values("Ada"); alter table users add column display_name text; update users set display_name=name where display_name is null; create view users_v1 as select id,coalesce(display_name,name) name from users;')
assert c.execute('select name from users_v1').fetchone()[0]=='Ada'; assert c.execute('pragma table_info(users)').fetchall()[-1][1]=='display_name'; print('MIGRATION_OK')
PY
python3 migration/test.py >/tmp/c4 2>&1; C4=$?; record c4 database_migration "$C4" "additive migration and compatibility view"

# 5: Concurrency/performance defect regression.
mkdir -p concurrency
cat > concurrency/test.js <<'JS'
const a=require('assert/strict'); let active=0,peak=0;
async function limitedMap(xs,limit,fn){let next=0; const workers=Array.from({length:Math.min(limit,xs.length)},async()=>{while(next<xs.length){const i=next++; await fn(xs[i]);}}); await Promise.all(workers);}
(async()=>{await limitedMap([...Array(24).keys()],4,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;});a(peak<=4);a(peak>1);console.log('CONCURRENCY_OK peak='+peak)})().catch(e=>{console.error(e);process.exit(1)});
JS
node concurrency/test.js >/tmp/c5 2>&1; C5=$?; record c5 concurrency_performance "$C5" "bounded parallelism under load"

# 6: Misleading symptom: HTTP failure caused by config coercion.
mkdir -p misleading
cat > misleading/config.js <<'JS'
exports.load=e=>({timeoutMs:Number.parseInt(e.TIMEOUT_MS||'5000',10),retries:Number.parseInt(e.RETRIES||'2',10)});
JS
cat > misleading/test.js <<'JS'
const a=require('assert/strict'),{load}=require('./config');let c=load({TIMEOUT_MS:'01000',RETRIES:'0'});a.equal(c.timeoutMs,1000);a.equal(c.retries,0);console.log('MISLEADING_OK');
JS
node misleading/test.js >/tmp/c6 2>&1; C6=$?; record c6 misleading_symptoms "$C6" "environment string coercion root cause"

# 7: Download, inspect, test and archive a real open-source package.
set +e
git clone -q --depth 1 https://github.com/jonschlinkert/is-number.git oss
C7CLONE=$?
set -e
if test $C7CLONE -eq 0; then (cd oss && npm install --ignore-scripts --no-audit --no-fund >/dev/null && npm test >/tmp/c7 2>&1 && node --check index.js); C7=$?; else C7=1; fi
record c7 open_source_repository "$C7" "clone install upstream test syntax"

SCORE=$((PASS*100/TOTAL))
printf 'score\t%d\npassed\t%d\ntotal\t%d\n' "$SCORE" "$PASS" "$TOTAL" > benchmark-summary.txt
cat "$REPORT"
cat benchmark-summary.txt
if test "$SCORE" -ne 100; then echo "BENCHMARK_FAILED score=$SCORE"; exit 1; fi
for required in c1 c2 c3 c4 c5 c6 c7; do grep -q "^$required.*PASS" "$REPORT" || { echo "REQUIRED_CASE_FAILED $required"; exit 1; }; done
cd ..
(command -v zip >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq zip))
zip -qr powerx-benchmark.zip powerx-benchmark -x 'powerx-benchmark/oss/.git/*' 'powerx-benchmark/oss/node_modules/*'
test -s powerx-benchmark.zip
echo "POWERX_BENCHMARK_OK score=$SCORE"
`;

(async () => {
  const key = await mod.testKey();
  if (!key.ok) throw new Error(key.message || `${providerName} authentication failed`);
  const reusableId = String(process.env.BENCHMARK_SANDBOX_ID || '').trim();
  const id = reusableId || await mod.createSandbox({ labels: { session: `benchmark-${Date.now()}` } });
  const ownsSandbox = !reusableId;
  try {
    const r = await mod.exec(id, benchmark, { cwd: root, timeout: 1800 });
    const output = String(r.output || '');
    if (r.exitCode !== 0 || !/POWERX_BENCHMARK_OK score=100/.test(output)) {
      throw new Error(`benchmark exit ${r.exitCode}: ${output.slice(-6000)}`);
    }
    const score = Number((output.match(/POWERX_BENCHMARK_OK score=(\d+)/) || [])[1]);
    const zip = await mod.downloadFile(id, `${root}/powerx-benchmark.zip`);
    if (!zip || zip.length < 1000 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('benchmark archive is invalid');
    console.log(output.slice(-5000));
    console.log(`✅ ${providerName}: ${score}% across 7 materially different coding projects (${zip.length} byte evidence archive)`);
  } finally {
    if (ownsSandbox) { try { await mod.deleteSandbox(id); } catch (_) {} }
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
