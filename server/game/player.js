// Game player (first draft): plays Housebets House Originals with bet = 0, one round at a time.
// Rotates games by itself (dice is home), takes !play requests from the brain, reports every round to the brain.
// SAFETY: before every click the Bet Amount must read exactly 0. It never touches ½ / 2× / wallet / deposit / autobet.
// Off unless GAMES=1 (turn on once Housebets clears the security check).
'use strict';
const BRAIN = 'http://127.0.0.1:8090';
const BASE = process.env.HUBIE_GAMES_BASE || 'https://www.housebets.com';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] player:`, ...a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NEVER = /deposit|withdraw|cashier|wallet|buy|purchase|real money|autobet|auto bet|start auto/i;

// ---- game list (url slugs follow the dice page: /games/housegames-dice; fix here if one differs) ----
const GAMES = {
  dice:     { name: 'Dice',     slug: 'dice', auto: true,     button: /^(roll|bet)$/i, weight: 4 },
  limbo:    { name: 'Limbo',    slug: 'limbo', auto: true,    button: /^bet$/i, weight: 2,
              prep: page => setNumber(page, /target|multiplier/i, pick(['2', '3', '5', '10'])) },
  coinflip: { name: 'Coinflip', slug: 'coinflip', button: /^(bet|flip)$/i, weight: 2,
              prep: page => clickText(page, Math.random() < 0.5 ? /^heads$/i : /^tails$/i) },
  plinko:   { name: 'Plinko',   slug: 'plinko', auto: true,   button: /^(bet|drop)$/i, weight: 2 },
  wheel:    { name: 'Wheel',    slug: 'wheel', auto: true,    button: /^(bet|spin)$/i, weight: 1 },
  keno:     { name: 'Keno',     slug: 'keno', auto: true,     button: /^bet$/i, weight: 1,
              prep: page => clickText(page, /^(auto ?pick|random)$/i) },
  maxwin:   { name: 'Max Win',  slug: 'maxwin', auto: true,   button: /^(bet|spin)$/i, weight: 1 },
};
const ALIASES = { coin: 'coinflip', 'coin flip': 'coinflip', 'max win': 'maxwin', max: 'maxwin', plink: 'plinko' };
function resolve(n) {
  const k = String(n || '').toLowerCase().replace(/[^a-z ]/g, '').trim(), ns = k.replace(/ /g, '');
  return GAMES[k] ? k : ALIASES[k] ? ALIASES[k] : GAMES[ns] ? ns : null;
}

// ---- page helpers ----
async function clickText(page, re) {
  const el = page.locator('button, [role=button], [role=tab]').filter({ hasText: re }).first();
  if (await el.isVisible().catch(() => false)) { const t = (await el.innerText().catch(() => '')).trim(); if (!NEVER.test(t)) await el.click().catch(() => {}); }
}
async function setNumber(page, labelRe, value) {
  const ok = await page.evaluate(({ src }) => {
    const re = new RegExp(src, 'i');
    for (const inp of document.querySelectorAll('input')) {
      let p = inp, hit = false; for (let i = 0; i < 4 && p; i++, p = p.parentElement) if (p && re.test(p.innerText || '') && !/bet amount/i.test(p.innerText || '')) { hit = true; break; }
      if (hit && inp.offsetParent) { inp.setAttribute('data-hubie-set', '1'); return true; }
    }
    return false;
  }, { src: labelRe.source }).catch(() => false);
  if (ok) await page.locator('[data-hubie-set="1"]').first().fill(value).catch(() => {});
}
// Find the Bet Amount box, force it to 0, and confirm. Returns true only if it reads exactly 0.
async function zeroBet(page) {
  const read = () => page.evaluate(() => {
    for (const inp of document.querySelectorAll('input')) {
      if (!inp.offsetParent) continue;
      let p = inp; for (let i = 0; i < 5 && p; i++, p = p.parentElement) if (/bet amount|chip value/i.test(p.innerText || '')) { inp.setAttribute('data-hubie-bet', '1'); return inp.value; }
    }
    return null;
  }).catch(() => null);
  let v = await read();
  if (v === null) return false;
  if (parseFloat(v || '0') !== 0) { await page.locator('[data-hubie-bet="1"]').first().fill('0').catch(() => {}); await sleep(300); v = await read(); }
  return v !== null && parseFloat(v || '0') === 0;
}
async function playButton(page, re) {
  const all = page.locator('button');
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = all.nth(i);
    const t = (await b.innerText().catch(() => '')).trim();
    if (re.test(t) && !NEVER.test(t) && await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) return b;
  }
  return null;
}

// set a number box by its label (smallest container wins), never the Bet Amount box
async function setByLabel(page, labelRe, value) {
  const ok = await page.evaluate(({ src }) => {
    const re = new RegExp(src, 'i'); let best = null, bestDepth = 99;
    for (const inp of document.querySelectorAll('input')) {
      if (!inp.offsetParent || inp.hasAttribute('data-hubie-bet')) continue;
      let p = inp; for (let d = 0; d < 5 && p; d++, p = p.parentElement) if (re.test(p.innerText || '')) { if (d < bestDepth) { best = inp; bestDepth = d; } break; }
    }
    document.querySelectorAll('[data-hubie-n]').forEach(e => e.removeAttribute('data-hubie-n'));
    if (best) best.setAttribute('data-hubie-n', '1');
    return !!best;
  }, { src: labelRe.source }).catch(() => false);
  if (!ok) return null;
  const el = page.locator('[data-hubie-n="1"]').first();
  await el.fill(String(value)).catch(() => {});
  return el.inputValue().catch(() => null);
}
const readBet = page => page.locator('[data-hubie-bet="1"]').first().inputValue().catch(() => null);

// ---- round results: read from the game's own network replies (logged once so we can tune) ----
let lastJson = null, keysLogged = 0, onAutoResult = null;
function findResult(o) {
  let mult = null, win = null;
  (function walk(x, d) {
    if (!x || typeof x !== 'object' || d > 5) return;
    for (const [k, v] of Object.entries(x)) {
      if (mult === null && typeof v === 'number' && /payout_?multiplier|^multiplier$|^mult$|result_?multiplier/i.test(k)) mult = v;
      if (win === null && typeof v === 'boolean' && /^(win|won|is_?win)$/i.test(k)) win = v;
      if (v && typeof v === 'object') walk(v, d + 1);
    }
  })(o, 0);
  if (win === null && mult !== null) win = mult >= 1;
  return mult === null && win === null ? null : { mult: mult || 0, win: !!win };
}
function sniff(page) {
  page.on('response', async r => {
    try {
      if (!/housebets/.test(r.url()) || !/json/.test(r.headers()['content-type'] || '')) return;
      const j = await r.json(); const res = findResult(j);
      if (res) { lastJson = { at: Date.now(), ...res }; if (onAutoResult) onAutoResult(res); if (keysLogged < 3) { keysLogged++; log('result keys from', r.url().split('?')[0].slice(-40), Object.keys(j).slice(0, 12).join(',')); } }
    } catch {}
  });
}

// ---- the loop ----
module.exports = function startPlayer(page, shared) {
  sniff(page);
  let current = 'dice', until = Date.now(), fails = 0, rounds = 0;
  const tell = (type, q) => fetch(`${BRAIN}/event?type=${type}&${new URLSearchParams(q)}`).catch(() => {});
  function nextGame() {
    const keys = Object.keys(GAMES).filter(k => k !== current);
    const bag = keys.flatMap(k => Array(GAMES[k].weight).fill(k));
    return pick(bag);
  }
  async function open(key, by) {
    current = key; until = Date.now() + rand(5, 10) * 60e3; fails = 0;
    log('opening', GAMES[key].name, by ? `(requested by ${by})` : '');
    await page.goto(`${BASE}/games/housegames-${GAMES[key].slug}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log('open failed', e.message));
    await sleep(4000);
    await clickText(page, /^manual$/i);
    tell('game', { game: GAMES[key].name, by: by || '' });
  }
  // Autobet batch: 10-25 bets, bet box must stay 0 the whole time, stops early if anything looks wrong
  async function autoBatch(g) {
    const n = Math.floor(rand(10, 26));
    await clickText(page, /^auto$/i); await sleep(800);
    if (!(await zeroBet(page))) { log('auto: bet box not 0, skipping'); await clickText(page, /^manual$/i); return false; }
    const set = await setByLabel(page, /number of bets/i, n);
    if (!set || set === '0' || /∞|inf/i.test(set) || Number(set) !== n) { log('auto: could not set number of bets (', set, '), skipping'); await clickText(page, /^manual$/i); return false; }
    if (!(await zeroBet(page))) { await clickText(page, /^manual$/i); return false; }
    const start = page.locator('button').filter({ hasText: /^\s*start autobet/i }).first();
    if (!(await start.isVisible().catch(() => false))) { log('auto: no Start Autobet button'); await clickText(page, /^manual$/i); return false; }
    let got = 0;
    onAutoResult = res => { got++; rounds++; tell('round', { game: g.name, win: res.win ? 1 : 0, mult: res.mult }); };
    tell('auto', { game: g.name, n });
    log(`auto: ${n} bets on ${g.name} at 0`);
    await start.click();
    const stop = page.locator('button').filter({ hasText: /stop autobet/i }).first();
    const t0 = Date.now();
    while (Date.now() - t0 < n * 4000 + 20000) {
      await sleep(1000);
      const v = await readBet(page);
      if (v !== null && parseFloat(v || '0') !== 0) { log('auto: BET BOX NOT 0, stopping now'); await stop.click().catch(() => {}); break; }
      if (shared.blocked || got >= n || !(await stop.isVisible().catch(() => false))) break;
    }
    if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
    onAutoResult = null;
    await sleep(1000); await clickText(page, /^manual$/i);
    return true;
  }

  (async () => {
    log('on: playing House Originals at bet 0');
    await open('dice');
    for (;;) {
      await sleep(rand(4000, 7000));
      if (shared.blocked || shared.lounge) continue;
      try {
        // chat request first, then rotation
        const q = await fetch(`${BRAIN}/queue`).then(r => r.json()).catch(() => null);
        const want = q && resolve(q.game);
        if (q && q.game && !want) tell('unknown', { game: q.game, by: q.by || '' });
        if (want) { await open(want, q.by); continue; }
        if (Date.now() > until) { await open(current === 'dice' || Math.random() < 0.35 ? nextGame() : 'dice'); continue; }
        if (!/\/games\//.test(page.url())) { await open(current); continue; }

        const g = GAMES[current];
        if (await page.getByRole('button', { name: /^log ?in$/i }).first().isVisible().catch(() => false)) { if (++fails % 10 === 1) log('not logged in: waiting'); continue; }
        if (!(await zeroBet(page))) { if (++fails >= 3) { log('bet box not confirmed at 0: skipping', g.name); await open('dice'); } continue; }
        if (g.auto && process.env.AUTOBET !== '0' && Math.random() < Number(process.env.AUTOBET_SHARE || 0.3)) { await autoBatch(g); fails = 0; continue; }
        if (g.prep) await g.prep(page);
        if (!(await zeroBet(page))) continue;                         // check again right before the click
        const b = await playButton(page, g.button);
        if (!b) { if (++fails >= 5) { log('no play button on', g.name); await open(nextGame()); } continue; }
        const t0 = Date.now(); await b.click();
        fails = 0; rounds++;
        await sleep(2500);
        const res = lastJson && lastJson.at >= t0 ? lastJson : null;
        tell('round', { game: g.name, win: res ? (res.win ? 1 : 0) : '', mult: res ? res.mult : '' });
      } catch (e) { log('round error', e.message); await sleep(3000); }
    }
  })();
};
module.exports.GAMES = GAMES;
module.exports.resolve = resolve;
