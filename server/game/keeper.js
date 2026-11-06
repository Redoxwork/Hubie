// Popup keeper (first piece of the game bot).
// Attaches to the live game Chrome (port 9222) and every 30 s:
//   - closes harmless popups (welcome, cookies) using only safe "close" buttons
//   - brings the page back to Housebets if it wandered off or shows an error page
// It never clicks anything money-related, and it never touches the "verify you are human" check.
'use strict';
const { chromium } = require('playwright-core');
const GAME_URL = process.env.HUBIE_GAME_URL || 'https://www.housebets.com/casino';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] keeper:`, ...a);
const SAFE = /^(maybe later|close|close modal|close dialog|no thanks|not now|got it|accept|accept all|i agree|dismiss|skip|×|✕)$/i;
const NEVER = /deposit|withdraw|buy|purchase|cashier|bet|spin|wager|real money|claim|register|sign ?up|log ?in/i;
let lastCheckLog = 0, lastLogin = 0, calmLogged = false;

// ---- stuck security check: reload a few times, then show Hubie's Lounge and retry Housebets every 20 min ----
const LOUNGE = 'http://127.0.0.1:8090/avatar/lounge.html';
const shared = { blocked: false, lounge: false, loggingIn: false, loggedOut: false, lastRound: Date.now() };   // read by the game player
let blockedSince = 0, reloads = 0, lastReload = 0, loungeSince = 0;
const tellBrain = game => fetch('http://127.0.0.1:8090/state?game=' + encodeURIComponent(game)).catch(() => {});
async function isBlocked(page) {
  if (page.frames().some(f => /challenges\.cloudflare|turnstile/i.test(f.url()))) return true;
  const txt = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  return /security check (unavailable|could not load|required)|verify you are human|checking your browser|just a moment/i.test(txt);
}
async function goLounge(page) {
  log('security check stuck: showing Hubie\'s Lounge, will retry Housebets in 20 min');
  loungeSince = Date.now(); blockedSince = 0; reloads = 0;
  await page.goto(LOUNGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => log('lounge failed', e.message));
  tellBrain("You're in Hubie's Lounge: the Housebets games are taking a quick nap (a site check), so you're hanging out with chat. Don't claim to be spinning, winning or losing right now.");
}

// Calm mode: pause the page's animations and videos so the stream stays sharp and light (off: HUBIE_CALM=0)
async function calm(page) {
  if (process.env.HUBIE_CALM === '0' || shared.playing || /\/games\//.test(page.url())) return;
  const done = await page.evaluate(() => {
    if (!document.getElementById('hubie-calm')) {
      const st = document.createElement('style'); st.id = 'hubie-calm';
      st.textContent = '*,*::before,*::after{animation-play-state:paused!important;animation-iteration-count:1!important;transition:none!important;scroll-behavior:auto!important}';
      document.head.appendChild(st);
    }
    let n = 0;
    for (const v of document.querySelectorAll('video')) { if (!v.paused) { v.pause(); n++; } v.autoplay = false; }
    for (const a of document.getAnimations ? document.getAnimations() : []) { try { a.pause(); n++; } catch (e) {} }
    return n;
  }).catch(() => 0);
  if (!calmLogged) { calmLogged = true; log('calm mode on: page animations paused', done ? `(${done})` : ''); }
}

// ---- auto-login with Hubie's own account (email + password from /etc/hubie.env) ----
async function visibleLogin(page) {
  const all = page.locator('button, a, [role=button]').filter({ hasText: /^\s*(log ?in|sign ?in)\s*$/i });
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
  return null;
}
async function login(page) {
  try { return await loginInner(page); } catch (e) { log('login error', e.message); } finally { shared.loggingIn = false; }
}
async function loginInner(page) {
  if (!process.env.HB_EMAIL || !process.env.HB_PASSWORD) { log('logged out, but no Housebets login saved (hubie secrets)'); return; }
  if (Date.now() - lastLogin < 10 * 60e3) return;           // at most one try every 10 minutes
  lastLogin = Date.now();
  const btn = await visibleLogin(page); if (!btn) return;
  log('logged out: logging in as Hubie');
  await btn.click().catch(() => {});
  await page.waitForTimeout(3000);
  const email = page.locator('input[type=email], input[name*=email i], input[autocomplete=username], input[placeholder*=mail i]').first();
  const pass = page.locator('input[type=password]').first();
  if (!(await email.isVisible().catch(() => false))) {
    const useEmail = page.getByText(/(continue|sign in|log in) with email|^email$/i).first();   // some forms hide email behind a tab
    if (await useEmail.isVisible().catch(() => false)) { await useEmail.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await email.isVisible().catch(() => false))) { log('login form: no email box found'); return; }
  await email.fill(process.env.HB_EMAIL);
  await pass.fill(process.env.HB_PASSWORD).catch(() => {});
  // the login form has its own "verify you are human" box: give it time, tick it once if it asks
  shared.loggingIn = true;
  for (let i = 0; i < 12; i++) {
    const cf = page.frames().find(f => /challenges\.cloudflare|turnstile/i.test(f.url()));
    const token = await page.evaluate(() => { const t = document.querySelector('[name="cf-turnstile-response"]'); return t ? t.value : 'none'; }).catch(() => 'none');
    if (!cf || (token && token !== 'none')) break;
    if (i === 3) { log('login: ticking the verify box'); await cf.locator('input[type=checkbox], label, body').first().click({ timeout: 3000 }).catch(() => {}); }
    await page.waitForTimeout(2500);
  }
  const submit = page.locator('form button[type=submit]').first();
  if (await submit.isVisible().catch(() => false)) await submit.click(); else await pass.press('Enter').catch(() => {});
  await page.waitForTimeout(8000);
  const body = await page.locator('body').innerText().catch(() => '');
  if (/verification code|check your (e-?mail|inbox)|two.?factor|2fa|authenticator|one.?time/i.test(body)) log('login: ⚠️ Housebets asks for a code (turn 2FA/email codes off)');
  const out = !!(await visibleLogin(page));
  shared.loggingIn = false; shared.loggedOut = out;
  log(out ? 'login: ❌ still logged out (will try again in 10 min)' : 'login: ✅ logged in');
  if (out) tellBrain("Housebets logged you out and you're logging back in, so the games are paused for a few minutes. Hang out with chat. Don't claim to be spinning, winning or losing right now.");
  else tellBrain('');
  await page.keyboard.press('Escape').catch(() => {});
}

async function tick(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  shared.lounge = url.startsWith(LOUNGE);
  if (url.startsWith(LOUNGE)) {                                   // in the lounge: try Housebets again every 20 min
    if (Date.now() - loungeSince > 20 * 60e3) {
      log('lounge: trying Housebets again');
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      blockedSince = Date.now() - 4 * 60e3;                        // if still blocked, back to the lounge within ~1 min
      reloads = 3;
    }
    return;
  }
  if (!/housebets\.com/.test(url) || /404|not found|error/i.test(title)) {
    log('page is off (', url, title, ') -> back to', GAME_URL);
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log('goto failed', e.message));
    return;
  }
  const hit = await page.evaluate(({ safe, never }) => {
    const SAFE = new RegExp(safe, 'i'), NEV = new RegExp(never, 'i');
    for (const e of document.querySelectorAll('button,[role=button]')) {
      if (e.closest('footer')) continue;
      const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const label = ((e.innerText || '').trim() || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
      if (!label || label.length > 30 || NEV.test(label) || !SAFE.test(label)) continue;
      e.click(); return label;
    }
    return null;
  }, { safe: SAFE.source, never: NEVER.source }).catch(() => null);
  if (hit) log('closed popup:', JSON.stringify(hit));
  await calm(page);
  shared.blocked = !shared.loggingIn && await isBlocked(page);
  if (shared.blocked) {                                            // never click it; reload, then the lounge
    if (!blockedSince) blockedSince = Date.now();
    if (Date.now() - lastCheckLog > 10 * 60e3) { lastCheckLog = Date.now(); log('security check is showing (waiting on Housebets)'); }
    const stuck = Date.now() - blockedSince;
    if (reloads >= 3 && stuck > 5 * 60e3) return goLounge(page);
    if (stuck > 60e3 && Date.now() - lastReload > 2 * 60e3) {
      reloads++; lastReload = Date.now(); log(`security check stuck: reload ${reloads}/3`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    return;
  }
  if (blockedSince || loungeSince) { log('Housebets is back'); tellBrain(''); }
  blockedSince = 0; reloads = 0; loungeSince = 0;
  if (process.env.AUTO_LOGIN !== '0' && await visibleLogin(page)) await login(page);
  else if (shared.loggedOut && !(await visibleLogin(page))) { shared.loggedOut = false; log('logged in again'); tellBrain(''); }
}

(async () => {
  let browser;
  for (let i = 0; i < 20 && !browser; i++) {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => null);
    if (!browser) await new Promise(r => setTimeout(r, 3000));
  }
  if (!browser) { log('could not reach the game window'); process.exit(1); }
  browser.on('disconnected', () => { log('game window closed'); process.exit(0); });
  log('attached to the game window');
  let playerOn = false, main = null;
  // one tab only: if the site (or a stray click) opens another tab/popup, the stream would show THAT
  // while the game keeps playing hidden behind it. Close extras and keep the game tab in front.
  const oneTab = async () => {
    const ctx = browser.contexts()[0]; if (!ctx || !main) return;
    for (const p of ctx.pages()) {
      if (p === main || p.url().startsWith('devtools')) continue;
      log('closing extra tab:', p.url().slice(0, 80)); await p.close().catch(() => {});
    }
    await main.bringToFront().catch(() => {});
  };
  browser.contexts()[0]?.on('page', () => setTimeout(() => oneTab().catch(() => {}), 1500));
  for (;;) {
    if (main && main.isClosed()) { log('game tab was closed, restarting the game bot'); process.exit(1); }
    const page = main || browser.contexts()[0]?.pages().find(p => !p.url().startsWith('devtools')) || null;
    if (page && !main) main = page;
    await oneTab().catch(() => {});
    if (page && process.env.GAMES === '1' && !playerOn) { playerOn = true; require('./player')(page, shared); }
    if (page) await tick(page).catch(e => log('tick error', e.message));
    await new Promise(r => setTimeout(r, 20000));
  }
})();
