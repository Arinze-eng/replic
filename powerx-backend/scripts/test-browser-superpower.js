// test-browser-superpower.js — validates the ENHANCED browser_action engine:
//   • new step actions are wired into the generated Puppeteer fnCode
//   • the in-page SMART() engine exposes findMenus / readPage / findByText
//   • findMenus detects a hamburger toggle on a synthetic nav DOM
//   • readPage groups radio inputs into an exam-question structure
//   • captchaSolver exposes the new slider + external-solver helpers
//
// Run: node scripts/test-browser-superpower.js
'use strict';

const vm = require('vm');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

console.log('\n[1] New browser_action actions present in the tool source');
const src = fs.readFileSync(require.resolve('../services/manusTools'), 'utf8');
[
  ['open_menu / hamburger', "act === 'open_menu'"],
  ['read / extract', "act === 'read'"],
  ['answer_question', "act === 'answer_question'"],
  ['hover', "act === 'hover'"],
  ['check/uncheck', "act === 'check'"],
  ['upload', "act === 'upload'"],
  ['back navigation', "act === 'back'"],
  ['wait_for_text', "act === 'wait_for_text'"],
  ['find', "act === 'find'"],
].forEach(([label, needle]) => ok('action wired: ' + label, src.includes(needle)));

console.log('\n[2] SMART engine exposes the new methods');
// Extract the FULL SMART() body. The engine ends with the line that assigns
// W.__smart = {...}; followed by the closing "  };". Use that as the anchor so
// we capture every helper (findMenus/readPage/findByText included).
const startIdx = src.indexOf('const SMART = () => {');
const anchor = src.indexOf('W.__smart = {', startIdx);
const endIdx = src.indexOf('\n  };', anchor);
ok('located SMART() start', startIdx > 0);
ok('located W.__smart assignment', anchor > startIdx);
ok('located SMART() end', endIdx > anchor);
const smartBody = src.slice(startIdx + 'const SMART = () => {'.length, endIdx);
ok('SMART body mentions findMenus', smartBody.includes('findMenus'));
ok('SMART body mentions readPage', smartBody.includes('readPage'));
ok('SMART body registers new methods', /W\.__smart\s*=\s*\{[^}]*findMenus[^}]*readPage[^}]*findByText/.test(smartBody));

console.log('\n[3] SMART() runs & findMenus detects a hamburger toggle');
const nav = buildNavDom();
const sandbox = makeWindow(nav);
vm.createContext(sandbox);
let ran = true, err = '';
try { vm.runInContext('var SMART = () => {' + smartBody + '\n}; SMART();', sandbox); }
catch (e) { ran = false; err = e.message; }
ok('SMART() executed without error' + (ran ? '' : ' — ' + err), ran);
if (ran) {
  const map = vm.runInContext('window.__smart.inspect()', sandbox);
  console.log('    inspect.menus →', JSON.stringify(map.menus));
  ok('inspect() returns a menus array', Array.isArray(map.menus));
  ok('findMenus detected the hamburger toggle', (map.menus || []).length >= 1);

  const page = vm.runInContext('window.__smart.readPage()', sandbox);
  console.log('    readPage.questions →', (page.questions || []).length, 'group(s)');
  ok('readPage returns a questions array', Array.isArray(page.questions));
  ok('readPage grouped the radio quiz into 1 question', (page.questions || []).length >= 1);
  if ((page.questions || []).length) {
    ok('question has >=2 options with selectors', (page.questions[0].options || []).length >= 2 && !!page.questions[0].options[0].selector);
  }
}

console.log('\n[4] captchaSolver enhancements');
const cap = require('../services/captchaSolver');
ok('exports solveWithExternalService', typeof cap.solveWithExternalService === 'function');
const capSrc = fs.readFileSync(require.resolve('../services/captchaSolver'), 'utf8');
ok('solver source mentions slider', capSrc.includes('solveSlider'));
ok('solver detects slider state', capSrc.includes('info.slider'));
ok('solver detects imageGrid state', capSrc.includes('info.imageGrid'));

console.log(`\n──────────────\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

// ── Synthetic DOM helpers (mirrors test-browser-smart.js, + nav/quiz) ────────
function el(tag, props = {}, children = []) {
  const e = {
    tagName: tag.toUpperCase(),
    attributes: {},
    children,
    parentNode: null,
    _innerText: props.innerText || '',
    value: props.value || '',
    checked: !!props.checked,
    onclick: props.onclick || null,
    isContentEditable: !!props.contentEditable,
    form: props.form || null,
    hasAttribute(n) { return this.attributes[n] != null || props[n] != null; },
    getAttribute(n) { return this.attributes[n] != null ? this.attributes[n] : (props[n] != null ? props[n] : null); },
    setAttribute(n, v) { this.attributes[n] = v; },
    get id() { return props.id || ''; },
    get name() { return props.name || ''; },
    get className() { return props.className || ''; },
    get innerText() { return this._innerText; },
    get textContent() { return this._innerText; },
    get parentElement() { return this.parentNode; },
    getBoundingClientRect() { return { x: 10, y: 10, width: 100, height: 30, top: 10, left: 10 }; },
    get previousElementSibling() { return props._prev || null; },
    querySelector(sel) { return (this.children || []).find(c => c.tagName && (c.tagName.toLowerCase() === sel || sel.includes(c.tagName.toLowerCase()))) || null; },
    querySelectorAll(sel) { return (this.children || []).filter(c => c.tagName && sel.includes(c.tagName.toLowerCase())); },
    closest(sel) {
      let n = this;
      while (n) {
        const t = n.tagName ? n.tagName.toLowerCase() : '';
        if (sel.split(',').some(s => s.trim() === t || s.includes(t))) return n;
        n = n.parentNode;
      }
      return null;
    },
    click() { this._clicked = true; },
    dispatchEvent() {},
  };
  ['type', 'placeholder', 'aria-label', 'aria-controls', 'aria-expanded', 'title', 'role', 'data-testid', 'href'].forEach(k => {
    if (props[k] != null) e.attributes[k] = props[k];
  });
  children.forEach(c => { c.parentNode = e; });
  return e;
}

function buildNavDom() {
  // A header with a hamburger button (aria-label="Open menu", class "hamburger").
  const burger = el('button', { id: 'burger', className: 'hamburger nav-toggle', 'aria-label': 'Open menu', 'aria-controls': 'nav', innerText: '' });
  const header = el('header', { className: 'site-header' }, [burger]);
  // A radio quiz: 1 question, 3 options.
  const legend = el('legend', { innerText: 'What is 2 + 2?' });
  const o1 = el('input', { id: 'q1a', name: 'q1', type: 'radio', value: '3' });
  const l1 = el('label', { innerText: '3' }, [o1]); o1.form = null;
  const o2 = el('input', { id: 'q1b', name: 'q1', type: 'radio', value: '4' });
  const l2 = el('label', { innerText: '4' }, [o2]);
  const o3 = el('input', { id: 'q1c', name: 'q1', type: 'radio', value: '5' });
  const l3 = el('label', { innerText: '5' }, [o3]);
  const fs2 = el('fieldset', {}, [legend, l1, l2, l3]);
  const body = el('body', { innerText: 'Practice Exam' }, [header, fs2]);
  const all = [burger, header, legend, o1, l1, o2, l2, o3, l3, fs2, body];
  return { body, all };
}

function makeWindow(dom) {
  const matchesSel = (node, sel) => {
    const tag = node.tagName.toLowerCase();
    const parts = sel.split(',').map(s => s.trim());
    return parts.some(p => {
      if (p === tag) return true;
      if (['input', 'textarea', 'select', 'button', 'a', 'svg', 'i', 'header', 'nav', 'form', 'legend', 'fieldset', 'label', 'p', 'h1', 'h2', 'h3'].includes(p)) return tag === p;
      if (p === 'a[href]') return tag === 'a' && node.getAttribute('href');
      // [attr], tag[attr], [attr*="x" i], [class*="menu" i], [id*="menu" i]
      const tm = p.match(/^(\w+)?\[([\w-]+)\s*(?:([\^*$]?)=\s*["']?([^"'\]]*)["']?)?\s*(i)?\]$/);
      if (tm) {
        const [, t, attr, op, val] = tm;
        if (t && t !== tag) return false;
        let av = attr === 'class' ? node.className : (attr === 'id' ? node.id : node.getAttribute(attr));
        av = (av || '').toLowerCase();
        if (val == null || val === '') return av != null && av !== '';
        const v = val.toLowerCase();
        if (op === '*') return av.includes(v);
        if (op === '^') return av.startsWith(v);
        if (op === '$') return av.endsWith(v);
        return av === v;
      }
      return false;
    });
  };
  const queryAll = (sel) => dom.all.filter(n => n.tagName && matchesSel(n, sel));
  const document = {
    querySelectorAll(sel) { return queryAll(sel); },
    querySelector(sel) { return queryAll(sel)[0] || null; },
    getElementById(id) { return dom.all.find(n => n.id === id) || null; },
    get body() { return dom.body; },
    get title() { return 'Practice Exam'; },
  };
  return {
    window: {},
    document,
    location: { href: 'https://exam.example/quiz' },
    getComputedStyle() { return { visibility: 'visible', display: 'block', opacity: '1' }; },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    Notification: { permission: 'default' },
    MouseEvent: function () {},
    console,
  };
}
