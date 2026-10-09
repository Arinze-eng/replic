// test-browser-smart.js — validates the smart browser_action engine.
//
// 1) Generates the remote Puppeteer fnCode the tool ships to Browserless and
//    asserts it parses as valid JS (a syntax error there = silent prod failure).
// 2) Loads the in-page SMART() engine in a jsdom-free shim and exercises the
//    resolver / findLogin / inspect logic against a synthetic login DOM so we
//    KNOW it locates username/password/submit without exact selectors.
//
// Run: node scripts/test-browser-smart.js
'use strict';

const vm = require('vm');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the generated remote function must be syntactically valid JS.
// We reproduce the exact fnCode the tool builds by calling toolBrowserAction with
// a stubbed Browserless fetch that captures the body instead of hitting the net.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Remote Puppeteer fnCode syntax');

// Force a fake key BEFORE requiring manusTools so the tool proceeds.
process.env.BROWSERLESS_API_KEY = 'TEST_KEY';

// Monkey-patch node-fetch in the require cache FIRST, then require the modules
// so manusTools binds to our intercepting fetch (it captures `fetch` at load).
let capturedBody = null;
const fetchModulePath = require.resolve('node-fetch');
require(fetchModulePath); // ensure it's in cache
const fetchCached = require.cache[fetchModulePath];
const realFetch = fetchCached.exports;
const fakeFetch = async function (url, options) {
  capturedBody = options && options.body;
  return {
    ok: true,
    status: 200,
    async json() { return { data: { log: ['ok: test'], text: 'hello', elements: { inputs: [], buttons: [], links: [], forms: 0 } } }; },
    async text() { return ''; },
    async buffer() { return Buffer.from(''); },
  };
};
fetchCached.exports = fakeFetch;

const manus = require('../services/manusTools');
const browserless = require('../services/browserless');

// Force a fake key so the tool proceeds to build & POST the fnCode.
const origGetKey = browserless.getKey;
browserless.getKey = async () => 'TEST_KEY';

(async () => {
  const ctx = { onStep() {}, deliverBuffer: async () => {} };
  await manus.toolBrowserAction({
    url: 'https://example.com',
    steps: [
      { action: 'inspect' },
      { action: 'fill', field: 'username', value: 'alice' },
      { action: 'fill', field: 'password', value: 'secret' },
      { action: 'click', text: 'Log in' },
      { action: 'smart_login', username: 'bob', password: 'pw' },
    ],
    screenshot: true,
    login: { username: 'carol', password: 'pw2' },
  }, ctx);

  // restore
  fetchCached.exports = realFetch;
  browserless.getKey = origGetKey;

  ok('fnCode was generated', typeof capturedBody === 'string' && capturedBody.length > 500);

  // The body is `export default async function(...){...}`. Wrap it so we can
  // syntax-check it as a real ES module body via the VM (SourceTextModule needs
  // a flag, so instead we strip the `export default` and compile as a function).
  const stripped = capturedBody.replace(/^\s*export\s+default\s+/, '');
  let syntaxOk = true, errMsg = '';
  try {
    // Compile (does NOT run) — throws on syntax error.
    new vm.Script('(' + stripped + ')');
  } catch (e) { syntaxOk = false; errMsg = e.message; }
  ok('remote fnCode parses as valid JS' + (syntaxOk ? '' : ' — ' + errMsg), syntaxOk);

  // Sanity: it must reference the smart engine + new actions.
  ok('fnCode contains SMART engine', /W\.__smart\s*=/.test(capturedBody));
  ok('fnCode handles smart_login', /smart_login|doSmartLogin/.test(capturedBody));
  ok('fnCode handles fill', /'fill'|act === 'fill'/.test(capturedBody) || capturedBody.includes("act === 'fill'"));
  ok('fnCode handles inspect', capturedBody.includes("act === 'inspect'"));

  // ───────────────────────────────────────────────────────────────────────────
  // PART 2 — exercise the in-page SMART() resolver against a synthetic DOM.
  // We extract the SMART function source from the fnCode and run it inside a VM
  // with a hand-rolled minimal DOM that mimics a real login page.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[2] In-page smart resolver against a synthetic login DOM');

  // Extract `const SMART = () => { ... };` body from manusTools source directly.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/manusTools'), 'utf8');
  const m = src.match(/const SMART = \(\) => \{([\s\S]*?)\n  \};/);
  ok('extracted SMART() source from module', !!m);
  if (!m) { return finish(); }
  const smartBody = m[1];

  // Build a synthetic DOM: a username input, a password input, a Login button.
  const dom = buildLoginDom();
  const sandbox = makeWindow(dom);
  vm.createContext(sandbox);
  // Define & invoke SMART() inside the sandbox, then call its methods.
  vm.runInContext('var SMART = () => {' + smartBody + '\n}; SMART();', sandbox);

  const login = vm.runInContext('window.__smart.findLogin()', sandbox);
  console.log('    findLogin →', JSON.stringify(login));
  ok('findLogin located a username field', !!login.username);
  ok('findLogin located the password field', !!login.password);
  ok('findLogin located a submit button', !!login.submit);

  const byText = vm.runInContext('window.__smart.resolve("log in", "click")', sandbox);
  console.log('    resolve("log in","click") →', JSON.stringify(byText));
  ok('resolve found the Login button by text', !!(byText && byText.selector));

  const byField = vm.runInContext('window.__smart.resolve("password", "input")', sandbox);
  console.log('    resolve("password","input") →', JSON.stringify(byField));
  ok('resolve found the password input by hint', !!(byField && byField.selector));

  const map = vm.runInContext('window.__smart.inspect()', sandbox);
  console.log('    inspect → inputs=' + map.inputs.length + ' buttons=' + map.buttons.length);
  ok('inspect returns >=2 inputs', map.inputs.length >= 2);
  ok('inspect returns >=1 button', map.buttons.length >= 1);

  finish();
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });

function finish() {
  console.log(`\n──────────────\nResult: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

// ── Minimal synthetic DOM + window for the SMART engine ──────────────────────
// Implements just enough of the DOM API the SMART() code touches:
//   querySelector(All), getBoundingClientRect, getComputedStyle, closest,
//   getAttribute, innerText/value/id/name/tagName, previousElementSibling,
//   parentNode/children, form, isContentEditable, onclick, CSS.escape.
function el(tag, props = {}, children = []) {
  const e = {
    tagName: tag.toUpperCase(),
    attributes: {},
    children,
    parentNode: null,
    _innerText: props.innerText || '',
    value: props.value || '',
    onclick: props.onclick || null,
    isContentEditable: !!props.contentEditable,
    form: props.form || null,
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : (props[n] != null ? props[n] : null); },
    setAttribute(n, v) { this.attributes[n] = v; },
    get id() { return props.id || ''; },
    get name() { return props.name || ''; },
    get className() { return props.className || ''; },
    get innerText() { return this._innerText; },
    getBoundingClientRect() { return { width: 100, height: 30, top: 0, left: 0 }; },
    get previousElementSibling() { return props._prev || null; },
    closest(sel) {
      let n = this;
      while (n) {
        if (sel === 'label' && n.tagName === 'LABEL') return n;
        n = n.parentNode;
      }
      return null;
    },
    click() { this._clicked = true; },
  };
  // wire attribute-style props
  ['type', 'placeholder', 'aria-label', 'title', 'role', 'data-testid', 'href'].forEach(k => {
    if (props[k] != null) e.attributes[k] = props[k];
  });
  children.forEach(c => { c.parentNode = e; });
  return e;
}

function buildLoginDom() {
  const userInput = el('input', { id: 'user', name: 'username', type: 'text', placeholder: 'Username' });
  const passInput = el('input', { id: 'pass', name: 'password', type: 'password', placeholder: 'Password' });
  const loginBtn = el('button', { id: 'go', type: 'submit', innerText: 'Log In' });
  const form = el('form', {}, [userInput, passInput, loginBtn]);
  userInput.form = form; passInput.form = form; loginBtn.form = form;
  const body = el('body', { innerText: 'Sign in to your account' }, [form]);
  return { body, all: [userInput, passInput, loginBtn, form, body] };
}

function makeWindow(dom) {
  const matchesSel = (node, sel) => {
    // very small selector matcher: tag, [type=...], input/textarea/select etc.
    const tag = node.tagName.toLowerCase();
    const parts = sel.split(',').map(s => s.trim());
    return parts.some(p => {
      if (p === tag) return true;
      if (p === 'input' || p === 'textarea' || p === 'select' || p === 'button' || p === 'a') return tag === p;
      if (p === 'a[href]') return tag === 'a' && node.getAttribute('href');
      const tm = p.match(/^(\w+)?\[([\w-]+)(?:[\^*$]?=["']?([^"'\]]*)["']?)?\]$/);
      if (tm) {
        const [, t, attr, val] = tm;
        if (t && t !== tag) return false;
        const av = node.getAttribute(attr);
        if (val == null) return av != null;
        return (av || '').toLowerCase() === val.toLowerCase();
      }
      if (p.startsWith('[role=')) return false;
      return false;
    });
  };
  const queryAll = (sel) => dom.all.filter(n => n.tagName && matchesSel(n, sel));
  const document = {
    querySelectorAll(sel) { return queryAll(sel); },
    querySelector(sel) { return queryAll(sel)[0] || null; },
    getElementById(id) { return dom.all.find(n => n.id === id) || null; },
    get body() { return dom.body; },
  };
  return {
    window: {},
    document,
    getComputedStyle() { return { visibility: 'visible', display: 'block', opacity: '1' }; },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    Notification: { permission: 'default' },
    console,
  };
}
