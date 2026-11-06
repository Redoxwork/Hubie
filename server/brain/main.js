// Hubie's brain: one small web server on 127.0.0.1:8090.
//   /avatar/*      the avatar page (the stream's Chrome opens it from here)
//   /tts/*         Hubie's voice clips
//   /ws            avatar control (speak, react)
//   /kick/*        Kick login + webhooks (the only part reachable from the internet, via Caddy HTTPS)
//   /health, /test/say, /test/chat   local checks
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');

const H = process.env.HUBIE_DIR || '/opt/hubie';
const DATA = path.join(H, 'data');
const PORT = Number(process.env.BRAIN_PORT) || 8090;
fs.mkdirSync(path.join(DATA, 'tts'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function publicHost() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return `${a.address.replace(/\./g, '-')}.sslip.io`;
  return 'localhost';
}

// ---- avatar connections ----
const sockets = new Set();
const avatar = {
  send: m => { const s = JSON.stringify(m); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); },
  connected: () => sockets.size > 0,
};

const kick = require('./kick')({ DATA, log, host: publicHost() });
const tts = require('./tts')({ H, DATA, log });
const llm = require('./llm')({ log });
const director = require('./director')({ H, DATA, log, kick, tts, llm, avatar });

log(`brain: AI ${llm.enabled ? llm.model : 'OFF (no GEMINI_API_KEY, using fallback lines)'} · voice ${tts.ok ? 'Kokoro' : 'OFF'} · Kick ${kick.ready() ? 'logged in' : 'not logged in'} · webhook https://${publicHost()}/kick/webhook`);

// ---- web server ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
function serveFile(res, base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store',
    'access-control-allow-origin': '*' });
  fs.createReadStream(p).pipe(res);
}
const page = (res, code, title, msg) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#0b1418;color:#e6f4f5;font:18px system-ui;padding:24px"><h2>${title}</h2><p>${msg}</p>`);
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const local = !req.headers['x-forwarded-for'];          // Caddy adds this for internet traffic

  if (u.pathname === '/kick/webhook' && req.method === 'POST') {
    let raw = ''; req.on('data', d => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      res.writeHead(200); res.end('ok');
      if (!(await kick.verify(req.headers, raw))) return log('kick: webhook signature check failed (ignored)');
      let e; try { e = JSON.parse(raw); } catch { return; }
      const type = req.headers['kick-event-type'];
      if (type === 'chat.message.sent') director.onChat({ id: e.message_id, userId: e.sender?.user_id, name: e.sender?.username, text: e.content,
        replyTo: e.replies_to?.sender?.username || e.reply_to?.sender?.username || e.replied_to?.sender?.username || null });
      else if (type === 'channel.followed') director.onFollow(e.follower?.username);
      else if (type === 'channel.subscription.new' || type === 'channel.subscription.renewal') director.onSub(e.subscriber?.username, 'sub');
      else if (type === 'channel.subscription.gifts') director.onSub(e.gifter?.username || 'someone', `gifted ${(e.giftees || []).length}`);
      else log('kick: event', type);
    });
    return;
  }
  if (u.pathname === '/kick/login') {
    const to = kick.loginUrl(u.searchParams.get('k'));
    if (!to) return page(res, 403, 'Link expired', 'Run <b>hubie kick-login</b> on the server for a fresh link (and check the Kick Client ID is saved).');
    res.writeHead(302, { location: to }); return res.end();
  }
  if (u.pathname === '/kick/callback') {
    const err = u.searchParams.get('error');
    if (err) return page(res, 400, 'Kick login cancelled', err);
    kick.callback(u.searchParams.get('code'), u.searchParams.get('state'))
      .then(me => page(res, 200, '✅ Hubie is connected to Kick', `Logged in as <b>${me.name}</b>. Chat and follower events are on. You can close this page.`))
      .catch(e => { log('kick: login failed', e.message); page(res, 500, 'Kick login failed', String(e.message).replace(/</g, '&lt;')); });
    return;
  }
  if (!local) { res.writeHead(404); return res.end(); }

  if (u.pathname.startsWith('/avatar/')) return serveFile(res, path.join(H, 'avatar'), u.pathname.slice(8));
  if (u.pathname.startsWith('/tts/')) return serveFile(res, path.join(DATA, 'tts'), u.pathname.slice(5));
  if (u.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, avatar: sockets.size, ai: llm.enabled, voice: tts.ok, kick: kick.me(), ...director.status() }));
  }
  if (u.pathname === '/test/chat') {   // pretend a viewer typed something
    director.onChat({ id: 't' + Date.now(), userId: 'test', name: u.searchParams.get('name') || 'tester', text: u.searchParams.get('text') || 'hi hubie', replyTo: u.searchParams.get('to') });
    res.writeHead(200); return res.end('ok');
  }
  if (u.pathname === '/info') {
    kick.setInfo(u.searchParams.get('title'), u.searchParams.get('category'))
      .then(b => { res.writeHead(200); res.end('ok ' + JSON.stringify(b)); })
      .catch(e => { res.writeHead(500); res.end(e.message); });
    return;
  }
  if (u.pathname === '/event') { director.onGameEvent(u.searchParams.get('type'), Object.fromEntries(u.searchParams)); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/challenge') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(director.challenge())); }
  if (u.pathname === '/queue/size') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ n: director.queueSize() })); }
  if (u.pathname === '/bonus/take') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ go: director.takeBonus() })); }
  if (u.pathname === '/queue') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(director.takeQueue())); }
  if (u.pathname === '/state') { director.setGame(u.searchParams.get('game') || ''); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/session/new') { director.newSession(); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/test/game') { director.startGame(u.searchParams.get('kind')); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/test/follow') { director.onFollow(u.searchParams.get('name') || 'tester'); res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (req.url !== '/ws' || req.headers['x-forwarded-for']) return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => {
    sockets.add(ws); log('avatar: connected');
    ws.on('message', d => { try { director.onAvatar(JSON.parse(d)); } catch {} });
    ws.on('close', () => { sockets.delete(ws); log('avatar: disconnected'); });
  });
});
server.listen(PORT, '127.0.0.1', () => log(`brain: listening on 127.0.0.1:${PORT}`));

process.on('uncaughtException', e => log('uncaught:', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled:', e?.message || e));
