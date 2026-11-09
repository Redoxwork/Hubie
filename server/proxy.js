// Tiny local relay for the game Chrome: listens on 127.0.0.1:8899 and forwards
// everything to the residential proxy in HUBIE_PROXY (http://user:pass@host:port),
// adding the login Chrome can't send by itself. Only the Housebets window uses it.
const http = require('http');
const net = require('net');

const PORT = Number(process.env.HUBIE_PROXY_PORT || 8899);
const raw = process.env.HUBIE_PROXY || '';
if (!raw) { console.error('[proxy] HUBIE_PROXY not set'); process.exit(1); }
const up = new URL(raw.includes('://') ? raw : 'http://' + raw);
const AUTH = up.username
  ? 'Basic ' + Buffer.from(decodeURIComponent(up.username) + ':' + decodeURIComponent(up.password)).toString('base64')
  : null;
const UP_HOST = up.hostname, UP_PORT = Number(up.port || 80);
const log = (...a) => console.log('[proxy]', ...a);
// Only these sites go through the paid proxy; everything else (slot CDNs, images
// from game providers) goes straight out from the server to save proxy data.
const ONLY = (process.env.HUBIE_PROXY_ONLY || 'all') === 'all' ? [] : process.env.HUBIE_PROXY_ONLY.split(',').map(s => s.trim()).filter(Boolean);   // default: everything through the proxy
const viaProxy = host => !ONLY.length || ONLY.some(d => host === d || host.endsWith('.' + d));
let usedUp = 0, usedDirect = 0;
const count = (sock, viaUp) => sock.on('data', d => { if (viaUp) usedUp += d.length; else usedDirect += d.length; });
setInterval(() => log(`data last 10 min: proxy ${(usedUp / 1048576).toFixed(1)} MB, direct ${(usedDirect / 1048576).toFixed(1)} MB`, (usedUp = usedDirect = 0, '')), 600000);

const server = http.createServer((req, res) => {          // plain http:// requests
  const headers = { ...req.headers };
  if (AUTH) headers['proxy-authorization'] = AUTH;
  let host = ''; try { host = new URL(req.url).hostname; } catch {}
  const direct = !viaProxy(host);
  if (direct) delete headers['proxy-authorization'];
  const opts = direct ? (() => { const u = new URL(req.url); return { host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers }; })()
                      : { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers };
  const fwd = http.request(opts, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  fwd.on('error', e => { log('http error', e.message); res.writeHead(502); res.end(); });
  req.pipe(fwd);
});

server.on('connect', (req, client, head) => {            // https:// tunnels
  const [host, port] = req.url.split(':');
  if (!viaProxy(host)) {                                  // straight out, no proxy data used
    const d = net.connect(Number(port || 443), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) d.write(head);
      count(d, false); d.pipe(client); client.pipe(d);
    });
    d.on('error', () => { client.destroy(); }); client.on('error', () => d.destroy());
    return;
  }
  const s = net.connect(UP_PORT, UP_HOST, () => {
    s.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n` +
      (AUTH ? `Proxy-Authorization: ${AUTH}\r\n` : '') + '\r\n');
  });
  let buf = Buffer.alloc(0), ok = false;
  s.on('data', function first(chunk) {
    if (ok) return;
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const status = buf.slice(0, buf.indexOf('\r\n')).toString();
    if (!/ 200 /.test(status)) { log('upstream refused', req.url, status); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); s.destroy(); return; }
    ok = true; s.removeListener('data', first);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const rest = buf.slice(end + 4);
    if (rest.length) client.write(rest);
    if (head && head.length) s.write(head);
    count(s, true); s.pipe(client); client.pipe(s);
  });
  const kill = () => { s.destroy(); client.destroy(); };
  s.on('error', e => { log('tunnel error', req.url, e.message); kill(); });
  client.on('error', kill);
  s.setTimeout(60000, () => { if (!ok) { log('upstream timeout', req.url); kill(); } });
});

server.listen(PORT, '127.0.0.1', () => log(`relay on 127.0.0.1:${PORT} -> ${UP_HOST}:${UP_PORT}`));
