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
let lastCheckLog = 0;

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
  if (check && Date.now() - lastCheckLog > 10 * 60e3) { lastCheckLog = Date.now(); log('security check is showing (waiting on Housebets)'); }
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
