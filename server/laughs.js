// Fetch laugh sounds from free sound pages (e.g. Pixabay) and cut them into short clips for Hubie.
//   hubie laugh-clips <page url> [<page url> ...]
// Clips go to /opt/hubie/tts/laughs (on the server only, not in the repo) + a preview page.
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const H = process.env.HUBIE_DIR || '/opt/hubie';
const OUT = path.join(H, 'tts/laughs'), RAW = path.join(OUT, 'raw');
const PREVIEW = path.join(H, 'shots', 'laugh-clips-' + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, ''));
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(PREVIEW, { recursive: true });
const urls = process.argv.slice(2).filter(u => /^https?:\/\//.test(u) || fs.existsSync(u));
// with no arguments: use every sound file uploaded to tts/laughs/raw
if (!urls.length) for (const f of fs.existsSync(RAW) ? fs.readdirSync(RAW) : []) if (/\.(mp3|wav|ogg|m4a)$/i.test(f)) urls.push(path.join(RAW, f));
if (!urls.length) { console.log('usage: hubie laugh-clips <sound page url> ...'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grab(browser, url, i) {
  const page = await browser.newPage();
  let audio = null;
  page.on('response', async r => {
    try {
      const ct = r.headers()['content-type'] || '';
      if (!audio && (/audio\//.test(ct) || /\.(mp3|ogg|wav|m4a)(\?|$)/i.test(r.url())) && r.status() < 300) audio = { url: r.url(), buf: await r.body() };
    } catch {}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('  open failed:', e.message));
  await sleep(4000);
  if (!audio) {                                                  // press the page's play button so the audio loads
    const play = page.locator('button[aria-label*="play" i], [role=button][aria-label*="play" i], button:has(svg)[class*="play" i]').first();
    await play.click({ timeout: 4000 }).catch(() => {});
    await sleep(4000);
  }
  if (!audio) {                                                  // last try: an mp3 address written in the page
    const html = await page.content();
    const m = /https:\/\/cdn\.pixabay\.com\/[^"'\s]+?\.mp3[^"'\s]*/i.exec(html) || /https:\/\/[^"'\s]+?\.mp3/i.exec(html);
    if (m) { const r = await page.request.get(m[0].replace(/&amp;/g, '&')).catch(() => null); if (r && r.ok()) audio = { url: m[0], buf: await r.body() }; }
  }
  await page.close();
  if (!audio) { console.log(`  ${i}: no audio found on ${url}`); return null; }
  const f = path.join(RAW, `src${i}${path.extname(new URL(audio.url).pathname) || '.mp3'}`);
  fs.writeFileSync(f, audio.buf);
  console.log(`  ${i}: got ${Math.round(audio.buf.length / 1024)} KB from ${new URL(audio.url).host}`);
  return f;
}

// cut: trim silence at the start, keep at most `max` seconds, fade out, even loudness
function cut(src, name, max) {
  const out = path.join(OUT, name + '.mp3');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-af',
    `silenceremove=start_periods=1:start_threshold=-40dB,atrim=0:${max},afade=t=out:st=${Math.max(0.2, max - 0.35)}:d=0.35,loudnorm=I=-18:TP=-2,aresample=24000`,
    '-ac', '1', '-b:a', '96k', out]);
  fs.copyFileSync(out, path.join(PREVIEW, name + '.mp3'));
  return name;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const made = [];
  for (let i = 0; i < urls.length; i++) {
    console.log('fetching', urls[i]);
    const src = fs.existsSync(urls[i]) ? urls[i] : await grab(browser, urls[i], i + 1);
    if (!src) continue;
    try { made.push(cut(src, `laugh${i + 1}`, 2.5), cut(src, `chuckle${i + 1}`, 1.2)); } catch (e) { console.log('  cut failed:', e.message.split('\n')[0]); }
  }
  await browser.close();
  fs.writeFileSync(path.join(PREVIEW, 'index.html'), `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Hubie laugh clips</title><style>body{background:#0b1418;color:#e6f4f5;font:15px system-ui;margin:14px}.c{background:#12232a;border:1px solid #234;border-radius:12px;padding:10px;margin:8px 0}audio{width:100%;margin-top:6px}</style>
<h2>Hubie laugh clips</h2><p>Tell Claude which to keep (e.g. laugh1, chuckle3). The rest can be removed.</p>
${made.map(n => `<div class=c><b>${n}</b><br><audio controls preload=none src="${n}.mp3"></audio></div>`).join('')}`);
  console.log(`\n${made.length} clips made. Listen: hubie shots`);
})();
