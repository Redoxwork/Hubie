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

// ---- "!play pragmatic": pick a random slot from that provider with the casino filter ----
const PROV_NAMES = /^(pragmatic( play)?|hacksaw( gaming)?|nolimit( city)?|relax( gaming)?|push( gaming)?|play'?n ?go|netent|big time gaming|btg|evolution|red tiger|backseat|avatarux|elk)$/i;
async function openByProvider(page, base, prov) {
  await page.goto(`${base}/casino`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(3000);
  await page.locator('button, [role=button], [role=tab], a').filter({ hasText: /^\s*(slots|providers?)\s*$/i }).first().click({ timeout: 3000 }).catch(() => {});
  await sleep(1500);
  const word = prov.split(/\s+/)[0];
  const f = page.locator('button, [role=button], [role=option], label, a').filter({ hasText: new RegExp('^\\s*' + word, 'i') }).first();
  if (!(await f.isVisible().catch(() => false))) { log('no provider filter for', prov); return null; }
  await f.click({ timeout: 3000 }).catch(() => {}); await sleep(3000);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter(a => a.offsetParent && /\/(casino|games?)\/[^/]+\/?[^/]*/.test(a.getAttribute('href') || '') && !/housegames-|provider|category/.test(a.href)).map(a => a.href)).catch(() => []);
  if (!hrefs.length) { log('provider filter showed no games for', prov); return null; }
  const href = pick(hrefs.slice(0, 30));
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  return href;
}

// ---- open a slot by name through the site search ----
async function openSlot(page, base, name) {
  if (PROV_NAMES.test(name.trim())) return openByProvider(page, base, name.trim());
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

// ---- the settings gear (icon only, no text): try the toolbar's icon buttons, never the last one (fullscreen) ----
const funVisible = page => page.locator('button, [role=tab], [role=radio], label').filter({ hasText: /^\s*fun\s*$/i }).first().isVisible().catch(() => false);
async function openGear(page) {
  const named = page.locator('button[aria-label*="setting" i], button[title*="setting" i]').first();
  if (await named.isVisible().catch(() => false)) { await named.click({ timeout: 3000 }).catch(() => {}); await sleep(1000); if (await funVisible(page)) return true; }
  const n = await page.evaluate(() => {
    document.querySelectorAll('[data-hubie-tool]').forEach(e => e.removeAttribute('data-hubie-tool'));
    const blocks = [...document.querySelectorAll('div,section,header,nav')].filter(d => d.offsetParent && /housebets/i.test(d.innerText || '') && (d.innerText || '').length < 60);
    blocks.sort((a, b) => a.innerText.length - b.innerText.length);
    for (const b of blocks) {
      const icons = [...b.querySelectorAll('button,[role=button]')].filter(x => x.offsetParent && !(x.innerText || '').trim() && x.querySelector('svg,img'));
      if (icons.length >= 2) { icons.slice(0, -1).forEach((x, i) => x.setAttribute('data-hubie-tool', String(i))); return icons.length - 1; }
    }
    return 0;
  }).catch(() => 0);
  for (let i = 0; i < n && i < 4; i++) {
    await page.locator(`[data-hubie-tool="${i}"]`).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(900);
    if (await funVisible(page)) return true;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
  log('settings gear not found');
  return false;
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
  const fr = slotFrame(page);
  const inner = fr ? await fr.evaluate(() => (document.body && document.body.innerText || '').slice(0, 3000)).catch(() => '') : '';
  if (/demo balance|demo bet|fun mode|play for fun/i.test(inner) && s !== false) return true;
  // open the game settings: the gear is an icon-only button in the toolbar under the slot (📊 ⚙️ ☆ Housebets ⛶)
  if (s === null && !(await funVisible(page))) await openGear(page);
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
  let bonus = null;                                        // { cost, start, vals: [], hit: Set, lastAt }
  page.on('response', async r => {
    try {
      const f = r.frame && r.frame(); if (!f || f === page.mainFrame()) return;
      if (/\.(png|jpe?g|webp|gif|svg|mp3|ogg|m4a|woff2?|json\.gz|js|css|atlas)(\?|$)/i.test(r.url())) return;
      lastNet = Date.now();
      const t = await r.text().catch(() => ''); const w = readWin(t);
      if (w !== null) { lastWin = { at: Date.now(), win: w }; if (bonus) onBonusValue(w); if (keysLogged++ < 3) log('win value seen in', r.url().split('?')[0].slice(-40)); }
    } catch {}
  });
  const busyCpu = () => os.loadavg()[0] > os.cpus().length * 0.85;
  // running bonus total: values that only go up are a running total, otherwise they're per-spin wins to add up
  const bonusTotal = () => { const v = bonus.vals; if (!v.length) return 0; const up = v.every((x, i) => i === 0 || x >= v[i - 1]); return up ? v[v.length - 1] : v.reduce((a, b) => a + b, 0); };
  function onBonusValue(w) {
    if (w <= 0) return;
    bonus.vals.push(w); bonus.lastAt = Date.now();
    const total = bonusTotal(), x = bonus.cost ? total / bonus.cost : 0;
    tell('bonushit', { total: total.toFixed(2), x: x.toFixed(2) });
    for (const t of [1, 2, 5, 10, 20, 50, 100]) if (x >= t && !bonus.hit.has(t)) { bonus.hit.add(t); tell('bonusmilestone', { x: t, total: total.toFixed(2) }); }
  }
  const demoBet = async () => {
    const fr = slotFrame(page); if (!fr) return 0;
    const t = await fr.evaluate(() => (document.body && document.body.innerText || '').slice(0, 3000)).catch(() => '');
    const m = /demo bet[^\d]{0,8}([\d.,]+)/i.exec(t); return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  };

  async function play(name, by) {
    if (process.env.SLOTS !== '1') return false;
    log('opening slot', name, by ? `for ${by}` : '');
    const href = await deadline(openSlot(page, base, name), 90e3);
    if (!href) { tell('unknown', { game: name, by: by || '' }); return false; }
    if (!(await deadline(ensureFun(page), 30e3))) { log('could not confirm FUN mode: leaving'); tell('slotfail', { game: name }); return false; }
    const cardText = await page.evaluate(() => (document.body.innerText || '').slice(0, 6000)).catch(() => '');
    let prov = detect(slotFrame(page)?.url());
    if (prov.id === 'unknown') { const { PROVIDERS } = require('./providers'); prov = PROVIDERS.find(p => p.match.test(cardText)) || prov; }
    log('provider:', prov.name, prov.bonus ? '(bonus mapped)' : '(no bonus map)');
    tell('game', { game: name, by: by || '', slot: 1, provider: prov.name });
    const mins = Number(process.env.SLOT_MINUTES) || 35;    // a slot session: 35 min of autoplay by default
    const end = Date.now() + mins * 60e3; let quiet = 0, spins = 0, bonusUntil = 0, wins = 0, best = 0;
    const SIZES = String(process.env.SLOT_SPINS || '200,300,300,500').split(',').map(Number).filter(x => x > 0);
    while (Date.now() < end && !shared.blocked) {
      const batch = pick(SIZES);
      tell('auto', { game: name, n: batch });
      log(`autoplay: ${batch} spins on ${name} (fun mode)`);
      for (let i = 0; i < batch && Date.now() < end; i++) {
        if (busyCpu()) { log('CPU busy: leaving the slot'); tell('slotheavy', { game: name }); return true; }
        const fr = slotFrame(page); if (!fr) { log('slot frame gone'); return true; }
        if (bonus && (Date.now() - bonus.start > 150e3 || (Date.now() - bonus.start > 20e3 && Date.now() - bonus.lastAt > 15e3))) {
          const total = bonusTotal(); tell('bonusend', { game: name, total: total.toFixed(2), cost: bonus.cost, x: bonus.cost ? (total / bonus.cost).toFixed(2) : '' });
          log(`bonus done: ${total.toFixed(2)} on a ${bonus.cost} buy`); bonus = null; bonusUntil = 0;
        }
        if (Date.now() < bonusUntil) {                                   // bonus plays by itself: SPACE only to get past 'click to continue'
          await sleep(6000); const f2 = slotFrame(page); const e2 = f2 && await f2.frameElement().catch(() => null);
          if (e2) await e2.focus().catch(() => {}); await page.keyboard.press('Space').catch(() => {}); quiet = 0; continue;
        }
        const t0 = Date.now();
        const el = await fr.frameElement().catch(() => null);            // focus the slot frame, then SPACE (no clicks on the picture)
        if (el) await el.focus().catch(() => {});
        await fr.evaluate(() => { if (!document.body.hasAttribute('tabindex')) document.body.tabIndex = -1; document.body.focus(); }).catch(() => {});
        await page.keyboard.press('Space').catch(() => {});
        await sleep(rand(3500, 5500));
        if (lastNet < t0) { if (++quiet >= 3) { log('slot not reacting to space: leaving'); tell('slotfail', { game: name }); return true; } continue; }
        quiet = 0; spins++;
        const w = lastWin && lastWin.at >= t0 ? lastWin.win : null;
        const bet = await demoBet();
        const mult = w && bet ? w / bet : 0; if (w > 0) wins++; if (mult > best) best = mult;
        tell('round', { game: name, win: w === null ? '' : (w > 0 ? 1 : 0), mult: mult ? mult.toFixed(2) : '', slot: 1, auto: 1 });
        if (!(await ensureFun(page))) { log('FUN mode lost: leaving now'); return true; }   // re-check every spin
        if ((await ask('/bonus/take')).go && await buyBonus(prov, name)) { bonusUntil = Date.now() + 160e3; quiet = 0; }   // chat voted for a bonus buy
      }
      if ((await ask('/queue/size')).n > 0) { log('queue waiting: wrapping up', name); break; }   // finish this batch, then the queue
      await sleep(rand(2000, 4000));
    }
    log(`done with ${name} (${spins} spins, ${wins} wins, best ${best.toFixed(1)}x)`);
    if (spins) tell('autoend', { game: name, n: spins, wins, best: Math.round(best * 100) / 100, why: shared.blocked ? 'blocked' : 'done' });
    return true;
  }
  // bonus buy by the words on the buttons (works in any layout): BUY BONUS -> cheapest BUY -> OK
  async function buyByText(fr) {
    const opener = fr.getByText(/^\s*(buy bonus|bonus buy|buy feature|feature buy|buy free spins)\s*$/i).first();
    if (!(await opener.isVisible().catch(() => false))) return false;
    await opener.click({ timeout: 3000 }).catch(() => {}); await sleep(1800);
    const n = await fr.evaluate(() => {                                   // the BUY with the lowest price next to it
      document.querySelectorAll('[data-hubie-buy]').forEach(e => e.removeAttribute('data-hubie-buy'));
      const buys = [...document.querySelectorAll('button,div,span,a')].filter(e => e.offsetParent && /^\s*buy\s*$/i.test(e.textContent || '') && ![...e.children].some(c => /^\s*buy\s*$/i.test(c.textContent || '')));
      let best = null, bestPrice = Infinity;
      for (const b of buys) {
        let p = b, price = Infinity;
        for (let i = 0; i < 5 && p; i++, p = p.parentElement) { const m = /[€$£]\s?([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s?[€$£]/.exec(p.textContent || ''); if (m) { price = parseFloat((m[1] || m[2]).replace(/,/g, '')); break; } }
        if (price < bestPrice) { bestPrice = price; best = b; }
      }
      if (!best && buys.length) best = buys[0];
      if (best) best.setAttribute('data-hubie-buy', '1');
      return buys.length ? (bestPrice < Infinity ? bestPrice : -1) : 0;
    }).catch(() => 0);
    if (!n) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    await fr.locator('[data-hubie-buy="1"]').first().click({ timeout: 3000 }).catch(() => {}); await sleep(1800);
    const ok = fr.getByText(/^\s*(ok|confirm|yes|start)\s*$/i).first();
    if (!(await ok.isVisible().catch(() => false))) return false;
    if (!(await ensureFun(page))) { const back = fr.getByText(/^\s*(back|cancel|no)\s*$/i).first(); await back.click({ timeout: 3000 }).catch(() => {}); return false; }   // last check before OK
    await ok.click({ timeout: 3000 }).catch(() => {}); await sleep(2000);
    return n > 0 ? n : true;                                      // the price, if we could read it
  }

  // bonus buy: FUN mode confirmed before and after
  async function buyBonus(prov, name) {
    if (!(await ensureFun(page))) { tell('bonusfail', { game: name }); return false; }
    const frT = slotFrame(page);
    const price = frT ? await buyByText(frT) : false;
    if (price) { const bet = await demoBet(); bonus = { cost: price > 0 && price !== true ? price : bet * 100 || 0, start: Date.now(), vals: [], hit: new Set(), lastAt: Date.now() };
      log('bonus bought on', name, '(FUN mode, by text), cost', bonus.cost); tell('bonus', { game: name, cost: bonus.cost }); return true; }
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
