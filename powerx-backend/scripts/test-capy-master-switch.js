// Standalone logic test for the Capy AI master kill-switch.
// Mocks ../db so capy.js resolves settings from an in-memory map — no network.
const path = require('path');

// In-memory settings the "admin panel" would write.
const SETTINGS = {};

// Inject a fake db module into the require cache BEFORE capy.js lazy-loads it.
const dbPath = require.resolve('../db.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    getSetting: async (k) => (k in SETTINGS ? SETTINGS[k] : ''),
    setSetting: async (k, v) => { SETTINGS[k] = v; },
  }
};

const capy = require('../services/capy.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}: got ${actual}, expected ${expected}`);
}

(async () => {
  // Clear env so DB settings drive the result.
  delete process.env.CAPY_ENABLED;
  delete process.env.CAPY_HEAD;

  // 1) Default (nothing set): master ON, head OFF (default).
  capy.invalidateCache && capy.invalidateCache();
  check('default isEnabled (master) => ON', await capy.isEnabled(), true);

  // 2) Head turned on, master untouched => head enabled.
  SETTINGS['capy_head'] = '1';
  check('head on, master default => head ENABLED', await capy.isHeadEnabled(), true);

  // 3) ADMIN TURNS CAPY OFF (master kill-switch) => head must be DISABLED
  //    even though capy_head is still '1'.
  SETTINGS['capy_enabled'] = '0';
  check('master OFF => isEnabled false', await capy.isEnabled(), false);
  check('master OFF => head DISABLED (despite capy_head=1)', await capy.isHeadEnabled(), false);

  // 4) ADMIN TURNS CAPY BACK ON => head usable again.
  SETTINGS['capy_enabled'] = '1';
  check('master back ON => isEnabled true', await capy.isEnabled(), true);
  check('master back ON => head ENABLED again', await capy.isHeadEnabled(), true);

  // 5) master OFF also wins when head is off anyway.
  SETTINGS['capy_enabled'] = '0';
  SETTINGS['capy_head'] = '0';
  check('master OFF + head off => head DISABLED', await capy.isHeadEnabled(), false);

  // 6) env default ON when no DB setting present.
  delete SETTINGS['capy_enabled'];
  check('no setting => master defaults ON', await capy.isEnabled(), true);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
