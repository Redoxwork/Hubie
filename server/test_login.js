// Login + demo recon test.
// Opens Housebets in real Chrome, closes popups, logs in as Hubie, opens dice and a slot,
// switches to demo if it can, and saves screenshots + notes.
// SAFETY: this script never clicks bet/spin/deposit/buy. It only looks.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots', 'manual');
const PROFILE = process.env.PROFILE_DIR || path.join(__dirname, '..', 'data', 'chrome-profile');
const BASE = 'https://www.housebets.com';
fs.mkdirSync(OUT, { recursive: true });

const notes = [];
const note = (...a) => { const s = a.join(' '); console.log(s); notes.push(s); };
let n = 0;
const num = () => String(n).padStart(2, '0');

async function shot(page, name) {
  n++;
  const f = `${num()}-${name}.png`;
  try { await page.screenshot({ path: path.join(OUT, f) }); note('📸', f); }
  catch (e) { note('screenshot failed', name, e.message); }
}

// Only these labels are ever clicked to close things. Anything money-related is never clicked.
const SAFE_CLOSE = /^(maybe later|close|close modal|close dialog|no thanks|not now|got it|accept|accept all|i agree|dismiss|skip|×|✕)$/i;
const NEVER = /deposit|withdraw|buy|purchase|cashier|bet|spin|wager|real money|claim/i;

async function closePopups(page) {
  for (let round = 0; round < 4; round++) {
    const hit = await page.evaluate(({ safe, never }) => {
      const SAFE = new RegExp(safe, 'i'), NEV = new RegExp(never, 'i');
      const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      // buttons only: links (like the X/Twitter social link) navigate away
      for (const e of document.querySelectorAll('button,[role=button]')) {
        if (e.closest('footer')) continue;
        const label = ((e.innerText || '').trim() || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
        if (!label || label.length > 30 || NEV.test(label) || !SAFE.test(label) || !vis(e)) continue;
        e.click(); return label;
      }
      return null;
    }, { safe: SAFE_CLOSE.source, never: NEVER.source }).catch(() => null);
    if (!hit) { await page.keyboard.press('Escape').catch(() => {}); return; }
    note('closed popup:', JSON.stringify(hit));
    await page.waitForTimeout(1000);
  }
}

async function dump(page, label) {
  const info = await page.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = s => (s || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const btns = [...document.querySelectorAll('button,[role=button],[role=switch],[role=tab]')].filter(vis)
      .map(e => clean(e.innerText || e.getAttribute('aria-label'))).filter(Boolean);
    const inputs = [...document.querySelectorAll('input,select,textarea')].filter(vis)
      .map(e => `${e.tagName.toLowerCase()}[type=${e.type} name=${e.name} placeholder=${e.placeholder}]`);
    const links = [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.includes('housebets'));
    return { url: location.href, title: document.title, btns: [...new Set(btns)], inputs, links: [...new Set(links)] };
  }).catch(e => ({ url: page.url(), title: '?', btns: [], inputs: [], links: [], err: e.message }));
  info.frames = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
  fs.writeFileSync(path.join(OUT, `${num()}-${label}.json`), JSON.stringify(info, null, 1));
  note(`[${label}] ${info.url}`);
  note(`  buttons: ${info.btns.slice(0, 45).join(' | ')}`);
  if (info.inputs.length) note(`  inputs: ${info.inputs.join(' ; ')}`);
  if (info.frames.length > 1) note(`  frames: ${info.frames.slice(1, 6).join(' , ')}`);
  return info;
}

const loginButton = page => page.getByRole('button', { name: /^(log ?in|sign ?in)$/i })
  .or(page.getByRole('link', { name: /^(log ?in|sign ?in)$/i })).first();

// The header "Log In" button: matched by its visible text, first one that is actually on screen.
async function findLogin(page) {
  const all = page.locator('button, a, [role=button]').filter({ hasText: /^\s*(log ?in|sign ?in)\s*$/i });
  const c = await all.count().catch(() => 0);
  for (let i = 0; i < c; i++) if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
  return null;
}

async function login(page) {
  let btn = await findLogin(page);
  if (!btn) { note('LOGIN: no Log In button visible, so treating as already logged in (saved session)'); return true; }
  note('LOGIN: logged out, Log In button found');
  if (!process.env.HB_EMAIL || !process.env.HB_PASSWORD) { note('LOGIN: skipped, no email/password saved (run: hubie secrets)'); return false; }
  await btn.click().catch(e => note('login click failed', e.message));
  await page.waitForTimeout(2500);
  await shot(page, 'login-form'); await dump(page, 'login-form');
  const email = page.locator('input[type=email], input[name*=email i], input[name*=user i], input[autocomplete=username], input[placeholder*=mail i], input[placeholder*=user i]').first();
  const pass = page.locator('input[type=password]').first();
  if (!(await email.isVisible().catch(() => false))) { note('LOGIN: no email box found (see login-form screenshot)'); return false; }
  await email.fill(process.env.HB_EMAIL);
  await pass.fill(process.env.HB_PASSWORD).catch(() => note('LOGIN: no password box'));
  const submit = page.locator('form button[type=submit]').first();
  if (await submit.isVisible().catch(() => false)) await submit.click(); else await pass.press('Enter');
  await page.waitForTimeout(8000);
  await shot(page, 'after-login');
  const caps = page.frames().map(f => f.url()).filter(u => /captcha|turnstile|challenges\.cloudflare/i.test(u));
  if (caps.length) note('LOGIN: ⚠️ captcha on page:', caps.join(' , '));
  const body = await page.locator('body').innerText().catch(() => '');
  if (/verification code|check your (e-?mail|inbox)|two.?factor|2fa|authenticator|one.?time/i.test(body)) note('LOGIN: ⚠️ asks for a code (email/2FA)');
  const ok = !(await findLogin(page));
  note(ok ? 'LOGIN: ✅ logged in' : 'LOGIN: ❌ still logged out');
  return ok;
}

async function tryDemo(page, label) {
  const demo = page.getByText(/^(demo|demo mode|demo play|play demo|fun|fun mode|fun play|play for fun|free play|practice)$/i).first();
  if (await demo.isVisible().catch(() => false)) {
    note(`DEMO [${label}]: found "${(await demo.innerText().catch(() => '?')).trim()}", clicking`);
    await demo.click().catch(e => note('demo click failed', e.message));
    await page.waitForTimeout(6000);
    await shot(page, `${label}-after-demo`);
    return true;
  }
  const sw = page.getByRole('switch', { name: /demo|fun|practice/i }).first();
  if (await sw.isVisible().catch(() => false)) { note(`DEMO [${label}]: found a demo switch`); return true; }
  note(`DEMO [${label}]: no demo/fun button found (see screenshot)`);
  return false;
}

async function openGame(page, url, label) {
  note(`OPEN ${label}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => note('goto failed', e.message));
  await page.waitForTimeout(10000);
  await closePopups(page);
  await shot(page, label);
  await dump(page, label);
  await tryDemo(page, label);
}

(async () => {
  note('Hubie login/demo test', new Date().toISOString());
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: '/usr/bin/google-chrome',
    headless: false,
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--test-type', '--disable-blink-features=AutomationControlled', '--window-size=1280,720'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    note('title:', await page.title());
    await shot(page, 'home');
    await closePopups(page);
    await shot(page, 'home-clean');
    await dump(page, 'home');

    await login(page);
    await closePopups(page);

    let links = [];
    for (const p of ['/games', '/casino']) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(6000);
      await closePopups(page);
      await shot(page, 'list' + p.replace('/', '-'));
      links.push(...(await dump(page, 'list' + p.replace('/', '-'))).links);
    }
    links = [...new Set(links)];
    fs.writeFileSync(path.join(OUT, 'all-links.txt'), links.join('\n'));
    note(`found ${links.length} links (all-links.txt)`);

    const dice = process.env.DICE_URL || links.find(h => /dice/i.test(h));
    if (dice) await openGame(page, dice, 'dice'); else note('DICE: no dice link found');

    const isCategory = h => /\/(games|casino|slots?)\/?$|category|provider|search|promotions|vip|sports/i.test(h);
    const slot = process.env.SLOT_URL || links.find(h => /slot/i.test(h) && !isCategory(h))
      || links.find(h => /\/(casino|games)\/[^/?#]+\/[^/?#]+/.test(h) && !/dice|plinko|mines|crash|limbo|keno|blackjack|roulette/i.test(h) && !isCategory(h));
    if (slot) await openGame(page, slot, 'slot'); else note('SLOT: no slot link found');
  } catch (e) {
    note('ERROR:', e.message);
    await shot(page, 'error');
  }
  await ctx.close();

  fs.writeFileSync(path.join(OUT, 'report.txt'), notes.join('\n'));
  const imgs = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Hubie test</title><body style="background:#0b1418;color:#e6f4f5;font:14px system-ui;margin:12px">
<h2>Hubie login/demo test</h2>${imgs.map(f => `<p>${f}</p><img src="${f}" style="width:100%;border:1px solid #234">`).join('')}
<h3>Report</h3><pre style="white-space:pre-wrap">${esc(notes.join('\n'))}</pre></body>`);
  note('done:', OUT);
})();
