#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

for (const rel of ['services/wormgptBot.js', 'services/whatsappBot.js']) {
  const src = read(rel);
  const fallback = src.indexOf('Capy path errored');
  const taskDecl = src.lastIndexOf('const taskForAgent = task;', fallback);
  const tryStart = src.lastIndexOf('\n  try {', fallback);
  assert(taskDecl > 0, `${rel}: missing taskForAgent declaration`);
  assert(taskDecl < tryStart, `${rel}: taskForAgent must remain outside the primary try block`);
  assert(/let history = \[\];/.test(src.slice(taskDecl, tryStart)), `${rel}: fallback history must share function scope`);
}

const browser = read('services/sandboxBrowser.js');
for (const needle of [
  'auth_challenge(page)',
  'input[autocomplete="one-time-code"]',
  "'auth':{'required':False}",
  "ctx.storage_state(path=state_path)",
  "t in ['type','fill','otp','two_factor','2fa']",
  'powerx-browser-${stateId}.json',
]) assert(browser.includes(needle), `sandbox browser missing ${needle}`);

const engine = read('services/agentEngine.js');
assert(engine.includes('AUTHENTICATION_REQUIRED'), 'agent must surface auth checkpoint');
assert(engine.includes('Do not restart navigation'), 'agent must preserve the authentication flow');

const github = read('services/githubAutomation.js');
assert(github.includes('GITHUB_MONITOR_MAX_POLL_ERRORS'), 'GitHub monitor retry budget missing');
assert(github.includes('monitorFailed: true'), 'GitHub monitor must distinguish monitor outage from build failure');

const trading = read('services/manusTools.js');
assert(/function _tradeChatId\(/.test(trading), 'trading monitor chat ownership helper missing');
assert(/function _tradingEngine\(/.test(trading), 'trading engine resolver missing');

console.log('✅ monitor/browser regressions: fallback scope, resilient GitHub/trading monitoring, CAPTCHA path, and resumable OTP/2FA checkpoint passed');
