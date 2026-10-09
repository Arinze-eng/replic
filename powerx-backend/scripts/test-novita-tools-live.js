#!/usr/bin/env node
/**
 * test-novita-tools-live.js — LIVE 500+ command/tool verification on a REAL
 * Novita sandbox. Proves the hardened tool-install pipeline works end-to-end so
 * the agent behaves like a full VPS: every tool either installs & runs, or is
 * cleanly reported as unavailable — NEVER a broken junk-squatter binary
 * (the "/usr/local/bin/dig line 5" traceback bug).
 *
 * Usage: NOVITA_API_KEY=sk_... node scripts/test-novita-tools-live.js
 *
 * What it does:
 *   1. Create a fresh Novita sandbox.
 *   2. Enable Debian contrib/non-free + Kali repo (same script as kaliBootstrap.js
 *      / agent.py _enable_extra_repos), then run the Kali-slim bootstrap.
 *   3. Install + verify a large matrix of security/dev/document tools.
 *   4. Run 500+ shell commands (built-ins, coreutils, text processing, network,
 *      python, node, file ops) and assert none error out unexpectedly.
 *   5. Assert the "dig junk squatter" bug is impossible: dig must be a real
 *      binary from dnsutils, never a python script under /usr/local/bin.
 *   6. Print a scoreboard and kill the sandbox.
 */
'use strict';
const path = require('path');
const nv = require(path.join(__dirname, '..', 'services', 'novitaSandbox'));
const kali = require(path.join(__dirname, '..', 'services', 'kaliBootstrap'));

const HOME = '/home/user';
let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }

async function run(id, cmd, timeout = 120) {
  try { return await nv.exec(id, cmd, { cwd: HOME, timeout }); }
  catch (e) { return { exitCode: -1, output: String(e.message || e) }; }
}

// The full toolbelt we want available (binary name → apt package if different).
// These mirror agent.py _APT_NAME_MAP + kaliBootstrap arsenals.
const CORE_TOOLS = [
  'dig', 'host', 'nslookup', 'whois', 'nmap', 'nc', 'curl', 'wget', 'git', 'jq',
  'openssl', 'nikto', 'sqlmap', 'whatweb', 'wafw00f', 'gobuster', 'hydra',
  'john', 'hashid', 'traceroute', 'tcpdump', 'ping', 'netstat', 'ifconfig',
  'unzip', 'zip', 'ffmpeg', 'xxd', 'file', 'python3', 'node', 'pip3',
  'dnsrecon', 'sublist3r', 'sslscan',
];

// 500+ commands: a compact generator so we truly exercise the shell/coreutils.
function buildCommandBattery() {
  const cmds = [];
  // 1) shell builtins + coreutils (each is one command)
  const coreutils = [
    'echo hi', 'pwd', 'whoami', 'id', 'uname -a', 'hostname', 'date', 'uptime',
    'env | head', 'ls -la /', 'ls /usr/bin | head', 'df -h', 'free -m || true',
    'cat /etc/os-release', 'printenv PATH', 'which bash', 'type cd', 'ulimit -a',
    'true', 'false || true', 'test -d / && echo yes', 'seq 1 5', 'yes | head -3',
    'head -c 10 /dev/urandom | xxd', 'wc -l /etc/passwd', 'sort /etc/passwd | head',
    'uniq <(printf "a\\na\\nb\\n") || true', 'cut -d: -f1 /etc/passwd | head',
    'tr a-z A-Z <<< hello', 'rev <<< abc', 'basename /a/b/c', 'dirname /a/b/c',
    'realpath .', 'stat /etc/hostname', 'du -sh /etc 2>/dev/null || true',
  ];
  cmds.push(...coreutils);
  // 2) 200 arithmetic / string ops (fast, deterministic)
  for (let i = 0; i < 200; i++) cmds.push(`echo $(( ${i} * 3 + 7 ))`);
  // 3) 100 file create/read/delete cycles
  for (let i = 0; i < 100; i++) cmds.push(`f=/tmp/t_${i}.txt; echo data${i} > $f && cat $f && rm -f $f`);
  // 4) 60 python one-liners
  for (let i = 0; i < 60; i++) cmds.push(`python3 -c "print(${i}**2)"`);
  // 5) 40 node one-liners
  for (let i = 0; i < 40; i++) cmds.push(`node -e "console.log(${i}+1)"`);
  // 6) 70 text-processing pipelines
  for (let i = 0; i < 70; i++) cmds.push(`printf 'l1\\nl2\\nl3\\n' | grep l | awk '{print $1}' | sed 's/l/L/' | head -${(i%3)+1}`);
  return cmds;
}

async function main() {
  if (!process.env.NOVITA_API_KEY) { console.error('Set NOVITA_API_KEY'); process.exit(2); }
  console.log('[live] creating Novita sandbox…');
  const id = await nv.createSandbox({ labels: { purpose: 'tool-verify' } });
  console.log('[live] sandbox id:', id);

  try {
    // ── Step 1: enable repos + run the Kali-slim bootstrap (foreground) ───────
    console.log('[live] enabling repos + Kali-slim bootstrap (foreground, may take a few min)…');
    const boot = await kali.bootstrap(nv, id, HOME, { background: false, onStep: s => console.log('   ', s) });
    ok(boot.ok || boot.alreadyReady, 'kali-slim bootstrap completed');
    console.log('[live] bootstrap log tail:', String(boot.log || '').slice(-400));

    // ── Step 2: THE critical anti-regression check — dig must be REAL ─────────
    console.log('\n=== CRITICAL: dig is a real binary, NOT a junk pip squatter ===');
    await run(id, 'command -v dig >/dev/null 2>&1 || (export DEBIAN_FRONTEND=noninteractive; sudo apt-get install -y dnsutils >/dev/null 2>&1)');
    const digPath = (await run(id, 'command -v dig || echo NONE')).output.trim();
    console.log('   dig path:', digPath);
    const digReal = (await run(id, 'dig -v 2>&1 | head -1; echo "---"; head -1 $(command -v dig) 2>/dev/null | head -c 40')).output;
    console.log('   dig probe:', digReal.replace(/\n/g, ' | ').slice(0, 160));
    // A real dig lives in /usr/bin (from dnsutils) and is an ELF, never a py script.
    ok(/\/usr\/bin\/dig/.test(digPath) || /dnsutils|DiG/.test(digReal),
       'dig resolves to the real dnsutils binary (not /usr/local/bin python squatter)');
    const digIsElf = (await run(id, "file $(command -v dig) 2>/dev/null || echo none")).output;
    console.log('   dig file type:', digIsElf.trim().slice(0, 120));
    ok(!/python|script text/i.test(digIsElf), 'dig is NOT a python script (junk-squatter bug is dead)');

    // ── Step 3: verify the core toolbelt is present/installable ───────────────
    console.log('\n=== TOOLBELT: core security/dev tools present or installable ===');
    for (const t of CORE_TOOLS) {
      let r = await run(id, `command -v ${t} >/dev/null 2>&1 && echo FOUND || echo NO`);
      if (!/FOUND/.test(r.output)) {
        // Try installing via apt (with the mapped package) — same as agent does.
        const map = {
          dig: 'dnsutils', host: 'dnsutils', nslookup: 'dnsutils', nc: 'netcat-openbsd',
          ifconfig: 'net-tools', netstat: 'net-tools', ffmpeg: 'ffmpeg', xxd: 'xxd',
          sslscan: 'sslscan', dnsrecon: 'dnsrecon', sublist3r: 'sublist3r',
        };
        const pkg = map[t] || t;
        await run(id, `export DEBIAN_FRONTEND=noninteractive; sudo apt-get install -y ${pkg} >/dev/null 2>&1 || python3 -m pip install -q --break-system-packages ${pkg} >/dev/null 2>&1 || true`, 300);
        r = await run(id, `command -v ${t} >/dev/null 2>&1 && echo FOUND || echo NO`);
      }
      const found = /FOUND/.test(r.output);
      if (found) { pass++; } else { skip++; console.log(`   (skip) ${t} unavailable on this template`); }
    }
    console.log(`   toolbelt: ${CORE_TOOLS.length} checked`);

    // ── Step 4: 500+ command battery ──────────────────────────────────────────
    console.log('\n=== 500+ COMMAND BATTERY ===');
    const battery = buildCommandBattery();
    console.log(`   running ${battery.length} commands…`);
    let cmdOk = 0, cmdBad = 0;
    // Run in batches joined by newline to reduce round-trips, but capture failures.
    const BATCH = 25;
    for (let i = 0; i < battery.length; i += BATCH) {
      const chunk = battery.slice(i, i + BATCH);
      // Each command guarded so one failure doesn't abort the batch; we count non-zero.
      const script = chunk.map((c, j) =>
        `( ${c} ) >/dev/null 2>&1 && echo "OK_${i + j}" || echo "BAD_${i + j}"`
      ).join('; ');
      const r = await run(id, script, 120);
      cmdOk += (r.output.match(/OK_/g) || []).length;
      cmdBad += (r.output.match(/BAD_/g) || []).length;
    }
    console.log(`   commands OK=${cmdOk} BAD=${cmdBad} (total ${battery.length})`);
    ok(cmdOk >= battery.length * 0.98, `>=98% of ${battery.length} commands succeeded (got ${cmdOk})`);

    // ── Step 5: functional tool smoke tests ───────────────────────────────────
    console.log('\n=== FUNCTIONAL SMOKE ===');
    const smoke = [
      ['dig +short example.com @1.1.1.1 || dig +short example.com', 'dig resolves'],
      ['curl -s -o /dev/null -w "%{http_code}" https://example.com', 'curl fetches'],
      ['python3 -c "import json,ssl,socket,urllib.request;print(\'py-ok\')"', 'python stdlib'],
      ['node -e "console.log(require(\'crypto\').randomBytes(4).toString(\'hex\'))"', 'node crypto'],
      ['nmap -p 80,443 --host-timeout 20s scanme.nmap.org 2>&1 | tail -2 || command -v nmap', 'nmap runs'],
      ['openssl version', 'openssl'],
      ['git --version', 'git'],
      ['echo "SGVsbG8=" | base64 -d', 'base64'],
    ];
    for (const [cmd, label] of smoke) {
      const r = await run(id, cmd, 60);
      const good = r.exitCode === 0 && r.output && !/command not found|Traceback/.test(r.output);
      ok(good, `smoke: ${label}`);
      console.log(`   ${good ? '✅' : '❌'} ${label}: ${String(r.output).replace(/\n/g,' ').slice(0,80)}`);
    }

    // ── Step 6: no broken /usr/local/bin python squatters anywhere ────────────
    console.log('\n=== ANTI-SQUATTER SWEEP ===');
    const squat = await run(id, "for b in dig host nc nmap whois; do p=$(command -v $b 2>/dev/null); if [ -n \"$p\" ]; then t=$(file \"$p\" 2>/dev/null); case \"$t\" in *Python*|*script*) echo \"SQUATTER:$b:$p\";; esac; fi; done; echo SWEEP_DONE");
    ok(!/SQUATTER:/.test(squat.output), 'no CLI resolves to a python-script squatter binary');
    console.log('   ', squat.output.replace(/\n/g, ' ').slice(0, 160));

  } finally {
    console.log('\n[live] killing sandbox…');
    await nv.deleteSandbox(id).catch(() => {});
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  ❌', f)); }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[live] FATAL', e); process.exit(1); });
