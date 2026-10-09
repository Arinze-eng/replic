// ─────────────────────────────────────────────────────────────────────────────
// sandboxBrowser.js — SANDBOX-NATIVE REAL-TIME BROWSING (Novita / Daytona / any
// active backend), with CAPTCHA solving + navigation skills baked in.
//
// The product ask: "enable real time browsing in Novita sandbox and Daytona so
// ANY sandbox an admin switches to will do real-time browsing, and add browsing
// skill + tool + captcha solver + navigation skills."
//
// HOW IT WORKS
//   Instead of only using the managed Browserless service, this module drives a
//   REAL Chromium via Playwright INSIDE whichever sandbox backend the admin has
//   selected (resolveActiveBackend() → daytona | novita | codesandbox | …). It:
//     1. Ensures the active sandbox has Python + Playwright + Chromium installed
//        (idempotent, sentinel-guarded so it only installs once per sandbox).
//     2. Ships a self-contained Python driver (stealth + detect→solve→verify
//        captcha loop + navigation actions) into the sandbox.
//     3. Runs it via the backend's exec() and returns the unblocked page
//        (title, text, html, cookies, final url, screenshot path, log).
//
//   Because it goes through sandboxAgent.resolveActiveBackend(), switching the
//   admin "Active sandbox" selector transparently moves real-time browsing to
//   that backend — no code change needed.
//
//   BEST-EFFORT: if the sandbox can't install Playwright (locked-down image),
//   the caller (agentEngine.toolBrowse) transparently falls back to the existing
//   Browserless captchaSolver, so browsing NEVER hard-fails.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
let sandboxAgent = null;
let daytona = null;
try { sandboxAgent = require('./sandboxAgent'); } catch (_) { sandboxAgent = null; }
try { daytona = require('./daytona'); } catch (_) { daytona = null; }

const SENTINEL = '/tmp/.pw_ready';

async function _isEnabled(mod) {
  if (!mod) return false;
  try { if (mod.enabledAsync) return !!(await mod.enabledAsync()); } catch (_) {}
  try { return !!(mod.enabled && mod.enabled()); } catch (_) { return false; }
}

async function _openBackend(active, sessionKey) {
  if (!active || !active.mod) return null;
  const mod = active.mod;
  if (!mod.getOrCreateSessionSandbox || !mod.exec || !(await _isEnabled(mod))) return null;
  let id = null;
  try {
    // Reuse the SAME provider-specific persistent sandbox for this chat, so
    // cookies, browser storage and paused OTP/2FA checkpoints survive calls.
    id = await mod.getOrCreateSessionSandbox(sessionKey || 'browser');
    if (id && typeof id === 'object') id = id.id || null;
  } catch (_) { id = null; }
  if (!id) return null;
  return {
    backend: active.name, mod, id, home: active.home || '/home/user',
    perCommand: !!(active.perCommand || (mod && mod.perCommand)),
  };
}

// Browsing has its own provider policy: Daytona is ALWAYS attempted first,
// irrespective of the admin's general-purpose sandbox selection. Only when
// Daytona is unconfigured or cannot provision a browser session do we fall back
// to the admin-selected provider and then the existing Browserless/scraper chain.
// Non-browsing code/OCR/build workloads continue to honour the admin selector.
async function _resolveSandbox(sessionKey) {
  const first = await _openBackend({ name: 'daytona', mod: daytona, home: '/home/daytona' }, sessionKey);
  if (first) return first;

  if (!sandboxAgent || !sandboxAgent.resolveActiveBackend) return null;
  let active = null;
  try { active = await sandboxAgent.resolveActiveBackend(); } catch (_) { active = null; }
  // Avoid retrying Daytona when its first attempt already failed.
  if (!active || active.name === 'daytona') return null;
  return _openBackend(active, sessionKey);
}

// ── Idempotent install of Python + Playwright + Chromium inside the sandbox ──
async function ensureBrowser(sessionKey) {
  const sb = await _resolveSandbox(sessionKey);
  if (!sb) return { ok: false, error: 'no active sandbox backend available' };
  const { mod, id } = sb;

  // Fast path: sentinel present → already installed.
  try {
    const chk = await mod.exec(id, `test -f ${SENTINEL} && echo READY || echo MISSING`, { cwd: null, timeout: 30 });
    const out = String((chk && (chk.output || chk.stdout)) || '');
    if (/READY/.test(out)) return { ok: true, ...sb, cached: true };
  } catch (_) {}

  // Install. Try pip (Debian/Ubuntu Novita image) with system chromium deps.
  const install = [
    'set -e',
    '( command -v apt-get >/dev/null 2>&1 && (apt-get update -y >/dev/null 2>&1 || sudo apt-get update -y >/dev/null 2>&1) ) || true',
    '( python3 -m pip --version >/dev/null 2>&1 || (apt-get install -y python3-pip >/dev/null 2>&1 || sudo apt-get install -y python3-pip >/dev/null 2>&1) ) || true',
    'python3 -m pip install --quiet --upgrade playwright >/dev/null 2>&1 || pip install --quiet playwright >/dev/null 2>&1 || true',
    // Install chromium + OS deps. --with-deps needs root; fall back without it.
    'python3 -m playwright install --with-deps chromium >/dev/null 2>&1 || python3 -m playwright install chromium >/dev/null 2>&1 || true',
    // Verify chromium actually landed before writing the sentinel.
    'python3 -c "from playwright.sync_api import sync_playwright" >/dev/null 2>&1 && touch ' + SENTINEL + ' && echo INSTALLED || echo FAILED',
  ].join(' && ');

  let res = null;
  try { res = await mod.exec(id, install, { cwd: null, timeout: 280 }); } catch (e) { return { ok: false, error: 'install exec failed: ' + e.message }; }
  const out = String((res && (res.output || res.stdout)) || '');
  if (/INSTALLED/.test(out)) return { ok: true, ...sb, cached: false };
  return { ok: false, error: 'Playwright/Chromium install did not complete in this sandbox image', ...sb };
}

// The Python driver that runs inside the sandbox. Self-contained: stealth init,
// navigation, a detect→solve→verify captcha loop (Cloudflare / Turnstile /
// reCAPTCHA / hCaptcha / generic / slider), and structured JSON output.
function _driverPython() {
  return String.raw`
import sys, json, time, base64
from playwright.sync_api import sync_playwright

cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
url = cfg.get("url")
max_rounds = int(cfg.get("max_rounds", 10))
actions = cfg.get("actions", [])
shot = cfg.get("screenshot", True)
log = []
def note(m): log.append(str(m))

STEALTH = """
Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
window.chrome={runtime:{}};
"""

def challenge_state(page):
    st={'cf':False,'turnstile':False,'recaptcha':False,'hcaptcha':False,'slider':False,'generic':False}
    try:
        title=(page.title() or '').lower()
    except Exception:
        title=''
    if any(k in title for k in ['just a moment','attention required','checking your browser','please wait']):
        st['cf']=True
    try: st['turnstile']=page.query_selector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') is not None
    except Exception: pass
    try: st['recaptcha']=page.query_selector('iframe[src*="recaptcha/api2/anchor"], .g-recaptcha') is not None
    except Exception: pass
    try: st['hcaptcha']=page.query_selector('iframe[src*="hcaptcha.com"], .h-captcha') is not None
    except Exception: pass
    try: st['slider']=page.query_selector('.geetest_slider_button, .yidun_slider, [class*="slide-verify"]') is not None
    except Exception: pass
    try:
        body=(page.inner_text('body') or '').lower()
        st['generic']=any(k in body for k in ['verify you are human','i am not a robot','are you a robot'])
    except Exception: pass
    st['blocked']=any([st['cf'],st['turnstile'],st['recaptcha'],st['hcaptcha'],st['slider'],st['generic']])
    return st

def click_frame(page, pat, sels):
    for f in page.frames:
        if pat in (f.url or ''):
            for s in sels:
                try:
                    el=f.query_selector(s)
                    if el: el.click(timeout=3000); return True
                except Exception: pass
    return False

def attempt(page, st):
    if st['cf'] or st['turnstile']:
        click_frame(page,'challenges.cloudflare.com',['input[type=checkbox]','[tabindex="0"]','label','body'])
    if st['recaptcha']:
        click_frame(page,'recaptcha/api2/anchor',['#recaptcha-anchor','.recaptcha-checkbox-border'])
    if st['hcaptcha']:
        click_frame(page,'hcaptcha.com',['#checkbox','.check','[role=checkbox]'])
    if st['slider']:
        try:
            h=page.query_selector('.geetest_slider_button, .yidun_slider, [class*="slide-verify"]')
            if h:
                b=h.bounding_box()
                if b:
                    page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2)
                    page.mouse.down()
                    for i in range(1,26):
                        page.mouse.move(b['x']+b['width']/2+i*9,b['y']+b['height']/2+((-1)**i))
                        time.sleep(0.02)
                    page.mouse.up()
        except Exception: pass
    if st['generic']:
        try:
            page.click('text=/verify|human|continue|proceed|i am not a robot/i', timeout=2500)
        except Exception: pass

def auth_challenge(page):
    """Detect a human authentication checkpoint without ever reading a code."""
    info={'required':False,'kind':None,'selector':None,'message':None}
    try:
        body=(page.inner_text('body') or '').lower()
    except Exception:
        body=''
    selectors=[
      'input[autocomplete="one-time-code"]','input[name*="otp" i]','input[id*="otp" i]',
      'input[name*="verification" i]','input[id*="verification" i]',
      'input[name*="code" i]','input[inputmode="numeric"]'
    ]
    field=None
    for sel in selectors:
        try:
            field=page.query_selector(sel)
            if field and field.is_visible(): info['selector']=sel; break
        except Exception: field=None
    otp_text=any(x in body for x in ['one-time code','one time code','verification code','security code','enter the code','we sent a code','check your phone','check your email'])
    twofa=any(x in body for x in ['two-factor','two factor','2fa','authenticator app','multi-factor','multifactor'])
    approval=any(x in body for x in ['approve sign in','approve this login','check your device','confirm this login','push notification'])
    if field or otp_text or twofa or approval:
        info['required']=True
        info['kind']='approval' if approval and not field else ('2fa' if twofa else 'otp')
        info['message']='Authentication is waiting for user approval.' if info['kind']=='approval' else 'Authentication is waiting for a user-provided one-time code.'
    return info

state_path=cfg.get('state_path')
resume_path=(state_path+'.resume.json') if state_path else None
resume_auth=bool(actions and actions[0].get('action') in ['otp','two_factor','2fa','resume_auth'])
if resume_auth and resume_path:
    try:
        import os
        if os.path.exists(resume_path):
            with open(resume_path,'r') as f:
                saved=json.load(f)
                if saved.get('url'): url=saved['url']
    except Exception as e: note('resume metadata: '+str(e))
ctx_opts={'user_agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
          'viewport':{'width':1366,'height':768},'locale':'en-US'}
if state_path:
    try:
        import os
        if os.path.exists(state_path): ctx_opts['storage_state']=state_path
    except Exception: pass
out={'ok':False,'solved':False,'url':url,'auth':{'required':False}}
with sync_playwright() as p:
    browser=p.chromium.launch(args=['--no-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage'])
    ctx=browser.new_context(**ctx_opts)
    ctx.add_init_script(STEALTH)
    page=ctx.new_page()
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=40000)
        out['ok']=True
    except Exception as e:
        note('goto: '+str(e))
    # captcha loop
    r=0; st=challenge_state(page)
    while st['blocked'] and r<max_rounds:
        attempt(page, st); time.sleep(1.8)
        try: page.wait_for_load_state('networkidle', timeout=3000)
        except Exception: pass
        st=challenge_state(page); r+=1
    # optional navigation actions after unblock. OTP/2FA codes are accepted only
    # as explicit user-provided action values; the browser never invents them.
    for a in actions:
        try:
            t=a.get('action')
            if t=='click': page.click(a['selector'], timeout=8000)
            elif t in ['type','fill','otp','two_factor','2fa']:
                sel=a.get('selector')
                if not sel and t in ['otp','two_factor','2fa']:
                    sel=(auth_challenge(page) or {}).get('selector')
                if not sel: raise Exception('no authentication-code field found')
                page.fill(sel, str(a.get('text',a.get('value',a.get('code','')))), timeout=8000)
            elif t=='press': page.press(a.get('selector','body'), a.get('key','Enter'))
            elif t=='wait': time.sleep(min(10, float(a.get('seconds',1))))
            elif t=='goto': page.goto(a['url'], wait_until='domcontentloaded', timeout=30000)
            elif t=='scroll': page.mouse.wheel(0, int(a.get('y',1200)))
            note('did '+t)
        except Exception as e:
            note('action '+str(t)+' err: '+str(e))
    out['auth']=auth_challenge(page)
    if out['auth'].get('required'): note('paused for user '+str(out['auth'].get('kind') or 'authentication'))
    try: out['title']=page.title()
    except Exception: out['title']=''
    try: out['text']=(page.inner_text('body') or '')[:12000]
    except Exception: out['text']=''
    try: out['html']=(page.content() or '')[:80000]
    except Exception: out['html']=''
    try:
        out['cookies']={c['name']:c['value'] for c in ctx.cookies()}
        out['hasCfClearance']='cf_clearance' in out['cookies']
    except Exception: out['cookies']={}
    try: out['finalUrl']=page.url
    except Exception: out['finalUrl']=url
    if shot:
        try:
            path='/tmp/pw_shot.jpg'; page.screenshot(path=path, type='jpeg', quality=60)
            with open(path,'rb') as f: out['screenshot']='data:image/jpeg;base64,'+base64.b64encode(f.read()).decode()
        except Exception: pass
    st=challenge_state(page)
    out['solved']=(not st['blocked'])
    out['rounds']=r; out['log']=log
    # Persist cookies/local session state before returning an OTP/2FA checkpoint.
    # The next call reuses it in the same sandbox, so authentication continues
    # instead of navigating from scratch.
    if state_path:
        try: ctx.storage_state(path=state_path)
        except Exception as e: note('state save: '+str(e))
        try:
            with open(resume_path,'w') as f: json.dump({'url':page.url,'auth':out['auth']},f)
        except Exception as e: note('resume save: '+str(e))
    browser.close()
print("PWRESULT_START"+json.dumps(out)+"PWRESULT_END")
`;
}

// ── Public: browse a URL inside the active sandbox with real Chromium. ───────
// opts: { sessionKey, maxRounds, actions:[{action,...}], screenshot }
async function browseInSandbox(url, opts = {}) {
  const target = /^https?:/.test(url) ? url : ('https://' + url);

  // A stable, non-secret per-chat state file lets an OTP/2FA handoff resume the
  // exact authenticated flow on the next call. It contains browser state only
  // and stays inside the persistent sandbox.
  const stateId = crypto.createHash('sha256').update(String(opts.sessionKey || 'browser')).digest('hex').slice(0, 24);
  const cfg = JSON.stringify({
    url: target,
    max_rounds: opts.maxRounds || 10,
    actions: Array.isArray(opts.actions) ? opts.actions : [],
    screenshot: opts.screenshot !== false,
    state_path: `/tmp/powerx-browser-${stateId}.json`,
  });
  const cfgB64 = Buffer.from(cfg).toString('base64');
  const driverB64 = Buffer.from(_driverPython()).toString('base64');

  // 🐙 PER-COMMAND BACKENDS (GitHub Actions): each exec() is a fresh, short-lived
  // runner — the /tmp sentinel from ensureBrowser() would be gone by the time we
  // dispatch the driver, and a launch→navigate→screenshot flow cannot span
  // multiple dispatches. So we do EVERYTHING in ONE self-contained command:
  // install Python+Playwright+Chromium (with root apt deps — GHA runners are
  // full root Ubuntu) and immediately drive the page, all inside a single runner.
  // The screenshot is written into the sandbox WORK dir (persisted in git) so the
  // agent can deliver it, not just /tmp (which evaporates with the runner).
  const sbInfo = await _resolveSandbox(opts.sessionKey);
  if (!sbInfo) return { ok: false, error: 'no active sandbox backend available', backend: null };

  if (sbInfo.perCommand) {
    const { mod, id, backend, home } = sbInfo;
    const workShot = 'browser_screenshot.jpg'; // relative to the runner work dir
    const combined = [
      'set +e',
      // Install once per runner (fast no-op on warm images that already have it).
      '( command -v apt-get >/dev/null 2>&1 && (sudo apt-get update -y >/dev/null 2>&1 || apt-get update -y >/dev/null 2>&1) ) || true',
      '( python3 -m pip --version >/dev/null 2>&1 || (sudo apt-get install -y python3-pip >/dev/null 2>&1 || apt-get install -y python3-pip >/dev/null 2>&1) ) || true',
      '( python3 -c "import playwright" >/dev/null 2>&1 || python3 -m pip install --quiet playwright >/dev/null 2>&1 || pip install --quiet playwright >/dev/null 2>&1 ) || true',
      '( python3 -m playwright install --with-deps chromium >/dev/null 2>&1 || sudo python3 -m playwright install --with-deps chromium >/dev/null 2>&1 || python3 -m playwright install chromium >/dev/null 2>&1 ) || true',
      // Write the driver + config, then drive the page. Screenshot is copied into
      // the current work dir so it persists as a deliverable.
      `printf %s '${driverB64}' | base64 -d > /tmp/pw_driver.py`,
      `printf %s '${cfgB64}' | base64 -d > /tmp/pw_cfg.json`,
      `python3 /tmp/pw_driver.py "$(cat /tmp/pw_cfg.json)" 2>/tmp/pw_err.log`,
      `( [ -f /tmp/pw_shot.jpg ] && cp /tmp/pw_shot.jpg ./${workShot} ) || true`,
    ].join('\n');

    let res = null;
    // Generous timeout: first-run Chromium install can take 2–4 min; the GHA
    // backend also enforces its own hard wall-clock cap so this can't hang forever.
    try { res = await mod.exec(id, combined, { cwd: home ? `${home}/work` : null, timeout: 600 }); }
    catch (e) { return { ok: false, error: 'sandbox browse exec failed (perCommand): ' + e.message, backend }; }

    const raw = String((res && (res.output || res.stdout)) || '');
    const m = raw.match(/PWRESULT_START([\s\S]*?)PWRESULT_END/);
    if (!m) return { ok: false, error: 'sandbox browser produced no result (runner may lack Chromium deps)', backend, raw: raw.slice(-600) };
    let data = {};
    try { data = JSON.parse(m[1]); } catch (_) { return { ok: false, error: 'bad driver output', backend }; }
    return {
      ok: !!data.ok, solved: !!data.solved, backend,
      title: data.title || '', text: data.text || '', html: data.html || '',
      cookies: data.cookies || {}, hasCfClearance: !!data.hasCfClearance,
      finalUrl: data.finalUrl || target,
      screenshot: data.screenshot || null,
      // The persisted deliverable path (relative to the work dir) the agent can zip/return.
      screenshotFile: workShot,
      rounds: data.rounds || 0, log: data.log || [], auth: data.auth || { required: false },
    };
  }

  // ── ALWAYS-ON BACKENDS (Novita/Daytona/CodeSandbox/…): the classic two-step ──
  // install (idempotent, sentinel-cached) then drive.
  const ready = await ensureBrowser(opts.sessionKey);
  if (!ready.ok) return { ok: false, error: ready.error || 'sandbox browser unavailable', backend: ready.backend || null };
  const { mod, id, backend } = ready;

  // Write the driver + config into the sandbox, then run it.
  const cmd = [
    `printf %s '${driverB64}' | base64 -d > /tmp/pw_driver.py`,
    `printf %s '${cfgB64}' | base64 -d > /tmp/pw_cfg.json`,
    `python3 /tmp/pw_driver.py "$(cat /tmp/pw_cfg.json)" 2>/tmp/pw_err.log`,
  ].join(' && ');

  let res = null;
  try { res = await mod.exec(id, cmd, { cwd: null, timeout: 150 }); }
  catch (e) { return { ok: false, error: 'sandbox browse exec failed: ' + e.message, backend }; }

  const raw = String((res && (res.output || res.stdout)) || '');
  const m = raw.match(/PWRESULT_START([\s\S]*?)PWRESULT_END/);
  if (!m) return { ok: false, error: 'sandbox browser produced no result (image may lack Chromium deps)', backend, raw: raw.slice(0, 400) };
  let data = {};
  try { data = JSON.parse(m[1]); } catch (_) { return { ok: false, error: 'bad driver output', backend }; }
  return {
    ok: !!data.ok,
    solved: !!data.solved,
    backend,
    title: data.title || '',
    text: data.text || '',
    html: data.html || '',
    cookies: data.cookies || {},
    hasCfClearance: !!data.hasCfClearance,
    finalUrl: data.finalUrl || target,
    screenshot: data.screenshot || null,
    rounds: data.rounds || 0,
    log: data.log || [],
    auth: data.auth || { required: false },
  };
}

// Is sandbox-native browsing even possible right now (a backend is configured)?
async function available() {
  try { const sb = await _resolveSandbox('probe'); return !!sb; } catch (_) { return false; }
}

module.exports = { ensureBrowser, browseInSandbox, available, __test__: { resolveSandbox: _resolveSandbox } };
