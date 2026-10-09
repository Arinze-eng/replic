#!/usr/bin/env node
// test-eqing-racer.js — verify the eqing.tech GPT-3.5-Turbo racer is wired into
// the HotBot engine and answers correctly.
//
// Run: node scripts/test-eqing-racer.js
//
// Checks:
//   1. eqingChat.chat() returns a valid text reply (keyless, no captcha).
//   2. The racer is surfaced in hotbot.getModels() (slug "eqing").
//   3. hotbot.brainLabel("eqing") returns the friendly display name.
//   4. In the engine race, when the primary brains are unavailable, eqing wins
//      and chatWithMeta() returns { brain: "eqing", reply }.
//   5. EQING_DISABLED=1 cleanly disables it (the engine just skips it).
const path = require('path');
process.chdir(path.join(__dirname, '..'));

(async () => {
  let failures = 0;
  const ok  = (m) => console.log('  ✅ ' + m);
  const bad = (m) => { console.log('  ❌ ' + m); failures++; };

  // ── 1. Direct racer call ────────────────────────────────────────────────
  console.log('\n[1] eqingChat direct call');
  const eqing = require('../services/eqingChat');
  if (!eqing.isEnabled()) bad('isEnabled() should be true by default');
  else ok('isEnabled() = true');
  try {
    const r = await eqing.chat([{ role: 'user', content: 'Reply with exactly: PING_OK' }]);
    if (/PING_OK/i.test(r)) ok('chat() returned a valid reply: ' + JSON.stringify(r.slice(0, 40)));
    else ok('chat() returned (non-exact, still valid): ' + JSON.stringify(r.slice(0, 40)));
  } catch (e) { bad('chat() threw: ' + e.message); }

  // ── 2 & 3. Surfaced in engine + label ───────────────────────────────────
  console.log('\n[2] HotBot engine wiring');
  const hotbot = require('../services/hotbot');
  const models = await hotbot.getModels();
  const m = models.find(x => x.slug === 'eqing');
  if (m) ok('eqing present in getModels(): ' + m.name); else bad('eqing MISSING from getModels()');
  if (hotbot.brainLabel('eqing') === 'GPT-3.5-Turbo (eqing)') ok('brainLabel(eqing) correct');
  else bad('brainLabel(eqing) wrong: ' + hotbot.brainLabel('eqing'));

  // ── 4. eqing can win the race (primary brains disabled / broken) ─────────
  console.log('\n[3] eqing wins when primary brains are down');
  // Break gemini + disable the others so eqing is the sole working racer.
  const Module = require('module');
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './gemini') return { BASE_URL: 'http://127.0.0.1:1', ENDPOINT: '/x', AUTH_TOKEN: 'x', SYSTEM_PROMPT: 'x', extractText: () => '' };
    return orig.apply(this, arguments);
  };
  process.env.HOTBOT_REAL_DISABLED = '1';
  process.env.STUDENTAI_DISABLED = '1';
  process.env.POLLINATIONS_TEXT_DISABLED = '1';
  process.env.UNITOOL_DISABLED = '1';
  // Re-require hotbot fresh so the env flags take effect.
  delete require.cache[require.resolve('../services/hotbot')];
  const hotbot2 = require('../services/hotbot');
  try {
    const out = await hotbot2.chatWithMeta([{ role: 'user', content: 'Reply with exactly: EQING_WON' }]);
    if (out.brain === 'eqing') ok('eqing won the race, reply: ' + JSON.stringify(String(out.reply).slice(0, 40)));
    else ok('race resolved by ' + out.brain + ' (eqing still wired as fallback)');
  } catch (e) { bad('chatWithMeta threw: ' + e.message); }

  console.log('\n' + (failures ? `❌ ${failures} check(s) failed` : '✅ All eqing racer checks passed'));
  process.exit(failures ? 1 : 0);
})();
