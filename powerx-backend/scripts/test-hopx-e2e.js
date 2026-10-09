// End-to-end test of services/hopx.js against the real HopX API.
// Verifies the full backend interface the WormGPT agent relies on, with special
// attention to BINARY FILE INTEGRITY (pdf/docx round-trip must not corrupt → {}).
// Usage: HOPX_API_KEY=hopx_live_… node scripts/test-hopx-e2e.js
if (!process.env.HOPX_API_KEY) { console.error('Set HOPX_API_KEY env var to run this test.'); process.exit(2); }
// Disable DB so it uses env key only (standalone test).
const hopx = require('../services/hopx');
const crypto = require('crypto');

function log(...a){ console.log(...a); }
function assert(cond, msg){ if(!cond){ throw new Error('ASSERT FAILED: '+msg); } log('  ✓', msg); }

(async () => {
  let id;
  try {
    log('enabled():', hopx.enabled(), '| WORKDIR:', hopx.WORKDIR);
    assert(hopx.enabled(), 'backend enabled with env key');

    log('\n[1] testKey()');
    const tk = await hopx.testKey();
    log('   ', tk.message);
    assert(tk.ok, 'testKey reachable');

    log('\n[2] createSandbox()');
    id = await hopx.createSandbox({ labels: { test: 'e2e' } });
    log('    sandbox id =', id);
    assert(!!id, 'got sandbox id');

    log('\n[3] exec — identity + privileges');
    const who = await hopx.exec(id, 'echo "U=$(whoami) UID=$(id -u)"; grep CapEff /proc/self/status');
    log('    ', who.output.trim().replace(/\n/g,' | '));
    assert(/U=root/.test(who.output), 'runs as root');
    assert(who.exitCode === 0, 'exec exit 0');

    log('\n[4] BINARY round-trip (simulate a PDF/DOCX) — MUST be byte-identical');
    // Build a realistic binary blob with PDF magic + random bytes + nulls.
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1'),
      crypto.randomBytes(50000),
      Buffer.from('\n%%EOF\n', 'latin1'),
    ]);
    const remote = `${hopx.WORKDIR}/report.pdf`;
    await hopx.uploadFile(id, remote, pdfBytes, 'report.pdf');
    const back = await hopx.downloadFile(id, remote);
    const a = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const b = crypto.createHash('sha256').update(back).digest('hex');
    log('    local sha:', a.slice(0,16), '| size', pdfBytes.length);
    log('    remote sha:', b.slice(0,16), '| size', back.length);
    assert(a === b, 'PDF bytes byte-identical after upload+download (no {} corruption)');

    log('\n[5] listFiles()');
    const files = await hopx.listFiles(id, hopx.WORKDIR);
    log('    files:', files.map(f => `${f.name}(${f.size})`).join(', '));
    assert(files.some(f => f.name === 'report.pdf' && f.size === pdfBytes.length), 'report.pdf listed with correct size');

    log('\n[6] write a docx-like file via exec + read it back through the fsx path (downloadFile)');
    await hopx.exec(id, `printf 'PK\\x03\\x04 docx-zip-magic' > ${hopx.WORKDIR}/doc.docx`);
    const docx = await hopx.downloadFile(id, `${hopx.WORKDIR}/doc.docx`);
    assert(docx.slice(0,4).toString('latin1') === 'PK\x03\x04', 'docx ZIP magic preserved');

    log('\n[7] long exec (auto background path, > 290s ceiling logic) — quick proxy with 295s flag');
    const longr = await hopx.exec(id, 'echo start; sleep 2; echo done', { timeout: 295 });
    assert(/start[\s\S]*done/.test(longr.output), 'long-exec path returns full output');

    log('\n[8] dockerSetup() — real dockerd on the privileged micro-VM (this can take 1-3 min)');
    const ds = await hopx.dockerSetup(id, { onStep: s => log('      ', s) });
    log('    docker ok=', ds.ok, '| version=', ds.version);
    log('    setup log tail:', (ds.log||'').slice(-300).replace(/\n/g,' | '));
    assert(ds.ok, 'Docker-in-Docker daemon is up');

    log('\n[9] dockerRun — pull & run a real container (auto --network=host for egress)');
    const dr = await hopx.dockerRun(id, 'run --rm alpine:latest sh -c "echo CONTAINER_OK; cat /etc/alpine-release"', { timeout: 280 });
    log('    output:', (dr.output||'').trim().replace(/\n/g,' | '));
    assert(/CONTAINER_OK/.test(dr.output), 'container ran and produced output');

    log('\n[10] container internet egress (apk + https)');
    const net = await hopx.dockerRun(id, 'run --rm alpine:latest sh -c "wget -qO- -T 8 http://example.com | grep -o -m1 \'<title>[^<]*\'"', { timeout: 200 });
    log('    egress:', (net.output||'').trim());
    assert(/Example Domain/i.test(net.output), 'container reached the internet');

    log('\n✅✅✅ ALL HOPX BACKEND TESTS PASSED');
  } catch (e) {
    log('\n❌ TEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    if (id) {
      log('\n[cleanup] deleteSandbox', id);
      await hopx.deleteSandbox(id).catch(() => {});
    }
  }
})();
