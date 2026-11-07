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
  dice:     { name: 'Dice',     slugs: ['dice'], auto: true, button: /^(roll|bet)$/i, weight: 3 },
  limbo:    { name: 'Limbo',    slugs: ['limbo'], auto: true, button: /^bet$/i, weight: 6 },
  coinflip: { name: 'Coinflip', slugs: ['coinflip', 'coin-flip'], auto: true, button: /^(bet|flip)$/i, weight: 2,
              prep: async page => { await clickText(page, Math.random() < 0.5 ? /^\s*heads\s*$/i : /^\s*tails\s*$/i); await setRange(page, /coins/, pick([1, 1, 1, 2, 3])); await setRange(page, /flips/, pick([1, 1, 2, 3])); } },
  plinko:   { name: 'Plinko',   slugs: ['plinko'], auto: true, risk: ['low', 'medium', 'high'], button: /^(bet|drop)$/i, weight: 2,
              prep: page => setRange(page, /^\s*rows/, pick([10, 12, 12, 14, 14])) },
  wheel:    { name: 'Wheel',    slugs: ['wheel'], auto: true, risk: ['low', 'medium', 'high'], button: /^(bet|spin)$/i, weight: 2,
              prep: page => setRange(page, /segments/, pick([20, 30, 40, 40, 50])) },
  keno:     { name: 'Keno',     slugs: ['keno'], auto: true, risk: ['classic', 'low', 'medium', 'high'], button: /^bet$/i, weight: 5,
              prep: page => kenoPick(page) },
  maxwin:   { name: 'Max Win',  slugs: ['max-win', 'maxwin', 'max-win-machine'], auto: true, button: /^(bet|spin)$/i, weight: 1 },
  crash:    { name: 'Crash',    slugs: ['crash'], button: /^\s*(bet|place bet|bet \(next round\)|join)\s*$/i, weight: 2, crash: true,
              prep: page => chalNow().game === 'crash' ? null : setByLabel(page, /cash ?out at|auto ?cash ?out/i, pick(['1.5', '2', '3', '5', '10', '10', '25', '50', '100'])) },
  // games with steps inside a round: start, take a few steps, cash out
  road:     { name: "Hubie's Road", slugs: ['hubies-road', 'hubiesroad', 'hubie-road', 'road'], button: /^(bet|play|start)$/i, weight: 3,
              steps: { step: /^\s*(go|step|next|cross|jump|move)\s*$/i, min: 3, max: 7, cap: 14, cash: /^cash ?out/i } },
  tower:    { name: 'Dragon Tower', slugs: ['dragon-tower', 'dragontower', 'tower'], button: /^(bet|play)$/i, weight: 2, risk: ['easy', 'medium', 'hard'],
              steps: { step: /^\s*(random( ?(pick|tile|egg|card|spot))?|pick random( tile)?|auto ?pick)\s*$/i, min: 2, max: 5, cap: 9, cash: /^cash ?out/i } },
  mines:    { name: 'Mines',    slugs: ['mines'], auto: true, autoPrep: page => pickTiles(page, pick([1, 2, 2, 3, 3, 4, 5, 6])), button: /^(bet|play)$/i, weight: 5, mines: [2, 3, 4, 5, 5, 8, 10, 12],
              steps: { step: /^\s*(random( ?(pick|tile|egg|card|spot))?|pick random( tile)?|auto ?pick)\s*$/i, min: 1, max: 3, cap: 10, cash: /^cash ?out/i, board: true } },
  hilo:     { name: 'Hilo',     slugs: ['hilo', 'hi-lo'], button: /^(bet|play)$/i, weight: 2,
              steps: { step: 'safer', min: 1, max: 3, cap: 6, cash: /^cash ?out/i } },
  blackjack:{ name: 'Blackjack', slugs: ['blackjack'], button: /^(bet|deal)$/i, weight: 2, bj: true },
  baccarat: { name: 'Baccarat', slugs: ['baccarat'], button: /^\s*(bet|deal)\b(?!\s*amount)/i, weight: 1,
              prep: page => clickText(page, Math.random() < 0.6 ? /^banker\b/i : /^player\b/i) },
  roulette: { name: 'Roulette', slugs: ['roulette'], button: /^\s*(bet|spin)\b(?!\s*amount)/i, weight: 1,
              prep: async page => {
                await clickText(page, /^\s*(clear|clear bets|undo all)\s*$/i);
                const spots = [/^\s*even\s*$/i, /^\s*odd\s*$/i, /^\s*1\s*[-–]\s*18\s*$/i, /^\s*19\s*[-–]\s*36\s*$/i, /^\s*1\s*st\s*12\s*$/i, /^\s*2\s*nd\s*12\s*$/i, /^\s*3\s*rd\s*12\s*$/i];
                for (const sp of [pick(spots), ...(Math.random() < 0.4 ? [pick(spots)] : [])]) { await clickAny(page, sp); await sleep(400); }
                if (Math.random() < 0.3) await clickAny(page, new RegExp('^\\s*' + (1 + Math.floor(Math.random() * 36)) + '\\s*$'));   // a straight-up number now and then
              } },
};
const ALIASES = { coin: 'coinflip', 'coin flip': 'coinflip', 'max win': 'maxwin', max: 'maxwin', plink: 'plinko', 'hubies road': 'road', 'hubie road': 'road', hubiesroad: 'road',
  'dragon tower': 'tower', dragontower: 'tower', dragon: 'tower', mine: 'mines', 'hi lo': 'hilo', 'black jack': 'blackjack', bj: 'blackjack' };
function resolve(n) {
  const k = String(n || '').toLowerCase().replace(/[^a-z ]/g, '').trim(), ns = k.replace(/ /g, '');
  return GAMES[k] ? k : ALIASES[k] ? ALIASES[k] : GAMES[ns] ? ns : null;
}

// ---- page helpers ----
// Housebets draws its game panel inside shadow DOM, so plain querySelectorAll can't see it.
// DEEP installs window.__deepAll(sel, root) and window.__up(el) (parent that crosses shadow roots).
const DEEP = `window.__deepAll = function (sel, root) {
  const out = [], seen = new Set();
  (function walk(r) {
    r.querySelectorAll(sel).forEach(e => { if (!seen.has(e)) { seen.add(e); out.push(e); } });
    r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
  })(root || document);
  return out;
};
window.__up = function (el) { return el.parentElement || (el.getRootNode && el.getRootNode().host) || null; };
window.__text = function (el) { try { return el.innerText || el.textContent || ''; } catch (e) { return ''; } };
true`;
const deep = ui => ui.evaluate(DEEP).catch(() => false);
async function clickText(ui, re) {
  // click the first VISIBLE match (pages often keep hidden copies of tabs/buttons)
  const all = ui.locator('button, [role=button], [role=tab]').filter({ hasText: re });
  const n = Math.min(await all.count().catch(() => 0), 15);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = (await el.innerText().catch(() => '')).trim();
    if (!re.test(t) || NEVER.test(t)) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}
// fast mode: switch on a game's Turbo / Instant / Quick spin toggle if it has one (only once per game: the
// game remembers it, so clicking again later could switch it back off)
const turboDone = {};
const speed = {}, speedTries = {};   // per game: 'on' | 'no gain' | 'none' | 'fast enough'
async function turbo(ui, g) {
  if (process.env.TURBO === '0' || turboDone[g.name]) return; turboDone[g.name] = true;
  try {
    const r = await deep(ui).then(() => ui.evaluate(() => {
      const re = /^\s*(turbo( mode| spin)?|instant( bet| mode)?|quick ?spin|fast( mode| play| spin)?)\s*$/i;
      const vis = e => e && (e.offsetParent || e.getClientRects().length);
      const lab = window.__deepAll('label,span,div,p,button').find(e => vis(e) && e.children.length <= 3 && re.test(e.textContent || '') && !/bet amount|stop/i.test(e.textContent));
      if (!lab) return 'none';
      const box = lab.closest('label,[role=switch],button') || lab.parentElement;
      const sw = box.querySelector('[role=switch],input[type=checkbox],[aria-checked],[aria-pressed]') || (box.matches('[role=switch],[aria-checked],[aria-pressed]') ? box : null);
      const on = sw && (sw.checked === true || sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('aria-pressed') === 'true' || /\b(on|active|checked)\b/i.test(sw.className || ''));
      if (on) return 'already on';
      (sw || box).setAttribute('data-hubie-turbo', '1'); return 'off';
    }));
    if (r === 'off') { await ui.locator('[data-hubie-turbo="1"]').first().click({ timeout: 2000 }); log(`auto: turbo/instant mode on for ${g.name}`); await new Promise(r => setTimeout(r, 600)); }
    else if (r === 'already on') log(`auto: turbo already on for ${g.name}`);
  } catch {}
}

// the speed gauge icon in the game footer (Fair · history · GAUGE · sound · stats · star · settings)
async function speedBtn(ui) {
  await deep(ui);
  const r = await ui.evaluate(() => {
    window.__deepAll('[data-hubie-speed]').forEach(e => e.removeAttribute('data-hubie-speed'));   // clear old marks (inside the game panel too)
    const vis = e => e && e.getClientRects().length && e.getBoundingClientRect().width > 0;
    const all = window.__deepAll('button,[role=button]').filter(vis);
    const named = all.find(b => /speed|turbo|fast|instant|quick/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('data-tooltip') || '')));
    let pickB = named, how = 'label';
    if (!pickB) {
      const fair = all.find(b => /^\s*fair\s*$/i.test(b.textContent || ''));
      if (!fair) return null;
      const fy = fair.getBoundingClientRect(); const mid = fy.top + fy.height / 2;
      const row = all.filter(b => b !== fair && !(b.textContent || '').trim() && b.querySelector('svg') && Math.abs(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 - mid) < 20 && b.getBoundingClientRect().left > fy.left)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (!row.length) return null;
      const sound = row.findIndex(b => /sound|volume|mute|audio/i.test((b.getAttribute('aria-label') || '') + (b.title || '')));
      const coloured = row.find(b => { const c = getComputedStyle(b.querySelector('svg')).color.match(/\d+/g) || []; const [r, g, bl] = c.map(Number); return r > 150 && g > 100 && bl < 90; });
      if (sound > 0) { pickB = row[sound - 1]; how = 'next to sound'; }
      else if (coloured) { pickB = coloured; how = 'gold icon'; }
      else if (row.length >= 5) { pickB = row[1]; how = 'footer order'; }
    }
    if (!pickB) return null;
    pickB.setAttribute('data-hubie-speed', '1'); return how;
  }).catch(() => null);
  return r;
}

// keep the game itself on screen: if the page got scrolled down (to the House Games row / Live Bets),
// scroll the game panel back to the top of the view
async function keepInView(ui) {
  await deep(ui);
  const r = await ui.evaluate(() => {
    const vis = e => e && e.getClientRects().length;
    const lab = window.__deepAll('label,span,div,p').find(e => vis(e) && e.children.length <= 2 && /^\s*bet amount\s*$/i.test(e.textContent || '') && !e.closest('table,[role=table],thead'));
    let top = lab || window.__deepAll('canvas').find(c => vis(c) && c.width > 200);
    if (!top) return null;
    while (top.getRootNode() !== document && top.getRootNode().host) top = top.getRootNode().host;   // out of the game's shadow DOM
    let box = top; for (let i = 0; i < 12 && box.parentElement && box.parentElement.getBoundingClientRect().height < innerHeight * 1.6; i++) box = box.parentElement;   // the whole game panel
    const t = box.getBoundingClientRect().top;
    if (t > -40 && t < innerHeight * 0.35) return 'ok';
    box.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); return `scrolled (${Math.round(t)})`;
  }).catch(() => null);
  return r;
}

async function clickAny(ui, re) {
  const all = ui.getByText(re);
  const n = Math.min(await all.count().catch(() => 0), 10);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = (await el.innerText().catch(() => '')).trim();
    if (NEVER.test(t)) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}
// Keno: clear the board, then pick 3-10 random numbers by clicking them
async function kenoPick(ui) {
  await clickText(ui, /^\s*(clear( table)?|reset)\s*$/i); await sleep(400);
  if (await clickText(ui, /^\s*(auto ?pick|random( pick)?)\s*$/i)) return;
  const want = pick([3, 4, 5, 5, 6, 7, 8, 10]); const nums = new Set();
  while (nums.size < want) nums.add(1 + Math.floor(Math.random() * 40));
  for (const k of nums) { await clickAny(ui, new RegExp('^\\s*' + k + '\\s*$')); await sleep(rand(150, 350)); }
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
  await deep(ui);
  const read = () => ui.evaluate(() => {
    const D = window.__deepAll, up = window.__up, T = window.__text;
    const vis = e => !!(e.offsetParent || e.getClientRects().length);
    D('[data-hubie-bet]').forEach(e => e.removeAttribute('data-hubie-bet'));
    const EDIT = 'input, textarea, [contenteditable="true"], [contenteditable=""], [role=spinbutton], [role=textbox]';
    const ok = x => vis(x) && !/checkbox|radio|range|hidden/i.test(x.type || '');
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
    const labels = D('label,span,div,p,h1,h2,h3,h4,h5,h6,legend').filter(el => vis(el) && el.children.length <= 4 &&
      (/^(bet amount|chip value)\b/i.test(own(el)) || /^\s*(bet amount|chip value)\s*$/i.test(el.textContent || '')));
    // never the "Live Bets" feed: its "Bet Amount" column shows other players' bets
    const inFeed = el => { for (let p = el, i = 0; p && i < 12; i++, p = up(p)) { if (/^(TABLE|THEAD|TBODY|TR|TH|TD)$/.test(p.tagName) || /row|cell|columnheader|grid/.test(p.getAttribute && p.getAttribute('role') || '')) return true; if (/^\s*live bets/i.test(T(p).slice(0, 30))) return true; } return false; };
    const real = labels.filter(l => !inFeed(l));
    // 1) a label with an editable box right next to it (the real bet box)
    for (const lab of real) {
      let p = lab;
      for (let i = 0; i < 4 && p; i++, p = up(p)) {
        const ed = D(EDIT, p).find(ok);
        if (ed && !inFeed(ed)) { ed.setAttribute('data-hubie-bet', '1'); return { v: 'value' in ed && ed.tagName !== 'DIV' ? (ed.value || ed.placeholder && '' ) : ed.textContent, edit: true }; }
      }
    }
    // 2) no editable box: the amount printed next to the label
    for (const lab of real) {
      let p = up(lab);
      for (let i = 0; i < 2 && p; i++, p = up(p)) {
        const m = /bet amount[^\d]{0,40}?(\d+(?:\.\d+)?)/i.exec(T(p).replace(/,/g, ''));
        if (m) return { v: m[1], edit: false };
      }
    }
    return null;
  }).catch(() => null);
  const num = x => parseFloat(String(x || '0').replace(',', '.').replace(/[^\d.]/g, '') || '0');
  let r = await read();
  if (!r) {
    const t = await ui.locator('button:visible').filter({ hasText: /^\s*bet\s*[·•:-]\s*[\d.,]+/i }).first().innerText().catch(() => '');
    const m = /bet\s*[·•:-]\s*([\d.,]+)/i.exec(t || '');
    return !!m && parseFloat(m[1].replace(/,/g, '')) === 0;
  }
  if (num(r.v) !== 0) {
    if (!r.edit) return false;                                          // shows a real amount and we can't change it: never bet
    const el = ui.locator('[data-hubie-bet="1"]').first();             // playwright locators see inside shadow DOM
    await el.fill('0', { timeout: 3000 }).catch(async () => { await el.click({ timeout: 2000 }).catch(() => {}); await el.press('Control+A').catch(() => {}); await el.type('0').catch(() => {}); });
    await sleep(300); r = await read();
  }
  return !!r && num(r.v) === 0;
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
    if (/challenges\.cloudflare/.test(f.url())) continue;
    await deep(f);
    const pw = await f.locator('input:visible').count().catch(() => -1);
    const info = await f.evaluate(() => {
      const D = window.__deepAll, up = window.__up;
      const vis = e => !!(e.offsetParent || e.getClientRects().length);
      const shadows = D('*').filter(e => e.shadowRoot).length;
      const vin = D('input').filter(vis).slice(0, 6).map(x => `${x.type}|${x.name || ''}|${x.placeholder || ''}|v=${x.value}`);
      const lab = D('*').find(el => vis(el) && el.children.length <= 4 && /^\s*bet amount\s*$/i.test(el.textContent || ''));
      let p = lab; for (let i = 0; i < 3 && p && up(p); i++) p = up(p);
      return { shadows, vin, html: p ? (p.outerHTML || '').replace(/\s+/g, ' ').replace(/ class="[^"]*"/g, '').slice(0, 600) : '(no visible Bet Amount label)' };
    }).catch(e => ({ shadows: '?', vin: [], html: 'err ' + e.message }));
    log('diag', f.url().slice(0, 60), `\n   shadow hosts: ${info.shadows} · playwright visible inputs: ${pw}`, '\n   visible inputs:', info.vin.join(' ; ') || 'none', '\n   html:', info.html);
  }
}
function stopBtn(ui) { return ui.locator('button:visible').filter({ hasText: /^\s*(stop|stop auto\w*|cancel auto\w*)\b(?!\s*on)/i }).first(); }
async function autoRunning(ui) { return stopBtn(ui).isVisible().catch(() => false); }
async function autoDiag(ui) {
  await deep(ui);
  const rows = await ui.evaluate(() => {
    const D = window.__deepAll, up = window.__up, T = window.__text;
    const vis = e => !!(e.offsetParent || e.getClientRects().length);
    return D('input, [contenteditable="true"], [role=spinbutton]').filter(vis).slice(0, 10).map(x => {
      let p = x, t = ''; for (let i = 0; i < 3 && p; i++) { p = up(p); if (p) t = T(p).replace(/\s+/g, ' ').trim(); if (t.length > 3) break; }
      return `${x.tagName.toLowerCase()}|${x.type || ''}|v=${x.value ?? x.textContent}|ph=${x.placeholder || ''}|near="${t.slice(0, 50)}"`;
    });
  }).catch(e => ['err ' + e.message]);
  const btns = await ui.evaluate(() => window.__deepAll('button').filter(b => b.offsetParent || b.getClientRects().length).map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 25).join(' | ')).catch(() => '');
  log('auto panel (one time):\n   ' + rows.join('\n   ') + '\n   buttons: ' + btns);
}
// click n random hidden tiles on a game board (Mines, Dragon Tower...): the biggest group of
// same-size, label-less, clickable squares on screen. Never anything with text on it.
const PATTERNS = ['random', 'random', 'corners', 'diagonal', 'row', 'column', 'cluster', 'edge', 'center', 'zigzag'];
// set a slider (input type=range) by the label next to it, e.g. "Segments", "Coins", "Flips"
async function setRange(ui, labelRe, value) {
  await deep(ui);
  return ui.evaluate(({ src, value }) => {
    const D = window.__deepAll, up = window.__up, T = window.__text, re = new RegExp(src, 'i');
    for (const r of D('input[type=range]')) {
      if (!(r.offsetParent || r.getClientRects().length) || r.disabled) continue;
      let p = r, hit = false; for (let i = 0; i < 4 && p; i++, p = up(p)) if (re.test(T(p))) { hit = true; break; }
      if (!hit) continue;
      const v = Math.max(Number(r.min || 0), Math.min(Number(r.max || 100), value));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v));
      r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
      return r.value;
    }
    return null;
  }, { src: labelRe.source, value }).catch(() => null);
}
async function pickTiles(ui, n, pattern) {
  pattern = pattern || pick(PATTERNS);
  await deep(ui);
  const ok = await ui.evaluate(({ n, pattern }) => {
    const D = window.__deepAll;
    const cands = D('button, [role=button], div, span').filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 30 || r.height < 30 || r.width > 220 || Math.abs(r.width - r.height) > r.width * 0.45) return false;
      if ((e.innerText || '').trim()) return false;                              // tiles have no text
      const st = getComputedStyle(e);
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') return false;
      return e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || st.cursor === 'pointer';
    });
    // group by size, keep the biggest group (the board)
    const groups = {};
    for (const e of cands) { const r = e.getBoundingClientRect(); const k = Math.round(r.width / 4) + 'x' + Math.round(r.height / 4); (groups[k] = groups[k] || []).push(e); }
    let board = Object.values(groups).sort((a, b) => b.length - a.length)[0] || [];
    board = board.filter(e => !board.some(o => o !== e && o.contains(e)));          // outermost only
    if (board.length < 4) return 0;
    // lay the tiles out as a grid (rows/cols by position)
    const pos = board.map(e => { const r = e.getBoundingClientRect(); return { e, x: r.left, y: r.top }; });
    const uniq = (v, tol) => v.sort((a, b) => a - b).filter((x, i, a) => !i || x - a[i - 1] > tol);
    const w = board[0].getBoundingClientRect().width / 2;
    const xs = uniq(pos.map(p => p.x), w), ys = uniq(pos.map(p => p.y), w);
    for (const p of pos) { p.c = xs.findIndex(x => Math.abs(x - p.x) <= w); p.r = ys.findIndex(y => Math.abs(y - p.y) <= w); }
    const R = ys.length, C = xs.length, at = (r, c) => pos.find(p => p.r === r && p.c === c);
    const rnd = k => Math.floor(Math.random() * k);
    let order = [];
    const r0 = rnd(R), c0 = rnd(C);
    if (pattern === 'corners') order = [at(0, 0), at(0, C - 1), at(R - 1, 0), at(R - 1, C - 1)];
    else if (pattern === 'diagonal') order = Array.from({ length: Math.min(R, C) }, (_, i) => Math.random() < .5 ? at(i, i) : at(i, C - 1 - i));
    else if (pattern === 'row') order = Array.from({ length: C }, (_, c) => at(r0, c));
    else if (pattern === 'column') order = Array.from({ length: R }, (_, r) => at(r, c0));
    else if (pattern === 'edge') order = pos.filter(p => p.r === 0 || p.c === 0 || p.r === R - 1 || p.c === C - 1);
    else if (pattern === 'center') order = pos.slice().sort((a, b) => (Math.abs(a.r - (R - 1) / 2) + Math.abs(a.c - (C - 1) / 2)) - (Math.abs(b.r - (R - 1) / 2) + Math.abs(b.c - (C - 1) / 2)));
    else if (pattern === 'cluster') order = pos.slice().sort((a, b) => (Math.abs(a.r - r0) + Math.abs(a.c - c0)) - (Math.abs(b.r - r0) + Math.abs(b.c - c0)));
    else if (pattern === 'zigzag') order = pos.slice().sort((a, b) => a.r - b.r || (a.r % 2 ? b.c - a.c : a.c - b.c)).filter((_, i) => i % 2 === 0);
    order = order.filter(Boolean);
    if (pattern !== 'center' && pattern !== 'cluster' && pattern !== 'zigzag') order.sort(() => Math.random() - 0.5);
    for (const p of pos.slice().sort(() => Math.random() - 0.5)) if (!order.includes(p)) order.push(p);   // top up with random ones
    // skip tiles already opened (they change look/disable after a click)
    const fresh = order.filter(p => !p.e.disabled && p.e.getAttribute('aria-disabled') !== 'true' && !p.e.hasAttribute('data-hubie-done'));
    D('[data-hubie-tile]').forEach(e => e.removeAttribute('data-hubie-tile'));
    let k = 0;
    for (const p of fresh) { if (k >= n) break; p.e.setAttribute('data-hubie-done', '1'); p.e.setAttribute('data-hubie-tile', String(k)); k++; }
    return k ? board.length : 0;
  }, { n, pattern }).catch(() => 0);
  for (let k = 0; ok && k < n; k++) {                                   // real mouse clicks, one by one
    await ui.locator(`[data-hubie-tile="${k}"]`).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(rand(350, 800));
  }
  if (!ok) await clickText(ui, /^\s*(random( ?(pick|tile|egg|card|spot))?|pick random( tile)?|auto ?pick)\s*$/i);
  await sleep(600);
  return ok;
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

// set a number box OR dropdown by its label (smallest container wins), never the Bet Amount box
async function setByLabel(ui, labelRe, value) {
  await deep(ui);
  const kind = await ui.evaluate(({ src }) => {
    const D = window.__deepAll, up = window.__up, T = window.__text;
    const re = new RegExp(src, 'i'); let best = null, bestDepth = 99;
    for (const inp of D('input, select')) {
      if (!(inp.offsetParent || inp.getClientRects().length) || inp.hasAttribute('data-hubie-bet') || /checkbox|radio|range|hidden/i.test(inp.type)) continue;
      let p = inp; for (let d = 0; d < 5 && p; d++, p = up(p)) if (re.test(T(p))) { if (d < bestDepth) { best = inp; bestDepth = d; } break; }
    }
    D('[data-hubie-n]').forEach(e => e.removeAttribute('data-hubie-n'));
    if (!best) return null;
    best.setAttribute('data-hubie-n', '1');
    return best.tagName === 'SELECT' ? 'select' : 'input';
  }, { src: labelRe.source }).catch(() => null);
  if (!kind) return null;
  const el = ui.locator('[data-hubie-n="1"]').first();
  if (kind === 'select') {
    await el.selectOption({ label: String(value) }, { timeout: 3000 }).catch(() => el.selectOption(String(value), { timeout: 3000 }).catch(() => {}));
    return el.evaluate(e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].text.trim() : null).catch(() => null);
  }
  await el.fill(String(value), { timeout: 3000 }).catch(() => {});
  return el.inputValue().catch(() => null);
}
const readBet = page => page.locator('[data-hubie-bet="1"]').first().inputValue().catch(() => null);

// games with steps inside a round (Road, Tower, Mines, Hilo, Blackjack)
let boardBroken = false; let chalNow = () => ({});
async function waitBtn(ui, re, ms) { const t0 = Date.now(); for (;;) { const b = await playButton(ui, re); if (b || Date.now() - t0 > ms) return b; await sleep(400); } }
const anyVisible = (ui, re) => ui.locator('button:visible').filter({ hasText: re }).count().then(c => c > 0).catch(() => false);
async function runSteps(page, st, n) {
  await sleep(1500);
  await deep(page); await page.evaluate(() => window.__deepAll('[data-hubie-done]').forEach(e => e.removeAttribute('data-hubie-done'))).catch(() => {});
  const pattern = pick(PATTERNS); let skips = 0;
  let done = 0;
  for (let i = 0; i < n; i++) {
    let b = null;
    if (st.step === 'safer') {                                    // Hilo: the side with the lower multiplier is more likely
      // wait for Higher/Lower to come alive after the deal
      for (let w = 0; w < 12 && !(await page.locator('button:visible:enabled').filter({ hasText: /higher|lower/i }).count().catch(() => 0)); w++) await sleep(500);
      await deep(page);
      const idx = await page.evaluate(() => {
        const bs = window.__deepAll('button').filter(b => (b.offsetParent || b.getClientRects().length) && !b.disabled && /higher|lower/i.test(b.innerText));
        const m = bs.map(b => parseFloat((/([\d.]+)\s*x/i.exec(b.innerText) || [])[1] || '99'));
        if (!bs.length) return -1;
        const i = m.indexOf(Math.min(...m)); bs.forEach(x => x.removeAttribute('data-hubie-pick')); bs[i].setAttribute('data-hubie-pick', '1'); return i;
      }).catch(() => -1);
      if (idx >= 0) {
        const mults = await page.locator('button:visible').filter({ hasText: /higher|lower/i }).allInnerTexts().catch(() => []);
        const ms = mults.map(t => parseFloat((/([\d.]+)\s*x/i.exec(t) || [])[1] || '0')).filter(Boolean);
        if (ms.length === 2 && Math.min(...ms) > 1.75 && skips < 2 && Math.random() < 0.5) { skips++;     // a middle card: skip it
          const skip = page.locator('button:visible[aria-label*="skip" i], button:visible[title*="skip" i]').first();
          if (await skip.count().catch(() => 0)) { await sleep(rand(600, 1200)); await skip.click({ timeout: 3000 }).catch(() => {}); await sleep(1500); i--; continue; }
        }
        b = page.locator('[data-hubie-pick="1"]').first(); await sleep(rand(800, 1800));
      }
    } else if (i === 0 && !(await waitBtn(page, st.step, 6000)) && !st.board) { break;
    } else if (st.board && !boardBroken && Math.random() < 0.8) {      // click the board itself, in this round's pattern
      if (await pickTiles(page, 1, pattern)) {
        await sleep(rand(900, 1500));
        if (await playButton(page, st.cash)) { done++; continue; }      // cash out came alive: the tile opened and was safe
        if (!(await anyVisible(page, st.step)) && !(await anyVisible(page, st.cash))) { done++; break; }   // hit a mine, round over
        boardBroken = true; log('board clicks not taking: using the Random tile button');
      }
      b = await playButton(page, st.step);
    } else b = await playButton(page, st.step);
    if (!b || !(await b.isVisible().catch(() => false))) {
      if (st.step !== 'safer' && (await playButton(page, st.cash || /^$/))) {    // round still on: click a tile on the board
        if (await pickTiles(page, 1, pattern)) { done++; await sleep(rand(900, 1800)); continue; }
      }
      break;                                                          // round already over (busted or finished)
    }
    await b.click({ timeout: 3000 }).catch(() => {});
    done++;
    await sleep(rand(1200, 2200));
  }
  if (!st.cash) return { done, survived: null };
  const c = await playButton(page, st.cash);                      // cash out still there = he survived every step
  if (c) { await c.click({ timeout: 3000 }).catch(() => {}); return { done, survived: done >= n }; }
  return { done, survived: false };
}

// ---- blackjack: basic strategy from the hand values shown on the table ----
async function bjRead(ui) {
  await deep(ui);
  return ui.evaluate(() => {
    const vis = e => !!(e.offsetParent || e.getClientRects().length);
    const vals = window.__deepAll('span,div,p,b,strong').filter(e => vis(e) && e.children.length === 0 && /^\s*(\d{1,2})(\s*[\/,]\s*\d{1,2})?\s*$/.test(e.textContent || '') && !e.closest('input') && !e.closest('button') && !e.closest('[role=button]'))
      .map(e => { const t = e.textContent.trim(); const n = t.split(/[\/,]/).map(Number).filter(x => x <= 21); const r = e.getBoundingClientRect(); return { el: e, y: r.top, x: r.left, best: Math.max(...n), soft: n.length > 1 }; })
      .filter(v => v.best >= 2 && v.best <= 21);
    if (vals.length < 2) return null;
    // split the table into dealer (top) and player (bottom): the "blackjack pays" line, else the middle
    const mid = window.__deepAll('div,span,p').find(e => vis(e) && /blackjack pays/i.test(e.textContent || '') && e.children.length <= 2);
    const ys = vals.map(v => v.y); const cut = mid ? mid.getBoundingClientRect().top : (Math.min(...ys) + Math.max(...ys)) / 2;
    const top = vals.filter(v => v.y < cut), bot = vals.filter(v => v.y >= cut);
    if (!top.length || !bot.length) return null;
    // the total badge is always >= any single card's number on that side
    const d = top.reduce((a, b) => b.best > a.best ? b : a), me = bot.reduce((a, b) => b.best > a.best || (b.best === a.best && b.soft) ? b : a);
    // the player's card ranks (A, 2-10, J, Q, K) under the line, not the total badge itself
    const ranks = window.__deepAll('span,div,p,b,strong').filter(e => vis(e) && e.children.length === 0 && e !== me.el && e.getBoundingClientRect().top >= cut &&
      /^\s*(A|K|Q|J|10|[2-9])\s*$/.test(e.textContent || '') && !e.closest('button') && !e.closest('input')).map(e => e.textContent.trim());
    const val = r => r === 'A' ? 11 : /^[KQJ]$/.test(r) ? 10 : Number(r);
    const live = window.__deepAll('button').filter(b => vis(b) && !b.disabled).map(b => (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase());
    const pair = ranks.length === 2 && val(ranks[0]) === val(ranks[1]) ? val(ranks[0]) : 0;
    return { dealer: d.best, me: me.best, soft: me.soft || (ranks.length === 2 && ranks.includes('A') && me.best <= 21 && me.best >= 12), pair, cards: ranks.length, canDouble: live.some(t => /\bdouble\b/.test(t)), canSplit: live.some(t => /\bsplit\b/.test(t)) };
  }).catch(() => null);
}
function bjMove(h) {
  const { me, dealer: d, soft, pair } = h;
  if (pair && h.canSplit) {
    if (pair === 11 || pair === 8) return 'split';
    if (pair === 9 && d !== 7 && d <= 9) return 'split';
    if ((pair === 2 || pair === 3 || pair === 7) && d <= 7) return 'split';
    if (pair === 6 && d <= 6) return 'split';
    if (pair === 4 && (d === 5 || d === 6)) return 'split';
  }
  if (h.cards > 2) h = { ...h, canDouble: false };
  if (soft) { if (me >= 19) return 'stand'; if (me === 18) return d >= 9 ? 'hit' : (d >= 3 && d <= 6 && h.canDouble ? 'double' : 'stand'); if (me >= 15 && d >= 4 && d <= 6 && h.canDouble) return 'double'; return 'hit'; }
  if (me >= 17) return 'stand';
  if (me >= 13) return d <= 6 ? 'stand' : 'hit';
  if (me === 12) return d >= 4 && d <= 6 ? 'stand' : 'hit';
  if (me === 11) return h.canDouble ? 'double' : 'hit';
  if (me === 10) return d <= 9 && h.canDouble ? 'double' : 'hit';
  if (me === 9) return d >= 3 && d <= 6 && h.canDouble ? 'double' : 'hit';
  return 'hit';
}
let shared_bj = 0;
async function playBlackjack(ui, tell) {
  const HIT = /^\s*hit\s*$/i, STAND = /^\s*stand\s*$/i, BET = /^(bet|deal)$/i;
  for (let i = 0; i < 12; i++) {
    await clickText(ui, /^\s*(no( insurance)?|decline|no thanks)\s*$/i);   // never take insurance
    // wait for the deal animation: Hit/Stand come alive, or the hand already ended (Bet is back)
    let hit = null, stand = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      hit = await playButton(ui, HIT); stand = await playButton(ui, STAND);
      if (hit || stand) break;
      if (await playButton(ui, BET)) return;                          // hand is over
      await sleep(500);
    }
    if (!hit && !stand) return;
    const h = await bjRead(ui);
    let move = h ? bjMove(h) : 'stand';
    let b = move === 'double' ? await playButton(ui, /^\s*(2\s*[x×]\s*)?double( down)?\s*$/i) : move === 'split' ? await playButton(ui, /^\s*split\s*$/i) : null;
    if (!b) { if (move === 'double' || move === 'split') { const h2 = { ...h, pair: 0, canDouble: false }; move = bjMove(h2); } b = move === 'hit' ? (hit || stand) : (stand || hit); }
    if (h) tell('bj', { me: h.me + (h.soft ? ' soft' : ''), dealer: h.dealer, action: move, pair: h.pair || '' });
    await sleep(rand(1200, 2600));                                   // a beat to 'think', like a real player
    await b.click({ timeout: 3000 }).catch(() => {});
    await sleep(rand(1800, 2600));
  }
}

// ---- round results: read from the game's own network replies (logged once so we can tune) ----
let lastJson = null, keysLogged = 0, onAutoResult = null; const errLog = {};
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
// other players' big wins from the Live Bets feed (for shoutouts) - never counted as Hubie's rounds
let feedTell = null, feedLogged = false, lastFeed = 0; const feedSeen = new Set();
function onFeed(j) {
  const items = Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
  if (items.length && !feedLogged) { feedLogged = true; log('live feed item keys:', Object.keys(items[0]).slice(0, 15).join(',')); }
  for (const it of items) {
    let mult = 0, game = '', user = '', id = it.id || it.bet_id || '';
    (function walk(x, d) { if (!x || typeof x !== 'object' || d > 3) return;
      for (const [k, v] of Object.entries(x)) {
        if (!mult && typeof v === 'number' && /multiplier|^mult$|payout_?x/i.test(k)) mult = v;
        if (!game && typeof v === 'string' && /^(game(_?name|_?title|_?slug)?|title|name)$/i.test(k) && d > 0 && /game/i.test(JSON.stringify(Object.keys(x)))) game = v;
        if (!user && typeof v === 'string' && /^(user_?name|username|display_?name|player_?name|nickname)$/i.test(k)) user = v;
        if (v && typeof v === 'object') walk(v, d + 1);
      } })(it, 0);
    if (typeof it.game_name === 'string') game = it.game_name; else if (!game && typeof it.game === 'string') game = it.game;
    if (typeof it.player_username === 'string') user = it.player_username;
    if (it.is_private) user = '';                                     // private players are never named
    if (typeof it.multiplier === 'number') mult = it.multiplier; else if (typeof it.multiplier === 'string') mult = parseFloat(it.multiplier) || mult;
    if (it.is_win === false) mult = 0;
    const key = id || `${user}|${game}|${mult}`;
    if (feedSeen.has(key)) continue; feedSeen.add(key); if (feedSeen.size > 3000) feedSeen.clear();
    if (mult >= 100 && Date.now() - lastFeed > 8 * 60e3 && feedTell) {
      lastFeed = Date.now();
      feedTell('feed', { user: /private|anonymous|hidden/i.test(user) || !user ? '' : user.slice(0, 24), game: String(game).replace(/^housegames-/, '').slice(0, 30), mult: Math.round(mult * 100) / 100 });
    }
  }
}
function sniff(page) {
  page.on('response', async r => {
    try {
      if (!/housebets/.test(r.url()) || !/json/.test(r.headers()['content-type'] || '')) return;
      const j = await r.json();
      if (/live-?feed|live-?bets|recent-?bets|high-?rollers|lucky-?wins/i.test(r.url())) { onFeed(j); return; }
      if (/fairness|paytable|config|settings|rules|history|seed|stats|leaderboard|limits|currencies/i.test(r.url())) return;
      if (j && (j.error || (j.code && j.code !== 200 && j.code !== 'ok' && j.code !== 0)) && /games\.housebets/.test(r.url())) {
        const k = r.url().split('?')[0].split('/').slice(-2).join('/'); errLog[k] = errLog[k] || { n: 0, at: 0 };
        if (errLog[k].n++ < 3 || Date.now() - errLog[k].at > 10 * 60e3) { errLog[k].at = Date.now(); log('game server said no on', k, '->', JSON.stringify({ code: j.code, error: j.error, message: j.message }).slice(0, 200)); }
      }
      const res = findResult(j);
      if (res) { lastJson = { at: Date.now(), ...res }; if (onAutoResult) onAutoResult(res); if (keysLogged < 3) { keysLogged++; log('result keys from', r.url().split('?')[0].slice(-40), Object.keys(j).slice(0, 12).join(',')); } }
    } catch {}
  });
}

// ---- the loop ----
module.exports = function startPlayer(page, shared) {
  page.setDefaultTimeout(8000);                       // no action can hang the loop
  shared.playing = true;
  sniff(page);
  feedTell = (t, q) => fetch(`${BRAIN}/event?type=${t}&${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  let stuckReloads = {}, waitTries = 0, openTries = 0, autoDiagDone = false, openedAt = Date.now(), justRan = false; let current = 'dice', until = Date.now(), fails = 0, rounds = 0, ui = page.mainFrame(), announced = '', announcedAt = 0, diagDone = {};
  const tellRaw = (type, q) => fetch(`${BRAIN}/event?type=${type}&${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  const tell = (type, q) => { if (type === 'round') shared.lastRound = Date.now(); return tellRaw(type, q); };
  const slots = require('./slots')({ page, shared, base: BASE, tell });
  let nextSlotBreak = Date.now() + rand(50, 70) * 60e3;
  const level = {}, bestLevel = {};
  let riskNow = null;
  // settings: chat's !risk wins, otherwise Hubie picks (mostly medium)
  async function applySettings(key) {
    const g = GAMES[key];
    const pref = await fetch(`${BRAIN}/prefs`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => ({}));
    if (g.risk) {
      let r = pref.risk && g.risk.includes(pref.risk) ? pref.risk : null;
      if (!r) r = pick(g.risk.flatMap(x => Array(x === 'high' || x === 'hard' ? 3 : x === 'medium' || x === 'classic' ? 2 : 1).fill(x)));
      await clickText(ui, new RegExp('^' + r + '$', 'i'));
      riskNow = r; tell('setting', { game: g.name, risk: r, by: pref.by || '' });
    }
    if (g.mines) {
      const n = pref.risk === 'high' ? 5 : pref.risk === 'low' ? 1 : pick(g.mines);
      const got = await setByLabel(ui, /mines/i, n);
      if (got !== null) tell('setting', { game: g.name, risk: `${n} mines`, by: pref.by || '' });
    }
  }
  let chal = {}, chalAt = 0; chalNow = () => chal;
  const getChal = async () => { if (Date.now() - chalAt > 15e3) { chalAt = Date.now(); const c = await fetch(`${BRAIN}/challenge`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null); if (c && (GAMES[c.game] || !c.game)) chal = c; } return chal; };
  // set the Multiplier box: the challenge target on the challenge game, a modest one otherwise
  async function setTarget(key) {
    const c = await getChal();
    const onCh = key === c.game && c.kind === 'mult';
    if (key === 'limbo' || key === 'dice') {
      const want = onCh ? String(c.target) : key === 'limbo' ? pick(['2', '3', '5', '10', '10', '25', '50', '100']) : pick(['2', '3', '5', '10', '10', '25', '50']);
      const got = await setByLabel(ui, /multiplier/i, want);
      return got !== null && Number(got) === Number(want);
    }
    if (key === 'crash' && onCh) await setByLabel(ui, /cash ?out at|auto ?cash ?out/i, String(c.target));
    if (onCh && (key === 'plinko' || key === 'keno' || key === 'wheel')) await clickText(ui, /^\s*high\s*$/i);   // big targets need high risk
    return true;
  }

  const noAuto = {}, autoMiss = new Proxy({}, { get: (o, k) => o[k] || 0 });
  const benched = {};                                    // game -> until (keeps failing: skip it for a while)
  const bench = (k, why) => { if (k === 'dice') return; benched[k] = Date.now() + 2 * 3600e3; log(`benching ${GAMES[k].name} for 2h (${why})`); };
  const gameUrls = {}, goodUrls = {}; let urlsFound = 0;
  // the page we landed on must be this game: its name in the page, and not a different game's name instead
  const looksLike = key => page.evaluate(({ names, others }) => {
    const n = t => String(t || '').toLowerCase().replace(/[^a-z]/g, '');
    const txt = n(document.title + ' ' + location.pathname + ' ' + [...document.querySelectorAll('h1,h2,[class*=title i]')].slice(0, 8).map(e => e.textContent).join(' '));
    const url = n(location.pathname);
    if (names.some(x => x.length > 2 && (txt.includes(x) || url.includes(x)))) return true;
    return !others.some(x => x.length > 3 && url.includes(x));          // no name found: ok unless the address names another game
  }, { names: [GAMES[key].name, ...GAMES[key].slugs].map(norm), others: Object.entries(GAMES).filter(([k]) => k !== key).flatMap(([, g]) => [g.name, ...g.slugs]).map(norm) }).catch(() => true);
  const is404 = pg => pg.evaluate(() => /page not found|^\s*404\b/i.test((document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 400) : ''))).catch(() => false);
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z]/g, '');
  // visit the lobby pages and match every game link to our Originals by its name/picture text
  async function findGames() {
    urlsFound = Date.now();
    const links = [];
    for (const p of ['/games', '/casino', '/casino/house-games', '/originals']) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(3000); if (await is404(page)) continue;
      for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 1500).catch(() => {}); await sleep(500); }
      links.push(...await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href,
        text: [a.innerText, a.getAttribute('aria-label'), a.title, ...[...a.querySelectorAll('img')].map(i => i.alt)].join(' ') }))).catch(() => []));
      if (links.filter(l => /housegames-|originals?\//i.test(l.href)).length >= 10) break;
    }
    const used = new Set();
    for (const [key, g] of Object.entries(GAMES)) {
      const names = [g.name, ...g.slugs].map(norm).filter(n => n.length > 2);
      const cands = links.filter(l => /\/(games?|casino|originals?)\//.test(l.href) && !used.has(l.href.split('?')[0]) && !/evolution|pragmatic|ezugi|playtech|hacksaw|nolimit|relax|push-gaming|bgaming|spribe|live|crazy/i.test(l.href.split('/').pop()));   // Originals only, never provider/live games
      const bySlug = cands.find(l => /housegames-/i.test(l.href) && names.some(n => norm(l.href.split('/').pop()).includes(n)))
        || cands.find(l => names.some(n => norm(l.href.split('/').pop()) === n ));
      const byText = cands.find(l => norm(l.text).length < 30 && names.some(n => norm(l.text) === n || norm(l.text).startsWith(n)));
      const hit = bySlug || byText;
      if (hit) { gameUrls[key] = hit.href.split('?')[0]; used.add(gameUrls[key]); }
    }
    log('game links found:', Object.entries(gameUrls).map(([k, u]) => `${k}=${u.replace(BASE, '')}`).join(' '));
  }
  const recent = [], lastOpened = {}, bootT = Date.now();
  function nextGame() {
    const ok = k => !(benched[k] > Date.now());
    if (chal.game && GAMES[chal.game] && chal.game !== current && ok(chal.game) && Math.random() < 0.55) return chal.game;   // often: go after the current challenge
    const keys = Object.keys(GAMES).filter(k => k !== current && ok(k) && recent.filter(r => r === k).length < 2);
    if (!keys.length) return 'dice';
    // variety: a game not seen for a while gets a bigger chance (x2 after 1h, x4 after 2h+), so every Original shows up
    const bag = keys.flatMap(k => { const h = (Date.now() - (lastOpened[k] || bootT - 3600e3)) / 3600e3; return Array(GAMES[k].weight * (h >= 2 ? 4 : h >= 1 ? 2 : 1)).fill(k); });
    return pick(bag);
  }
  async function open(key, by) {
    recent.push(key); if (recent.length > 5) recent.shift();
    lastOpened[key] = Date.now(); current = key; until = Date.now() + (key === chal.game ? 25 : rand(5, 10)) * 60e3; fails = 0; openedAt = Date.now();
    log('opening', GAMES[key].name, by ? `(requested by ${by})` : '');
    let ok = false;
    const urls = [...(goodUrls[key] ? [goodUrls[key]] : []), ...GAMES[key].slugs.map(sl => `${BASE}/games/housegames-${sl}`), ...(gameUrls[key] ? [gameUrls[key]] : [])];
    for (const url of [...new Set(urls)]) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log('open failed', e.message));
      await sleep(4000);
      if (!(await is404(page)) && await looksLike(key)) { ok = true; goodUrls[key] = url; break; }
      log('no page at', url);
    }
    if (!ok && !(urlsFound > Date.now() - 30 * 60e3)) { await findGames(); if (gameUrls[key]) { await page.goto(gameUrls[key], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(4000); ok = !(await is404(page)) && await looksLike(key); if (ok) goodUrls[key] = gameUrls[key]; } }
    if (!ok) {
      log('could not find a page for', GAMES[key].name);
      if (by) tell('unknown', { game: GAMES[key].name, by });
      bench(key, 'no page'); const nk = nextGame(); if (nk !== key) return open(nk);
    }
    ui = await findUI(page);
    await clickText(ui, /^manual$/i);
    tell('game', { game: GAMES[key].name, by: by || '' });
    await applySettings(key);
  }
  // Autobet run: 100 to 1000 bets (env AUTO_ROUNDS), bet box must stay 0 the whole time.
  // Stops early when chat asks for a game, after AUTO_MAX_MIN minutes, or if anything looks wrong.
  const ROUNDS = String(process.env.AUTO_ROUNDS || '100,200,250,250,300,500').split(',').map(Number).filter(x => x > 0);
  const MAX_MS = Number(process.env.AUTO_MAX_MIN || 25) * 60e3;
  async function autoBatch(g) {
    const n = pick(ROUNDS);
    if (await autoRunning(ui)) { log('auto: a run was still going, stopping it first'); await stopBtn(ui).click({ timeout: 3000 }).catch(() => {}); await sleep(2500); }
    let onAuto = false;
    for (let t = 0; t < 3 && !onAuto; t++) {
      await clickText(ui, /^\s*auto\s*$/i); await sleep(1200);
      onAuto = await autoRunning(ui) || await ui.locator('button:visible').filter({ hasText: /start auto/i }).count().then(c => c > 0).catch(() => false)
        || await ui.locator('input[placeholder="∞"]:visible, input[placeholder*="inf" i]:visible').count().then(c => c > 0).catch(() => false)
        || await ui.locator('button:visible').filter({ hasText: /^\s*start\s*$/i }).count().then(c => c > 0).catch(() => false)
        || await deep(ui).then(() => ui.evaluate(() => window.__deepAll('label,span,div,p').some(e => (e.offsetParent || e.getClientRects().length) && e.children.length <= 2 && /^\s*(number of (bets|rounds)|on win|on loss|stop on (profit|loss))\b/i.test(e.textContent || '')))).catch(() => false);
    }
    if (!onAuto) { log('auto: Auto tab did not open, playing manual'); if (!autoDiagDone) { autoDiagDone = true; await autoDiag(ui); } await clickText(ui, /^\s*manual\s*$/i); return false; }
    if (!(await zeroBet(ui))) { log('auto: bet box not 0, skipping'); await clickText(ui, /^manual$/i); return false; }
    if (g.prep) await g.prep(ui);
    if (g.autoPrep) await g.autoPrep(ui);
    let set = await setByLabel(ui, /number of (bets|rounds|plays)|no\.? of bets|bets? count|total bets|^\s*(bets|rounds)\s*$/i, n);
    if (!set) {                                                             // unlabeled bets box (placeholder "∞")
      const inf = ui.locator('input[placeholder="∞"]:visible, input[placeholder*="inf" i]:visible').first();
      if (await inf.count().catch(() => 0)) { await inf.fill(String(n), { timeout: 3000 }).catch(() => {}); set = await inf.inputValue().catch(() => null); }
    }
    if (!set && !autoDiagDone) { autoDiagDone = true; await autoDiag(ui); }
    if (!set || set === '0' || /∞|inf/i.test(set) || Number(set) !== n) { log('auto: could not set number of bets (', set, '), skipping'); await clickText(ui, /^manual$/i); return false; }
    if (!(await zeroBet(ui))) { await clickText(ui, /^manual$/i); return false; }
    const start = ui.locator('button:visible').filter({ hasText: /^\s*(start autobet|start auto|start)\s*$/i }).first();
    if (!(await start.isVisible().catch(() => false)) || !(await start.isEnabled().catch(() => false))) { log('auto: no Start Autobet button'); await clickText(ui, /^manual$/i); return false; }
    let got = 0, wins = 0, best = 0, lastRes = Date.now();
    onAutoResult = res => {
      got++; rounds++; lastRes = Date.now(); if (res.win) wins++; if (res.mult > best) best = res.mult;
      tell('round', { game: g.name, win: res.win ? 1 : 0, mult: res.mult, auto: 1 });
    };
    tell('auto', { game: g.name, n });
    log(`auto: ${n} bets on ${g.name} at 0`);
    await start.click({ timeout: 3000 });
    await sleep(3000);
    const t0 = Date.now(); let why = 'done', lastQ = 0, lastLog = Date.now(); let speedCheck = null, lastView = 0;
    while (Date.now() - t0 < Math.min(n * 4000 + 30000, MAX_MS)) {
      await sleep(1000);
      if (Date.now() - lastView > 10e3) { lastView = Date.now(); const kv = await keepInView(ui); if (kv && kv !== 'ok') log('view: game was off screen, scrolled back', kv); }
      const v = await readBet(ui);
      if (v !== null && v !== '' && parseFloat(v) !== 0) { log('auto: BET BOX NOT 0, stopping now'); why = 'safety'; break; }
      if (shared.blocked) { why = 'blocked'; break; }
      if (got >= n) break;
      if (await autoRunning(ui)) shared.lastRound = Date.now();          // visibly running = alive (even if results can't be read)
      // finished: no results for a while and no stop button
      if (Date.now() - lastRes > 10e3 && !(await autoRunning(ui))) break;
      if (Date.now() - lastLog > 60e3) { lastLog = Date.now(); log(`auto: ${got}/${n} on ${g.name}`); }
      // slow game? try the speed gauge once: keep it only if bets really get faster, else switch it back
      if (process.env.TURBO === '1' && !speed[g.name] && got >= 8 && Date.now() - t0 > 40e3) {
        const before = got / ((Date.now() - t0) / 60e3);
        if (before < 80) {
          const how = await speedBtn(ui);
          if (!how) speed[g.name] = 'none';
          else {
            speed[g.name] = 'testing'; const g0 = got, s0 = Date.now();
            await ui.locator('[data-hubie-speed="1"]').first().click({ timeout: 2000 }).catch(() => {}); await keepInView(ui);
            await sleep(800);
            const fastOpt = ui.locator('button:visible,[role=menuitem]:visible,[role=option]:visible').filter({ hasText: /^\s*(turbo|fastest|instant|fast|3x|x3)\s*$/i }).first();
            if (await fastOpt.isVisible().catch(() => false)) await fastOpt.click({ timeout: 2000 }).catch(() => {});
            await sleep(400); if (await ui.locator('[role=dialog]:visible,[role=menu]:visible').count().catch(() => 0)) await ui.keyboard.press('Escape').catch(() => {});
            speedCheck = { g0, s0, before, how };
          }
        } else speed[g.name] = 'fast enough';
      }
      if (speedCheck && Date.now() - speedCheck.s0 > 45e3) {
        const after = (got - speedCheck.g0) / ((Date.now() - speedCheck.s0) / 60e3);
        if (after > speedCheck.before * 1.25) { speed[g.name] = 'on'; log(`auto: speed button on for ${g.name} (${Math.round(speedCheck.before)} -> ${Math.round(after)} bets/min)`); }
        else {
          speed[g.name] = 'no gain';
          if (await speedBtn(ui)) { await ui.locator('[data-hubie-speed="1"]').first().click({ timeout: 2000 }).catch(() => {}); await keepInView(ui); await sleep(500); if (await ui.locator('[role=dialog]:visible,[role=menu]:visible').count().catch(() => 0)) await ui.keyboard.press('Escape').catch(() => {}); }
          log(`auto: speed button made no difference on ${g.name} (${Math.round(speedCheck.before)} -> ${Math.round(after)}/min), switched it back`);
        }
        speedCheck = null;
      }
    }
    if (Date.now() - t0 >= MAX_MS) why = 'time';
    if (speedCheck) {                                   // run ended mid speed-test: put the gauge back, try again next run (max 2 tries)
      if (await speedBtn(ui)) await ui.locator('[data-hubie-speed="1"]').first().click({ timeout: 2000 }).catch(() => {}); await keepInView(ui);
      speedTries[g.name] = (speedTries[g.name] || 0) + 1; speed[g.name] = speedTries[g.name] >= 2 ? 'unsure' : undefined; speedCheck = null;
    }
    for (let k = 0; k < 3 && await autoRunning(ui); k++) { await stopBtn(ui).click({ timeout: 3000 }).catch(() => {}); await sleep(1500); }
    onAutoResult = null;
    log(`auto: ${got} bets on ${g.name}, ${wins} wins, best ${best}x (${why})`);
    tell('autoend', { game: g.name, n: got, wins, best: Math.round(best * 100) / 100, why });
    await sleep(1500); await clickText(ui, /^manual$/i);
    if (why !== 'request') until = Math.min(until, Date.now() + 60e3);   // after a long run, change game soon
    return got > 0;
  }

  (async () => {
    log('on: playing House Originals at bet 0');
    current = '';
    await findGames().catch(e => log('findGames', e.message));
    { const keep = chal; chal = {}; current = 'dice'; const first = GAMES[process.env.START_GAME] ? process.env.START_GAME : nextGame(); current = ''; await open(first); chal = keep; }   // start on a random original (or START_GAME)
    for (;;) {
      await sleep(rand(4000, 7000));
      { const v = await keepInView(ui); if (v && v !== 'ok') log('view: game was off screen, scrolled back', v); }
      if (shared.blocked || shared.lounge || shared.loggedOut || shared.loggingIn) { shared.lastRound = Date.now(); continue; }
      // stall watchdog: no round for 12 min -> reopen the game; 25 min -> restart the game bot
      const idle = Date.now() - (shared.lastRound || Date.now());
      if (idle > 25 * 60e3) { log('watchdog: no rounds for 25 min, restarting the game bot'); process.exit(3); }
      if (idle > 12 * 60e3 && !shared.reopened) { shared.reopened = true; log('watchdog: no rounds for 12 min, reopening the game'); await open(nextGame()); continue; }
      if (idle < 60e3) shared.reopened = false;
      try {
        // chat request first, then rotation
        const canSwitch = Date.now() - openedAt > 3 * 60e3 || justRan;
        justRan = false;
        const q = !canSwitch ? null : await fetch(`${BRAIN}/queue`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
        const want = q && resolve(q.game);
        if (q && q.game && !want) {                                    // not an original: try it as a slot (Fun mode)
          if (process.env.SLOTS === '1') { await slots.play(q.game, q.by); await open(nextGame()); }
          else tell('unknown', { game: q.game, by: q.by || '' });
          continue;
        }
        if (want) { await open(want, q.by); continue; }
        if (process.env.SLOTS === '1' && Date.now() > nextSlotBreak) {  // now and then, a slot break from Hubie's list
          nextSlotBreak = Date.now() + rand(80, 110) * 60e3;
          await slots.play(slots.favourite()); await open(nextGame()); continue;
        }
        await getChal();
        if (chal.game && current !== chal.game && until - Date.now() > 3 * 60e3 && Date.now() - openedAt > 4 * 60e3) until = Date.now();   // a new mission came up: go for it soon
        if (current === chal.game && Date.now() > until - 60e3 && Date.now() - openedAt < 25 * 60e3) until = Date.now() + 2 * 60e3;   // still chasing: keep going
        if (Date.now() > until) { await open(nextGame()); continue; }
        if (!/\/games\//.test(page.url())) { await open(current); continue; }

        const g = GAMES[current];
        if (await autoRunning(ui)) { await stopBtn(ui).click({ timeout: 3000 }).catch(() => {}); await sleep(2000); continue; }
        if (g.bj && (await anyVisible(ui, /^\s*(hit|stand)\s*$/i)) && !(await playButton(ui, g.button))) { log('finishing a blackjack hand'); await playBlackjack(ui, tell); continue; }
        if (g.steps && g.steps.cash && typeof g.steps.step !== 'string' && (await anyVisible(ui, g.steps.cash)) && !(await playButton(ui, g.button))) {   // a round left open: one step, then cash out
          openTries = (openTries || 0) + 1; log('finishing an open round on', g.name, `(try ${openTries})`);
          if (openTries > 3) {
            openTries = 0; stuckReloads[current] = (stuckReloads[current] || 0) + 1;
            if (stuckReloads[current] > 2) { log('open round still stuck on', g.name, 'after 2 reloads: moving on'); stuckReloads[current] = 0; bench(current, 'stuck round'); await open(nextGame()); continue; }
            log('open round stuck: reloading the game'); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(5000); ui = await findUI(page); continue;
          }
          await runSteps(ui, g.steps, 1); continue;
        }
        if (await page.getByRole('button', { name: /^log ?in$/i }).first().isVisible().catch(() => false)) { if (++fails % 10 === 1) log('not logged in: waiting'); continue; }
        if (!(await zeroBet(ui))) {
          fails++;
          if (fails === 2) ui = await findUI(page);                    // maybe the game is in an embedded frame
          if (fails === 4 && !diagDone[current]) { diagDone[current] = 1; log('bet box not found on', g.name, '- details below'); await diag(page); }
          if (fails >= 8) {                                             // give up on this game for a while, quietly
            log('bet box not confirmed at 0 on', g.name, '- moving on');
            if (current !== 'dice') { bench(current, 'bet box'); await open(nextGame()); }
            else { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(5000); ui = await findUI(page); fails = 0; await sleep(20000); }
          }
          continue;
        }
        await setTarget(current);
        if (g.auto && !noAuto[current] && !(chal.game === current && chal.kind === 'steps') && process.env.AUTOBET !== '0' && Math.random() < Number(process.env.AUTOBET_SHARE || 0.85)) {
          const ok = await autoBatch(g); fails = 0;
          if (ok) { autoMiss[current] = 0; justRan = true; continue; }
          if (++autoMiss[current] >= 3) { noAuto[current] = 1; log('autobet not working on', g.name, '- playing manual there'); }
        }
        if (g.prep) await g.prep(ui);
        if (!(await zeroBet(ui))) continue;                         // check again right before the click
        const b = await playButton(ui, g.button);
        if (!b) { if (await anyVisible(ui, /^\s*(hit|stand|cash ?out|random( tile| pick)?|higher|lower|waiting|starting)\b/i)) {
            waitTries++;
            if (g.steps && g.steps.step === 'safer' && waitTries <= 3) { await runSteps(ui, g.steps, 1); continue; }   // Hilo round left open
            if (waitTries > 12) {
              waitTries = 0; stuckReloads[current] = (stuckReloads[current] || 0) + 1;
              if (stuckReloads[current] > 2) { log('round still stuck on', g.name, 'after 2 reloads: moving on'); stuckReloads[current] = 0; bench(current, 'stuck round'); await open(nextGame()); continue; }
              log('round stuck on', g.name, ': reloading'); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(5000); ui = await findUI(page);
            }
            await sleep(2000); continue; }
          if (++fails >= 5) { log('no play button on', g.name); bench(current, 'no play button'); await open(nextGame()); } continue; }
        let stepInfo = null;
        const t0 = Date.now(); await b.click({ timeout: 3000 });
        if (g.bj) await playBlackjack(ui, tell);
        if (g.crash) { await sleep(4000); for (let w = 0; w < 60 && !(await playButton(ui, g.button)); w++) await sleep(1000); }
        if (g.steps) {                                                  // steps go up after a win, down after a bust
          const st = g.steps; level[current] = level[current] || Math.round((st.min + st.max) / 2);
          const cap = st.cap || st.max, spread = pick([-2, -1, -1, 0, 0, 0, 1, 1, 2, 3]);
          const goal = chal.game === current && chal.kind === 'steps' ? Number(chal.target) : Math.max(st.min, Math.min(cap, level[current] + spread));
          const r = await runSteps(ui, st, goal);
          stepInfo = { steps: r.done, survived: r.survived ? 1 : 0 };
          if (r.survived === true) level[current] = Math.min(st.cap || st.max, level[current] + 1);
          else if (r.survived === false) level[current] = Math.max(st.min, level[current] - 1);
          if (r.survived && r.done > (bestLevel[current] || 0)) { bestLevel[current] = r.done; if (r.done >= 3) tell('steps', { game: g.name, steps: r.done }); }
        }
        fails = 0; rounds++; openTries = 0; waitTries = 0; stuckReloads[current] = 0;
        await sleep(2500);
        const res = lastJson && lastJson.at >= t0 ? lastJson : null;
        tell('round', { game: g.name, win: res ? (res.win ? 1 : 0) : '', mult: res ? res.mult : '', ...(stepInfo || {}) }); stepInfo = null;
      } catch (e) { log('round error', e.message); await sleep(3000); }
    }
  })();
};
module.exports.GAMES = GAMES;
module.exports.resolve = resolve;
module.exports.turbo = turbo; module.exports.speedBtn = speedBtn; module.exports.keepInView = keepInView;
