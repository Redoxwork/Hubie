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
let lastCheckLog = 0, lastLogin = 0;

// ---- auto-login with Hubie's own account (email + password from /etc/hubie.env) ----
async function visibleLogin(page) {
  const all = page.locator('button, a, [role=button]').filter({ hasText: /^\s*(log ?in|sign ?in)\s*$/i });
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
  return null;
}
async function login(page) {
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
  const submit = page.locator('form button[type=submit]').first();
  if (await submit.isVisible().catch(() => false)) await submit.click(); else await pass.press('Enter').catch(() => {});
  await page.waitForTimeout(8000);
  const body = await page.locator('body').innerText().catch(() => '');
  if (/verification code|check your (e-?mail|inbox)|two.?factor|2fa|authenticator|one.?time/i.test(body)) log('login: ⚠️ Housebets asks for a code (turn 2FA/email codes off)');
  log(await visibleLogin(page) ? 'login: ❌ still logged out' : 'login: ✅ logged in');
}

async function tick(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
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
  const check = page.frames().some(f => /challenges\.cloudflare|turnstile/i.test(f.url()));
  if (check) {
    if (Date.now() - lastCheckLog > 10 * 60e3) { lastCheckLog = Date.now(); log('security check is showing (waiting on Housebets)'); }
    return;                                                    // never touch it, and don't try to log in behind it
  }
  if (await visibleLogin(page)) await login(page);
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
  for (;;) {
    const page = browser.contexts()[0]?.pages().find(p => !p.url().startsWith('devtools')) || null;
    if (page) await tick(page).catch(e => log('tick error', e.message));
    await new Promise(r => setTimeout(r, 30000));
  }
})();
