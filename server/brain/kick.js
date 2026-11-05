// Kick official API: OAuth login (PKCE), token refresh, chat, moderation, event subscriptions, webhook verification.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ID = 'https://id.kick.com', API = 'https://api.kick.com/public/v1';
const SCOPES = 'user:read channel:read chat:write events:subscribe moderation:ban';
const EVENTS = ['chat.message.sent', 'channel.followed', 'channel.subscription.new',
  'channel.subscription.renewal', 'channel.subscription.gifts'];
const b64 = buf => Buffer.from(buf).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest();

module.exports = ({ DATA, log, host }) => {
  const TOK = path.join(DATA, 'kick-tokens.json');
  const redirect = `https://${host}/kick/callback`;
  const cid = () => process.env.KICK_CLIENT_ID, secret = () => process.env.KICK_CLIENT_SECRET;
  let tok = null; try { tok = JSON.parse(fs.readFileSync(TOK, 'utf8')); } catch {}
  const pending = new Map();
  let pubKey = null;

  // one-time-ish token so only you can start the Kick login (shown by: hubie kick-login)
  const loginToken = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(path.join(DATA, 'login-token'), loginToken, { mode: 0o600 });

  function loginUrl(k) {
    if (k !== loginToken || !cid()) return null;
    const verifier = b64(crypto.randomBytes(32)), state = b64(crypto.randomBytes(12));
    pending.set(state, verifier); setTimeout(() => pending.delete(state), 15 * 60e3);
    const q = new URLSearchParams({ response_type: 'code', client_id: cid(), redirect_uri: redirect, scope: SCOPES,
      code_challenge: b64(sha256(verifier)), code_challenge_method: 'S256', state });
    return `${ID}/oauth/authorize?${q}`;
  }

  async function tokenReq(form) {
    const r = await fetch(`${ID}/oauth/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`token ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  function save(t) {
    tok = { access: t.access_token, refresh: t.refresh_token || tok?.refresh,
      exp: Date.now() + (t.expires_in || t.expiry || 3600) * 1000, user: tok?.user || null };
    fs.writeFileSync(TOK, JSON.stringify(tok), { mode: 0o600 });
  }
  async function refresh() {
    save(await tokenReq({ grant_type: 'refresh_token', client_id: cid(), client_secret: secret(), refresh_token: tok.refresh }));
    log('kick: token refreshed');
  }
  async function access() {
    if (!tok) return null;
    if (Date.now() > tok.exp - 10 * 60e3) { try { await refresh(); } catch (e) { log('kick: refresh failed:', e.message); } }
    return tok.access;
  }
  async function api(method, p, body) {
    for (let i = 0; i < 2; i++) {
      const a = await access(); if (!a) throw new Error('not logged in to Kick (run: hubie kick-login)');
      const r = await fetch(API + p, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${a}`, 'content-type': 'application/json', accept: 'application/json' } });
      if (r.status === 401 && i === 0) { tok.exp = 0; continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return j;
    }
  }

  async function whoami() {
    const j = await api('GET', '/users');
    const u = (j.data || [])[0] || {};
    tok.user = { id: u.user_id, name: u.name }; fs.writeFileSync(TOK, JSON.stringify(tok), { mode: 0o600 });
    log(`kick: logged in as ${u.name} (${u.user_id})`);
    return tok.user;
  }
  async function subscribe() {
    const have = new Set(((await api('GET', '/events/subscriptions')).data || []).map(s => s.event || s.name));
    const missing = EVENTS.filter(e => !have.has(e));
    if (missing.length) {
      await api('POST', '/events/subscriptions', { broadcaster_user_id: tok.user.id, method: 'webhook',
        events: missing.map(name => ({ name, version: 1 })) });
      log('kick: subscribed to', missing.join(', '));
    } else log('kick: event subscriptions ok');
  }
  async function callback(code, state) {
    const v = pending.get(state); if (!v) throw new Error('login link expired, run: hubie kick-login again');
    pending.delete(state);
    save(await tokenReq({ grant_type: 'authorization_code', client_id: cid(), client_secret: secret(),
      redirect_uri: redirect, code_verifier: v, code }));
    await whoami(); await subscribe();
    return tok.user;
  }

  async function verify(h, raw) {
    if (process.env.KICK_VERIFY === '0') return true;
    try {
      if (!pubKey) pubKey = (await (await fetch(API + '/public-key')).json()).data?.public_key;
      const id = h['kick-event-message-id'], ts = h['kick-event-message-timestamp'], sig = h['kick-event-signature'];
      if (!pubKey || !id || !ts || !sig) return false;
      return crypto.verify('sha256', Buffer.from(`${id}.${ts}.${raw}`), pubKey, Buffer.from(sig, 'base64'));
    } catch (e) { log('kick: verify error', e.message); return false; }
  }

  const chat = content => api('POST', '/chat', { broadcaster_user_id: tok.user.id, type: 'user', content: String(content).slice(0, 480) });
  const timeout = (userId, minutes, reason) => api('POST', '/moderation/bans',
    { broadcaster_user_id: tok.user.id, user_id: userId, duration: minutes, reason });

  // start-up: keep tokens fresh and subscriptions in place, all on their own
  async function upkeep() {
    if (!tok || !cid()) return;
    try { if (!tok.user?.id) await whoami(); await subscribe(); } catch (e) { log('kick: upkeep:', e.message); }
  }
  setTimeout(upkeep, 3000);
  setInterval(() => { if (tok) access().catch(() => {}); }, 5 * 60e3);
  setInterval(upkeep, 30 * 60e3);

  return { loginUrl, callback, verify, chat, timeout, me: () => tok?.user || null, ready: () => !!tok?.user?.id, redirect };
};
