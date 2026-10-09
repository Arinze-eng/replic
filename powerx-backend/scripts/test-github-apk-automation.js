#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
process.env.GITHUB_DEPLOY_TOKEN = 'test-token-not-real';
const automation = require('../services/githubAutomation');

function response(status, body, headers = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => headers[String(key).toLowerCase()] || null },
    text: async () => raw.toString('utf8'),
    arrayBuffer: async () => raw,
  };
}

function fakeApkArtifact() {
  const name = Buffer.from('app-release.apk');
  const payload = Buffer.from('APK-BYTES');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(payload.length, 18);
  header.writeUInt16LE(payload.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, payload]);
}

async function testWorkflowContract() {
  const yaml = automation.defaultFlutterWorkflow({ projectDir: 'mobile', artifactName: 'verified-apk' });
  for (const required of ['actions/setup-java@v4', "java-version: '17'", 'subosito/flutter-action@v2', 'flutter analyze', 'flutter test', 'flutter build apk --release', 'sha256sum', 'actions/upload-artifact@v4', 'if-no-files-found: error']) {
    assert(yaml.includes(required), `workflow missing ${required}`);
  }
  assert(!/token|secret/i.test(yaml), 'workflow must not embed caller credentials');
}

async function testAtomicPushRetries() {
  let refReads = 0;
  let patchCalls = 0;
  automation.__setFetchForTests(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/repos/acme/app') return response(200, { default_branch: 'main' });
    if (path.endsWith('/git/ref/heads/main')) return response(200, { object: { sha: `parent-${++refReads}` } });
    if (/\/git\/commits\/parent-/.test(path) && (!options.method || options.method === 'GET')) return response(200, { tree: { sha: 'base-tree' } });
    if (path.endsWith('/git/blobs')) return response(201, { sha: 'blob-sha' });
    if (path.endsWith('/git/trees')) return response(201, { sha: 'tree-sha' });
    if (path.endsWith('/git/commits') && options.method === 'POST') return response(201, { sha: `commit-${refReads}` });
    if (path.endsWith('/git/refs/heads/main') && options.method === 'PATCH') {
      patchCalls++;
      return patchCalls === 1 ? response(422, { message: 'Update is not a fast forward' }) : response(200, {});
    }
    throw new Error(`unexpected request ${options.method || 'GET'} ${path}`);
  });
  const result = await automation.pushFiles({ repo: 'acme/app', files: [{ rel: 'lib/main.dart', buffer: Buffer.from('void main(){}') }] });
  assert.equal(result.sha, 'commit-2');
  assert.equal(patchCalls, 2);
}

async function testDispatchPollSuccessArtifact() {
  let runPolls = 0;
  automation.__setFetchForTests(async (url, options = {}) => {
    const path = new URL(url).pathname;
    const query = new URL(url).search;
    if (path === '/repos/acme/app') return response(200, { default_branch: 'main' });
    if (path.endsWith('/actions/workflows/build-apk.yml/dispatches')) return response(204, '');
    if (path.endsWith('/actions/workflows/build-apk.yml/runs')) return response(200, { workflow_runs: [{ id: 91, status: 'queued', created_at: new Date().toISOString(), html_url: 'run' }] });
    if (path.endsWith('/actions/runs/91')) {
      runPolls++;
      return response(200, { id: 91, status: 'completed', conclusion: 'success', html_url: 'run' });
    }
    if (path.endsWith('/actions/runs/91/artifacts')) return response(200, { artifacts: [{ id: 7, name: 'verified-release-apk', size_in_bytes: 1234, expired: false, archive_download_url: 'x' }] });
    if (path.endsWith('/actions/artifacts/7/zip')) return response(200, fakeApkArtifact());
    throw new Error(`unexpected ${options.method || 'GET'} ${path}${query}`);
  });
  const result = await automation.dispatchAndWatch({ repo: 'acme/app', branch: 'main', workflow: 'build-apk.yml', pollSeconds: 2, maxWaitSeconds: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts[0].name, 'verified-release-apk');
  assert(Buffer.isBuffer(result.artifacts[0].buffer));
  assert.equal(runPolls, 1);
}

async function testFailureDiagnostics() {
  automation.__setFetchForTests(async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/actions/runs/44')) return response(200, { id: 44, status: 'completed', conclusion: 'failure' });
    if (path.endsWith('/actions/runs/44/jobs')) return response(200, { jobs: [{ id: 9, name: 'build-apk', conclusion: 'failure', html_url: 'job', steps: [{ name: 'Build release APK', conclusion: 'failure' }] }] });
    if (path.endsWith('/actions/jobs/9/logs')) return response(200, 'Gradle task assembleRelease failed\nCould not resolve dependency');
    throw new Error(`unexpected ${path}`);
  });
  const result = await automation.watchRun({ repo: 'acme/app', runId: 44, pollSeconds: 2, maxWaitSeconds: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].step, 'Build release APK');
  assert.match(result.diagnostics[0].log, /Gradle task assembleRelease failed/);
}

async function testWorkerAndEngineWiring() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const worker = fs.readFileSync(path.join(root, 'agent_worker/agent.py'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'services/agentEngine.js'), 'utf8');
  for (const name of ['github_push', 'github_apk']) {
    assert(worker.includes(`"${name}"`), `sandbox worker missing ${name}`);
    assert(engine.includes(`'${name}'`), `host engine missing ${name}`);
  }
  for (const provider of ['novita', 'runloop', 'upstashbox', 'daytona']) {
    assert(worker.includes('HOST_TOOLS'), 'sandbox host bridge missing');
    const sandboxAgent = fs.readFileSync(path.join(root, 'services/sandboxAgent.js'), 'utf8');
    assert(sandboxAgent.includes(`${provider}:`), `sandbox registry missing ${provider}`);
  }
}

(async () => {
  await testWorkflowContract();
  await testAtomicPushRetries();
  await testDispatchPollSuccessArtifact();
  await testFailureDiagnostics();
  await testWorkerAndEngineWiring();
  automation.__setFetchForTests(null);
  console.log('✅ GitHub APK automation: push retry, workflow setup, exact-run polling, artifacts, diagnostics, and four-sandbox bridge passed');
})().catch(error => {
  automation.__setFetchForTests(null);
  console.error('❌', error.stack || error.message);
  process.exit(1);
});
