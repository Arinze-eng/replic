#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const daytona = require('../services/daytona');
const sandboxAgent = require('../services/sandboxAgent');
const sandboxBrowser = require('../services/sandboxBrowser');

const originals = {
  daytonaEnabledAsync: daytona.enabledAsync,
  daytonaEnabled: daytona.enabled,
  daytonaGet: daytona.getOrCreateSessionSandbox,
  daytonaExec: daytona.exec,
  resolveActiveBackend: sandboxAgent.resolveActiveBackend,
};

(async () => {
  const selected = {
    enabledAsync: async () => true,
    enabled: () => true,
    getOrCreateSessionSandbox: async () => 'selected-box',
    exec: async () => ({ output: '' }),
  };

  sandboxAgent.resolveActiveBackend = async () => ({ name: 'novita', mod: selected, home: '/home/user' });
  daytona.enabledAsync = async () => true;
  daytona.enabled = () => true;
  daytona.getOrCreateSessionSandbox = async key => `daytona-${key}`;
  daytona.exec = async () => ({ output: '' });

  let resolved = await sandboxBrowser.__test__.resolveSandbox('chat-7');
  assert.equal(resolved.backend, 'daytona', 'Daytona must override the admin-selected sandbox for browsing');
  assert.equal(resolved.id, 'daytona-chat-7', 'Daytona browser session must remain chat-sticky');

  daytona.enabledAsync = async () => false;
  daytona.enabled = () => false;
  resolved = await sandboxBrowser.__test__.resolveSandbox('chat-7');
  assert.equal(resolved.backend, 'novita', 'Admin-selected provider must remain the first sandbox fallback');
  assert.equal(resolved.id, 'selected-box');

  const browserAction = fs.readFileSync(path.join(__dirname, '../services/manusTools.js'), 'utf8');
  const firstTry = browserAction.indexOf("require('./sandboxBrowser')", browserAction.indexOf('async function toolBrowserAction'));
  const browserlessTry = browserAction.indexOf("require('./browserless')", browserAction.indexOf('async function toolBrowserAction'));
  assert(firstTry > 0 && firstTry < browserlessTry, 'browser_action must attempt sandbox-native Daytona before Browserless');
  assert(browserAction.includes('Daytona browser session is paused and saved'), 'browser_action must preserve OTP/2FA handoff');

  console.log('✅ Daytona-first browsing: admin-independent priority, sticky sessions, fallback, and auth pause passed');
})().finally(() => {
  daytona.enabledAsync = originals.daytonaEnabledAsync;
  daytona.enabled = originals.daytonaEnabled;
  daytona.getOrCreateSessionSandbox = originals.daytonaGet;
  daytona.exec = originals.daytonaExec;
  sandboxAgent.resolveActiveBackend = originals.resolveActiveBackend;
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
