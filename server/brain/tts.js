// Kokoro voice: one long-running Python worker so the model loads once. speak(text) -> {file, dur} or null.
'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');

module.exports = ({ H, DATA, log }) => {
  const py = path.join(H, 'tts/venv/bin/python'), dir = path.join(H, 'tts'), out = path.join(DATA, 'tts');
  fs.mkdirSync(out, { recursive: true });
  const ok = fs.existsSync(py) && fs.existsSync(path.join(dir, 'kokoro-v1.0.onnx'));
  if (!ok) log('tts: Kokoro not installed (run: hubie voices). Hubie shows captions without a voice.');
  let proc, buf = '', n = Date.now() % 100000;
  const waiting = new Map();

  function start() {
    proc = spawn(py, [path.join(__dirname, 'tts_worker.py'), dir, out], { stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { log('tts: Kokoro ready'); continue; }
        const w = waiting.get(m.id); if (!w) continue; waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m);
      }
    });
    proc.on('exit', c => {
      log('tts: worker exited', c, '- restarting');
      for (const w of waiting.values()) w.reject(new Error('tts worker died'));
      waiting.clear(); setTimeout(start, 3000);
    });
  }
  if (ok) start();

  // delete old audio files
  setInterval(() => {
    for (const f of fs.readdirSync(out)) {
      const p = path.join(out, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60e3) fs.unlinkSync(p); } catch {}
    }
  }, 5 * 60e3);

  function speak(text) {
    if (!ok || !proc) return Promise.resolve(null);
    const id = ++n;
    proc.stdin.write(JSON.stringify({ id, text, voice: process.env.HUBIE_VOICE || 'am_puck',
      speed: Number(process.env.HUBIE_SPEED) || 1.05 }) + '\n');
    return Promise.race([
      new Promise((resolve, reject) => waiting.set(id, { resolve, reject })),
      new Promise((_, reject) => setTimeout(() => { waiting.delete(id); reject(new Error('tts timeout')); }, 25000)),
    ]).catch(e => { log('tts:', e.message); return null; });
  }
  return { ok, speak };
};
