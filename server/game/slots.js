// Slot driver (first draft): provider slots in FUN mode only.
// Opens a slot by search, switches the game settings to "Fun" and confirms it, spins with the SPACE key only
// (never clicks inside the slot picture, where buy-bonus buttons live), in batches of 10 or 25 spins.
// Leaves after ~10 min or if the CPU gets too busy. Off unless SLOTS=1.
'use strict';
const os = require('os');
const { detect } = require('./providers');
const BRAIN = 'http://127.0.0.1:8090';
const ask = p => fetch(BRAIN + p, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => ({}));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] slots:`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const NEVER = /deposit|withdraw|cashier|wallet|buy|purchase|real money|^real$/i;
const FAVOURITES = (process.env.SLOT_LIST || 'Sweet Bonanza|Gates of Olympus|Sugar Rush|Big Bass Bonanza|Le Cowboy').split('|');

// ---- open a slot by name through the site search ----
async function openSlot(page, base, name) {
  await page.goto(`${base}/casino`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(3000);
  let box = page.locator('input[type=search], input[placeholder*="earch" i]').first();
  if (!(await box.isVisible().catch(() => false))) {
    const btn = page.locator('button, a, [role=button]').filter({ hasText: /^\s*search\s*$/i }).first();
    await btn.click({ timeout: 3000 }).catch(() => {}); await sleep(1500);
    box = page.locator('input[type=search], input[placeholder*="earch" i]').first();
  }
  if (!(await box.isVisible().catch(() => false))) { log('no search box found'); return null; }
  await box.fill(name, { timeout: 5000 }).catch(() => {}); await sleep(2500);
  // best match: a game link whose text contains the first word of the name
  const word = name.split(/\s+/)[0].toLowerCase();
  const href = await page.evaluate(w => {
    const links = [...document.querySelectorAll('a[href]')].filter(a => a.offsetParent && /\/(casino|games?)\/[^/]+\/?[^/]*/.test(a.getAttribute('href') || ''));
    const hit = links.find(a => (a.innerText + ' ' + (a.getAttribute('aria-label') || '') + ' ' + a.href).toLowerCase().includes(w)) || null;
    return hit ? hit.href : null;
  }, word).catch(() => null);
  if (!href || /housegames-/.test(href)) { log('no result for', name); return null; }
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  return href;
}

// ---- Fun mode: click it, then confirm it's the selected one ----
async function ensureFun(page) {
  const funSelected = () => page.evaluate(() => {
    const vis = e => e.offsetParent && e.getBoundingClientRect().width > 0;
    const find = re => [...document.querySelectorAll('button,[role=tab],[role=radio],[role=switch],label,div,span')].filter(e => vis(e) && re.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 8);
    const fun = find(/^fun$/i)[0], real = find(/^real$/i)[0];
    if (!fun) return null;
    const on = e => e && (['true', 'on', 'active', 'checked'].includes(String(e.getAttribute('aria-selected') || e.getAttribute('aria-checked') || e.getAttribute('aria-pressed') || e.getAttribute('data-state') || '').toLowerCase())
      || /(^|\s|-)(active|selected|checked|on)(\s|$|-)/i.test(e.className || ''));
    if (on(fun) && !on(real)) return true;
    if (on(real)) return false;
    // no state attributes: the highlighted one has a different, non-transparent background
    const bg = e => getComputedStyle(e).backgroundColor;
    if (real && bg(fun) !== bg(real) && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg(fun))) return true;
    return null;
  }).catch(() => null);
  let s = await funSelected();
  if (s === true) return true;
  // open the game settings (gear) if the switch isn't visible, then click "Fun"
  if (s === null) {
    const gear = page.locator('button[aria-label*="setting" i], [role=button][aria-label*="setting" i], button[title*="setting" i]').first();
    if (await gear.isVisible().catch(() => false)) { await gear.click({ timeout: 3000 }).catch(() => {}); await sleep(1000); }
  }
  const fun = page.locator('button, [role=tab], [role=radio], label').filter({ hasText: /^\s*fun\s*$/i }).first();
  if (await fun.isVisible().catch(() => false)) { await fun.click({ timeout: 3000 }).catch(() => {}); await sleep(4000); }
  s = await funSelected();
  return s === true;
}

// ---- spin with the space bar inside the slot frame; confirm the slot reacted (network) ----
function slotFrame(page) {
  const frames = page.frames().filter(f => f !== page.mainFrame() && f.url() && !/about:blank|challenges\.cloudflare|turnstile/.test(f.url()));
  return frames.sort((a, b) => b.url().length - a.url().length)[0] || null;
}
function readWin(text) {
  try {
    const j = JSON.parse(text); let win = null;
    (function walk(x, d) { if (!x || typeof x !== 'object' || d > 6) return;
      for (const [k, v] of Object.entries(x)) { if (win === null && typeof v === 'number' && /^(total_?win|totalwin|win|tw|win_?amount|payout)$/i.test(k)) win = v; if (v && typeof v === 'object') walk(v, d + 1); } })(j, 0);
    return win;
  } catch {}
  const m = /(?:^|&)tw=([\d.]+)/.exec(text) || /(?:^|&)w=([\d.]+)/.exec(text);
  return m ? Number(m[1]) : null;
}

module.exports = function slots({ page, shared, base, tell }) {
  const deadline = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);   // nothing waits forever
  let lastNet = 0, lastWin = null, keysLogged = 0;
  page.on('response', async r => {
    try {
      const f = r.frame && r.frame(); if (!f || f === page.mainFrame()) return;
      if (/\.(png|jpe?g|webp|gif|svg|mp3|ogg|m4a|woff2?|json\.gz|js|css|atlas)(\?|$)/i.test(r.url())) return;
      lastNet = Date.now();
      const t = await r.text().catch(() => ''); const w = readWin(t);
      if (w !== null) { lastWin = { at: Date.now(), win: w }; if (keysLogged++ < 3) log('win value seen in', r.url().split('?')[0].slice(-40)); }
    } catch {}
  });
  const busyCpu = () => os.loadavg()[0] > os.cpus().length * 0.85;

  async function play(name, by) {
    if (process.env.SLOTS !== '1') return false;
    log('opening slot', name, by ? `for ${by}` : '');
    const href = await deadline(openSlot(page, base, name), 90e3);
    if (!href) { tell('unknown', { game: name, by: by || '' }); return false; }
    if (!(await deadline(ensureFun(page), 30e3))) { log('could not confirm FUN mode: leaving'); tell('slotfail', { game: name }); return false; }
    const prov = detect(slotFrame(page)?.url());
    log('provider:', prov.name, prov.bonus ? '(bonus mapped)' : '(no bonus map)');
    tell('game', { game: name, by: by || '', slot: 1, provider: prov.name });
    const mins = Number(process.env.SLOT_MINUTES) || 8;     // a slot session: 8 min by default
    const end = Date.now() + mins * 60e3; let quiet = 0, spins = 0, bonusUntil = 0;
    while (Date.now() < end && !shared.blocked) {
      const batch = Math.random() < 0.5 ? 10 : 25;
      tell('auto', { game: name, n: batch });
      for (let i = 0; i < batch && Date.now() < end; i++) {
        if (busyCpu()) { log('CPU busy: leaving the slot'); tell('slotheavy', { game: name }); return true; }
        const fr = slotFrame(page); if (!fr) { log('slot frame gone'); return true; }
        if (Date.now() < bonusUntil) { await sleep(3000); continue; }   // bonus round plays by itself: don't press, don't count as quiet
        const t0 = Date.now();
        const el = await fr.frameElement().catch(() => null);            // focus the slot frame, then SPACE (no clicks on the picture)
        if (el) await el.focus().catch(() => {});
        await fr.evaluate(() => { if (!document.body.hasAttribute('tabindex')) document.body.tabIndex = -1; document.body.focus(); }).catch(() => {});
        await page.keyboard.press('Space').catch(() => {});
        await sleep(rand(3500, 5500));
        if (lastNet < t0) { if (++quiet >= 3) { log('slot not reacting to space: leaving'); tell('slotfail', { game: name }); return true; } continue; }
        quiet = 0; spins++;
        const w = lastWin && lastWin.at >= t0 ? lastWin.win : null;
        tell('round', { game: name, win: w === null ? '' : (w > 0 ? 1 : 0), mult: '', slot: 1 });
        if (!(await ensureFun(page))) { log('FUN mode lost: leaving now'); return true; }   // re-check every spin
        if ((await ask('/bonus/take')).go && await buyBonus(prov, name)) { bonusUntil = Date.now() + 60e3; quiet = 0; }   // chat voted for a bonus buy
      }
      if ((await ask('/queue/size')).n > 0) { log('queue waiting: wrapping up', name); break; }   // finish this batch, then the queue
      await sleep(rand(2000, 4000));
    }
    log(`done with ${name} (${spins} spins)`);
    return true;
  }
  // bonus buy: FUN mode confirmed before and after, only on providers with a mapped button
  async function buyBonus(prov, name) {
    if (!prov.bonus) { tell('bonusnomap', { game: name, provider: prov.name }); return false; }
    if (!(await ensureFun(page))) { tell('bonusfail', { game: name }); return false; }
    const fr = slotFrame(page); const el = fr && await fr.frameElement().catch(() => null);
    const box = el && await el.boundingBox().catch(() => null);
    if (!box) { tell('bonusfail', { game: name }); return false; }
    const at = p => page.mouse.click(box.x + box.width * p.x, box.y + box.height * p.y);
    log('bonus buy on', name, '(FUN mode)');
    await at(prov.bonus.open); await sleep(1500);
    if (!(await ensureFun(page))) { log('FUN mode lost during bonus: leaving'); await page.keyboard.press('Escape').catch(() => {}); return false; }
    await at(prov.bonus.confirm); await sleep(2000);
    tell('bonus', { game: name });
    return true;
  }
  return { play, favourite: () => pick(FAVOURITES) };
};
