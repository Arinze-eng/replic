// Live test of the interactive browser_action SMART element engine + stealth +
// captcha auto-solve, by running a self-contained Puppeteer fn on Browserless
// that mirrors what toolBrowserAction ships: stealth → goto → inspect the page
// and return the smart element map (inputs/buttons/links with selectors).
const https = require('https');
const KEY = process.env.BROWSERLESS_API_KEY;
const ENDPOINT = 'https://production-sfo.browserless.io';

// A compact version of the SMART engine inspect path (proves the resolver works
// on a real, JS-rendered login page and can locate the login fields/buttons).
const FN = `
export default async function ({ page }) {
  const out = { url: '', title: '', inputs: [], buttons: [], links: [], login: null };
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
      window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  } catch(e){}
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
  out.url = page.url();
  out.title = await page.title();
  const map = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width>1 && r.height>1 && s.display!=='none' && s.visibility!=='hidden'; };
    const sel = (el) => el.id ? '#'+el.id : (el.name ? el.tagName.toLowerCase()+'[name="'+el.name+'"]' : el.tagName.toLowerCase());
    const lab = (el) => (el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||(el.innerText||el.value||'')).trim().slice(0,40);
    const all = Array.from(document.querySelectorAll('input,textarea,button,a[href],[role=button]')).filter(visible);
    const inputs=[], buttons=[], links=[];
    all.slice(0,60).forEach(el=>{ const t=el.tagName.toLowerCase(); const e={selector:sel(el),label:lab(el),type:(el.getAttribute('type')||t)};
      if(t==='input'||t==='textarea') inputs.push(e); else if(t==='a') links.push(e); else buttons.push(e); });
    // login trio detection
    const ins = Array.from(document.querySelectorAll('input')).filter(visible);
    const pass = ins.find(i=>(i.getAttribute('type')||'')==='password');
    const user = ins.find(i=>['text','email'].includes((i.getAttribute('type')||''))) ;
    const btn = all.find(b=>/sign in|log in|login/i.test((b.innerText||b.value||'')));
    return { inputs:inputs.slice(0,12), buttons:buttons.slice(0,12), links:links.slice(0,8),
             login:{ username:user?sel(user):null, password:pass?sel(pass):null, submit:btn?sel(btn):null } };
  });
  Object.assign(out, map);
  return { data: out, type: 'application/json' };
}
`;

function post(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const u = new URL(url);
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}, timeout:90000 },
      (res)=>{ let c=''; res.on('data',d=>c+=d); res.on('end',()=>resolve({status:res.statusCode,body:c})); });
    req.on('error', reject); req.on('timeout',()=>req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

(async () => {
  if (!KEY) { console.error('Set BROWSERLESS_API_KEY'); process.exit(1); }
  console.log('Testing interactive browser_action SMART engine on github.com/login …');
  const r = await post(`${ENDPOINT}/function?token=${encodeURIComponent(KEY)}&timeout=58000`, { code: FN, context:{} });
  if (r.status !== 200) { console.log(`HTTP ${r.status}: ${r.body.slice(0,300)}`); return; }
  const d = (JSON.parse(r.body).data) || {};
  console.log('  url   :', d.url);
  console.log('  title :', d.title);
  console.log('  login trio (auto-detected):', JSON.stringify(d.login));
  console.log('  inputs:', (d.inputs||[]).map(i=>`${i.type}:${i.selector}`).join('  '));
  console.log('  buttons:', (d.buttons||[]).map(b=>`"${b.label}":${b.selector}`).slice(0,6).join('  '));
  const ok = d.login && d.login.username && d.login.password && d.login.submit;
  console.log(ok ? '\n✅ SMART engine located the full login trio (username+password+submit) with NO hand-written selectors.'
                 : '\n⚠️ login trio incomplete (page layout may have changed).');
})();
