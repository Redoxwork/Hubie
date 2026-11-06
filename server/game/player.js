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
  dice:     { name: 'Dice',     slugs: ['dice'], auto: true, button: /^(roll|bet)$/i, weight: 4 },
  limbo:    { name: 'Limbo',    slugs: ['limbo'], auto: true, button: /^bet$/i, weight: 3 },
  coinflip: { name: 'Coinflip', slugs: ['coinflip', 'coin-flip'], button: /^(bet|flip)$/i, weight: 2,
              prep: page => clickText(page, Math.random() < 0.5 ? /^heads$/i : /^tails$/i) },
  plinko:   { name: 'Plinko',   slugs: ['plinko'], auto: true, risk: ['low', 'medium', 'high'], button: /^(bet|drop)$/i, weight: 2 },
  wheel:    { name: 'Wheel',    slugs: ['wheel'], auto: true, risk: ['low', 'medium', 'high'], button: /^(bet|spin)$/i, weight: 2 },
  keno:     { name: 'Keno',     slugs: ['keno'], auto: true, risk: ['classic', 'low', 'medium', 'high'], button: /^bet$/i, weight: 1,
              prep: page => clickText(page, /^(auto ?pick|random( pick)?)$/i) },
  maxwin:   { name: 'Max Win',  slugs: ['maxwin', 'max-win'], auto: true, button: /^(bet|spin)$/i, weight: 1 },
  crash:    { name: 'Crash',    slugs: ['crash'], button: /^bet$/i, weight: 2,
              prep: page => setByLabel(page, /cash ?out at|auto ?cash ?out|cashout/i, pick(['1.5', '2', '3'])) },
  // games with steps inside a round: start, take a few steps, cash out
  road:     { name: "Hubie's Road", slugs: ['hubies-road', 'hubiesroad', 'road'], button: /^(bet|play|start)$/i, weight: 3,
              steps: { step: /^go$/i, min: 1, max: 3, cap: 8, cash: /^cash ?out/i } },
  tower:    { name: 'Dragon Tower', slugs: ['dragon-tower', 'dragontower', 'tower'], button: /^(bet|play)$/i, weight: 2, risk: ['easy', 'medium', 'hard'],
              steps: { step: /^random ?pick$/i, min: 1, max: 3, cap: 7, cash: /^cash ?out/i } },
  mines:    { name: 'Mines',    slugs: ['mines'], button: /^(bet|play)$/i, weight: 2, mines: [1, 2, 3, 5],
              steps: { step: /^(random ?pick|pick random( tile)?)$/i, min: 1, max: 3, cap: 6, cash: /^cash ?out/i } },
  hilo:     { name: 'Hilo',     slugs: ['hilo', 'hi-lo'], button: /^(bet|play)$/i, weight: 2,
              steps: { step: 'safer', min: 1, max: 3, cap: 6, cash: /^cash ?out/i } },
  blackjack:{ name: 'Blackjack', slugs: ['blackjack'], button: /^(bet|deal)$/i, weight: 1,
              steps: { step: /^stand$/i, min: 1, max: 1, cash: null } },
  baccarat: { name: 'Baccarat', slugs: ['baccarat'], button: /^(bet|deal)$/i, weight: 1,
              prep: page => clickText(page, Math.random() < 0.6 ? /^banker\b/i : /^player\b/i) },
  roulette: { name: 'Roulette', slugs: ['roulette'], button: /^(bet|spin)$/i, weight: 1,
              prep: page => clickText(page, pick([/^even$/i, /^odd$/i, /^1.18$/i, /^19.36$/i])) },
};
const ALIASES = { coin: 'coinflip', 'coin flip': 'coinflip', 'max win': 'maxwin', max: 'maxwin', plink: 'plinko', 'hubies road': 'road', 'hubie road': 'road', hubiesroad: 'road',
  'dragon tower': 'tower', dragontower: 'tower', dragon: 'tower', mine: 'mines', 'hi lo': 'hilo', 'black jack': 'blackjack', bj: 'blackjack' };
function resolve(n) {
  const k = String(n || '').toLowerCase().replace(/[^a-z ]/g, '').trim(), ns = k.replace(/ /g, '');
  return GAMES[k] ? k : ALIASES[k] ? ALIASES[k] : GAMES[ns] ? ns : null;
}

// ---- page helpers ----
async function clickText(page, re) {
  const el = page.locator('button, [role=button], [role=tab]').filter({ hasText: re }).first();
  if (await el.isVisible().catch(() => false)) { const t = (await el.innerText().catch(() => '')).trim(); if (!NEVER.test(t)) await el.click({ timeout: 3000 }).catch(() => {}); }
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
  if (ok) await page.locator('[data-hubie-set="1"]').first().fill(value, { timeout: 3000 }).catch(() => {});
}
// Find the Bet Amount box, force it to 0, and confirm. Returns true only if it reads exactly 0.
// `ui` is the frame that holds the game (the page itself, or an embedded game frame).
async function zeroBet(ui) {
  const read = () => ui.evaluate(() => {
    const vis = e => !!(e.offsetParent || e.getClientRects().length);
    document.querySelectorAll('[data-hubie-bet]').forEach(e => e.removeAttribute('data-hubie-bet'));
    const ok = x => vis(x) && !/checkbox|radio|range|hidden/i.test(x.type);
    let inp = null;
    // 1) a label whose own text is "Bet Amount" -> the nearest input below it
    for (const el of document.querySelectorAll('label,span,div,p,h1,h2,h3,h4,h5,h6')) {
      if (el.children.length > 3) continue;
      if (!/^\s*(bet amount|bet|amount|chip value)\s*$/i.test(el.textContent || '')) continue;
      let p = el;
      for (let i = 0; i < 5 && p && !inp; i++, p = p.parentElement) inp = [...p.querySelectorAll('input')].find(ok) || null;
      if (inp) break;
    }
    // 2) fallback: first input inside a box that mentions bet amount
    if (!inp) for (const x of document.querySelectorAll('input')) {
      if (!ok(x)) continue;
      let p = x; for (let i = 0; i < 5 && p; i++, p = p.parentElement) if (/bet amount|chip value/i.test(p.innerText || '')) { inp = x; break; }
      if (inp) break;
    }
    if (!inp) return null;
    inp.setAttribute('data-hubie-bet', '1');
    return inp.value;
  }).catch(() => null);
  let v = await read();
  if (v === null) return false;
  const num = x => parseFloat(String(x || '0').replace(',', '.'));
  if (num(v) !== 0) { await ui.locator('[data-hubie-bet="1"]').first().fill('0', { timeout: 3000 }).catch(() => {}); await sleep(300); v = await read(); }
  return v !== null && num(v) === 0;
}
// which frame holds the game controls (main page or an embedded game)
async function findUI(page) {
  for (const f of [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]) {
    if (/challenges\.cloudflare|turnstile|about:blank/.test(f.url())) continue;
    const has = await f.evaluate(() => /bet amount|chip value/i.test(document.body ? document.body.innerText : '')).catch(() => false);
    if (has) return f;
  }
  return page.mainFrame();
}
// one-time dump when the bet box can't be found, so it can be fixed from the log
async function diag(page) {
  for (const f of page.frames()) {
    const info = await f.evaluate(() => [...document.querySelectorAll('input')].slice(0, 8).map(x => {
      const p = x.parentElement && x.parentElement.parentElement;
      return `${x.type}|${x.name || ''}|${x.placeholder || ''}|v=${x.value}|vis=${!!(x.offsetParent || x.getClientRects().length)}|near=${((p && p.innerText) || '').replace(/\s+/g, ' ').slice(0, 40)}`;
    })).catch(e => ['err ' + e.message]);
    log('diag frame', f.url().slice(0, 70), info.length ? '\n   ' + info.join('\n   ') : '(no inputs)');
  }
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
  await el.fill(String(value), { timeout: 3000 }).catch(() => {});
  return el.inputValue().catch(() => null);
}
const readBet = page => page.locator('[data-hubie-bet="1"]').first().inputValue().catch(() => null);

// games with steps inside a round (Road, Tower, Mines, Hilo, Blackjack)
async function runSteps(page, st, n) {
  await sleep(1500);
  let done = 0;
  for (let i = 0; i < n; i++) {
    let b = null;
    if (st.step === 'safer') {                                    // Hilo: the side with the lower multiplier is more likely
      const idx = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /higher|lower/i.test(b.innerText));
        const m = bs.map(b => parseFloat((/([\d.]+)\s*x/i.exec(b.innerText) || [])[1] || '99'));
        if (!bs.length) return -1;
        const i = m.indexOf(Math.min(...m)); bs.forEach(x => x.removeAttribute('data-hubie-pick')); bs[i].setAttribute('data-hubie-pick', '1'); return i;
      }).catch(() => -1);
      if (idx >= 0) b = page.locator('[data-hubie-pick="1"]').first();
    } else b = await playButton(page, st.step);
    if (!b || !(await b.isVisible().catch(() => false))) break;    // round already over (busted or finished)
    await b.click({ timeout: 3000 }).catch(() => {});
    done++;
    await sleep(rand(1200, 2200));
  }
  if (!st.cash) return { done, survived: null };
  const c = await playButton(page, st.cash);                      // cash out still there = he survived every step
  if (c) { await c.click({ timeout: 3000 }).catch(() => {}); return { done, survived: done >= n }; }
  return { done, survived: false };
}

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
  page.setDefaultTimeout(8000);                       // no action can hang the loop
  shared.playing = true;
  sniff(page);
  let current = 'dice', until = Date.now(), fails = 0, rounds = 0, ui = page.mainFrame(), announced = '', announcedAt = 0, diagDone = {};
  const tell = (type, q) => fetch(`${BRAIN}/event?type=${type}&${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  const slots = require('./slots')({ page, shared, base: BASE, tell });
  let nextSlotBreak = Date.now() + rand(90, 150) * 60e3;
  const level = {}, bestLevel = {};
  let riskNow = null;
  // settings: chat's !risk wins, otherwise Hubie picks (mostly medium)
  async function applySettings(key) {
    const g = GAMES[key];
    const pref = await fetch(`${BRAIN}/prefs`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => ({}));
    if (g.risk) {
      let r = pref.risk && g.risk.includes(pref.risk) ? pref.risk : null;
      if (!r) r = pick(g.risk.flatMap(x => Array(x === 'medium' || x === 'classic' ? 3 : 1).fill(x)));
      await clickText(ui, new RegExp('^' + r + '$', 'i'));
      riskNow = r; tell('setting', { game: g.name, risk: r, by: pref.by || '' });
    }
    if (g.mines) {
      const n = pref.risk === 'high' ? 5 : pref.risk === 'low' ? 1 : pick(g.mines);
      const got = await setByLabel(ui, /mines/i, n);
      if (got !== null) tell('setting', { game: g.name, risk: `${n} mines`, by: pref.by || '' });
    }
  }
  let chal = { game: 'limbo', target: 10 }, chalAt = 0;
  const getChal = async () => { if (Date.now() - chalAt > 15e3) { chalAt = Date.now(); const c = await fetch(`${BRAIN}/challenge`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null); if (c && GAMES[c.game]) chal = c; } return chal; };
  // set the Multiplier box: the challenge target on the challenge game, a modest one otherwise
  async function setTarget(key) {
    if (key !== 'limbo' && key !== 'dice') return true;
    const c = await getChal();
    const want = key === c.game ? String(c.target) : key === 'limbo' ? pick(['2', '3', '5']) : null;
    if (!want) return true;
    const got = await setByLabel(ui, /multiplier/i, want);
    return got !== null && Number(got) === Number(want);
  }
  function nextGame() {
    if (Math.random() < 0.5 && chal.game !== current) return chal.game;             // the challenge game, half the time
    const keys = Object.keys(GAMES).filter(k => k !== current);
    const bag = keys.flatMap(k => Array(GAMES[k].weight).fill(k));
    return pick(bag);
  }
  async function open(key, by) {
    current = key; until = Date.now() + rand(5, 10) * 60e3; fails = 0;
    log('opening', GAMES[key].name, by ? `(requested by ${by})` : '');
    for (const slug of GAMES[key].slugs) {
      await page.goto(`${BASE}/games/housegames-${slug}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log('open failed', e.message));
      await sleep(4000);
      const t = await page.title().catch(() => '');
      if (!/404|not found/i.test(t)) break;
      log('no page at', slug);
    }
    await clickText(ui, /^manual$/i);
    tell('game', { game: GAMES[key].name, by: by || '' });
    await applySettings(key);
  }
  // Autobet batch: 10-25 bets, bet box must stay 0 the whole time, stops early if anything looks wrong
  async function autoBatch(g) {
    const n = Math.floor(rand(10, 26));
    await clickText(ui, /^auto$/i); await sleep(800);
    if (!(await zeroBet(ui))) { log('auto: bet box not 0, skipping'); await clickText(ui, /^manual$/i); return false; }
    const set = await setByLabel(ui, /number of bets/i, n);
    if (!set || set === '0' || /∞|inf/i.test(set) || Number(set) !== n) { log('auto: could not set number of bets (', set, '), skipping'); await clickText(ui, /^manual$/i); return false; }
    if (!(await zeroBet(ui))) { await clickText(ui, /^manual$/i); return false; }
    const start = ui.locator('button').filter({ hasText: /^\s*start autobet/i }).first();
    if (!(await start.isVisible().catch(() => false))) { log('auto: no Start Autobet button'); await clickText(ui, /^manual$/i); return false; }
    let got = 0;
    onAutoResult = res => { got++; rounds++; tell('round', { game: g.name, win: res.win ? 1 : 0, mult: res.mult }); };
    tell('auto', { game: g.name, n });
    log(`auto: ${n} bets on ${g.name} at 0`);
    await start.click({ timeout: 3000 });
    const stop = ui.locator('button').filter({ hasText: /stop autobet/i }).first();
    const t0 = Date.now();
    while (Date.now() - t0 < n * 4000 + 20000) {
      await sleep(1000);
      const v = await readBet(ui);
      if (v !== null && parseFloat(v || '0') !== 0) { log('auto: BET BOX NOT 0, stopping now'); await stop.click({ timeout: 3000 }).catch(() => {}); break; }
      if (shared.blocked || got >= n || !(await stop.isVisible().catch(() => false))) break;
    }
    if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 3000 }).catch(() => {});
    onAutoResult = null;
    await sleep(1000); await clickText(ui, /^manual$/i);
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
        const q = await fetch(`${BRAIN}/queue`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
        const want = q && resolve(q.game);
        if (q && q.game && !want) {                                    // not an original: try it as a slot (Fun mode)
          if (process.env.SLOTS === '1') { await slots.play(q.game, q.by); await open('dice'); }
          else tell('unknown', { game: q.game, by: q.by || '' });
          continue;
        }
        if (want) { await open(want, q.by); continue; }
        if (process.env.SLOTS === '1' && Date.now() > nextSlotBreak) {  // now and then, a slot break from Hubie's list
          nextSlotBreak = Date.now() + rand(40, 70) * 60e3;
          await slots.play(slots.favourite()); await open('dice'); continue;
        }
        if (Date.now() > until) { await getChal(); await open(current === 'dice' || Math.random() < 0.35 ? nextGame() : 'dice'); continue; }
        if (!/\/games\//.test(page.url())) { await open(current); continue; }

        const g = GAMES[current];
        if (await page.getByRole('button', { name: /^log ?in$/i }).first().isVisible().catch(() => false)) { if (++fails % 10 === 1) log('not logged in: waiting'); continue; }
        if (!(await zeroBet(ui))) {
          fails++;
          if (fails === 2) ui = await findUI(page);                    // maybe the game is in an embedded frame
          if (fails === 4 && !diagDone[current]) { diagDone[current] = 1; log('bet box not found on', g.name, '- details below'); await diag(page); }
          if (fails >= 8) {                                             // give up on this game for a while, quietly
            log('bet box not confirmed at 0 on', g.name, '- moving on');
            if (current !== 'dice') await open('dice');
            else { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(5000); ui = await findUI(page); fails = 0; await sleep(20000); }
          }
          continue;
        }
        await setTarget(current);
        if (g.auto && process.env.AUTOBET !== '0' && Math.random() < Number(process.env.AUTOBET_SHARE || 0.3)) { await autoBatch(g); fails = 0; continue; }
        if (g.prep) await g.prep(ui);
        if (!(await zeroBet(ui))) continue;                         // check again right before the click
        const b = await playButton(ui, g.button);
        if (!b) { if (++fails >= 5) { log('no play button on', g.name); await open(nextGame()); } continue; }
        const t0 = Date.now(); await b.click({ timeout: 3000 });
        if (g.steps) {                                                  // steps go up after a win, down after a bust
          const st = g.steps; level[current] = level[current] || st.min;
          const r = await runSteps(ui, st, level[current]);
          if (r.survived === true) level[current] = Math.min(st.cap || st.max, level[current] + 1);
          else if (r.survived === false) level[current] = Math.max(st.min, level[current] - 1);
          if (r.survived && r.done > (bestLevel[current] || 0)) { bestLevel[current] = r.done; if (r.done >= 3) tell('steps', { game: g.name, steps: r.done }); }
        }
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
