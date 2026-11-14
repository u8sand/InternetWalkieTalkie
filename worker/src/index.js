// Walkie-Talkie relay as a Cloudflare Worker: the same job as relay/server.mjs, with nothing
// to host. One Durable Object holds every WebSocket (hibernating between messages, so an idle
// relay costs nothing) and keeps mailbox mail in its built-in SQLite database.
//
//  * A Nostr relay limited to the two event kinds the app uses:
//      25050  signalling and relayed messages — forwarded to live subscribers, never stored
//      4050   mailbox mail                    — stored until it expires (at most MAIL_TTL_DAYS)
//    Everything is end-to-end encrypted by the app; the relay sees topics (hashes), sizes
//    and timing, never content, names or keys.
//  * ["TURN", accessCode] → short-lived credentials for Cloudflare's TURN service, minted with
//    the deployer's own TURN key, so the app can carry a connection that can't be made directly.
//
// Unlike relay/server.mjs this does not verify events' Nostr (Schnorr) signatures: that needs a
// curve WebCrypto lacks, and the app never relies on them (they come from throwaway keys; the
// real authentication is the signature inside each encrypted payload). Event ids are checked.

import { DurableObject } from 'cloudflare:workers';

const SIGNAL_KIND = 25050, MAIL_KIND = 4050;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_SUBS = 4, MAX_FILTERS = 20, MAX_TOPICS = 500;
const SQL_PARAMS = 90; // bound parameters per query (the platform allows 100)
const SWEEP_MS = 6 * 3600 * 1000;

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function validShape(ev) {
  return !!ev && typeof ev === 'object'
    && typeof ev.id === 'string' && /^[0-9a-f]{64}$/.test(ev.id)
    && typeof ev.pubkey === 'string' && /^[0-9a-f]{64}$/.test(ev.pubkey)
    && typeof ev.sig === 'string' && /^[0-9a-f]{128}$/.test(ev.sig)
    && Number.isSafeInteger(ev.created_at) && Number.isSafeInteger(ev.kind)
    && typeof ev.content === 'string'
    && Array.isArray(ev.tags) && ev.tags.length <= 8
    && ev.tags.every((t) => Array.isArray(t) && t.length >= 2 && t.length <= 4 && t.every((x) => typeof x === 'string' && x.length <= 128));
}

function cleanFilters(list) {
  const out = [];
  for (const f of list.slice(0, MAX_FILTERS)) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const g = {};
    if (Array.isArray(f.kinds)) g.kinds = f.kinds.filter(Number.isSafeInteger).slice(0, 8);
    if (Number.isSafeInteger(f.since)) g.since = f.since;
    if (Number.isSafeInteger(f.until)) g.until = f.until;
    const t = Array.isArray(f['#t']) ? f['#t'].filter((x) => typeof x === 'string' && x.length <= 128).slice(0, MAX_TOPICS) : [];
    // The app always asks by topic. Refusing topic-less filters means nobody can list what's here.
    if (t.length) { g.t = t; out.push(g); }
  }
  return out;
}

const matches = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind))
  && (f.since === undefined || ev.created_at >= f.since)
  && (f.until === undefined || ev.created_at <= f.until)
  && ev.tags.some((t) => t[0] === 't' && f.tset.has(t[1]));

const withSets = (filters) => filters.map((f) => ({ ...f, tset: new Set(f.t) }));

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

export default {
  async fetch(request, env) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
    }
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    const name = env.RELAY_NAME || 'Walkie-Talkie relay';
    if ((request.headers.get('Accept') || '').includes('application/nostr+json')) {
      return Response.json({
        name,
        description: 'Carries end-to-end encrypted Walkie-Talkie signalling and mailbox events only.',
        software: 'https://github.com/u8sand/InternetWalkieTalkie',
        supported_nips: [1, 11, 40],
        limitation: { max_message_length: MAX_EVENT_BYTES, max_subscriptions: MAX_SUBS, max_filters: MAX_FILTERS },
      }, { headers: { ...headers, 'content-type': 'application/nostr+json' } });
    }
    const host = new URL(request.url).host;
    return new Response(`${name}\n\nThis is a relay for the Walkie-Talkie messenger. Add this address in the app:\nSettings → My relay → wss://${host}\n`,
      { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  },
};

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.cfg = {
      mailTtlS: num(env.MAIL_TTL_DAYS, 8) * 86400,
      maxStoredBytes: num(env.MAX_STORED_MB, 100) * 1024 * 1024,
      maxConnections: num(env.MAX_CONNECTIONS, 500),
      ratePerSec: num(env.RATE_PER_SEC, 20), rateBurst: num(env.RATE_BURST, 100),
      turnTtlS: num(env.TURN_TTL_HOURS, 12) * 3600,
    };
    this.sql.exec('CREATE TABLE IF NOT EXISTS mail (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires INTEGER NOT NULL, bytes INTEGER NOT NULL, json TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS mail_topic (topic TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (topic, id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (ws TEXT NOT NULL, sub TEXT NOT NULL, filters TEXT NOT NULL, PRIMARY KEY (ws, sub))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    // Subscriptions live in SQLite (they are too large for a socket attachment) and are
    // cached here; the cache is rebuilt whenever the object wakes from hibernation.
    this.subs = null;       // ws id -> Map<sub id, filters>
    this.rate = new Map();  // ws id -> {tokens, at}
  }

  now() { return Math.floor(Date.now() / 1000); }

  async fetch(request) {
    if (this.ctx.getWebSockets().length >= this.cfg.maxConnections) return new Response('relay is full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID() });
    return new Response(null, { status: 101, webSocket: client });
  }

  idOf(ws) { return ws.deserializeAttachment()?.id; }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  /** Subscriptions of every live socket; rows left by sockets that are gone are dropped. */
  allSubs() {
    if (this.subs) return this.subs;
    const live = new Set(this.ctx.getWebSockets().map((ws) => this.idOf(ws)));
    this.subs = new Map();
    const dead = new Set();
    for (const row of this.sql.exec('SELECT ws, sub, filters FROM subs').toArray()) {
      if (!live.has(row.ws)) { dead.add(row.ws); continue; }
      let m = this.subs.get(row.ws);
      if (!m) { m = new Map(); this.subs.set(row.ws, m); }
      try { m.set(row.sub, withSets(JSON.parse(row.filters))); } catch {}
    }
    for (const id of dead) this.sql.exec('DELETE FROM subs WHERE ws = ?', id);
    return this.subs;
  }

  allowed(id) {
    const t = Date.now();
    let r = this.rate.get(id);
    if (!r) { r = { tokens: this.cfg.rateBurst, at: t }; this.rate.set(id, r); }
    r.tokens = Math.min(this.cfg.rateBurst, r.tokens + (t - r.at) / 1000 * this.cfg.ratePerSec);
    r.at = t;
    if (r.tokens < 1) return false;
    r.tokens -= 1;
    return true;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_EVENT_BYTES) return;
    const id = this.idOf(ws);
    if (!id) return;
    if (!this.allowed(id)) return this.send(ws, ['NOTICE', 'rate-limited: slow down']);
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg)) return;

    if (msg[0] === 'EVENT') return this.onEvent(ws, msg[1]);
    if (msg[0] === 'REQ' && typeof msg[1] === 'string' && msg[1].length <= 64) return this.onReq(ws, id, msg[1], msg.slice(2));
    if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
      this.allSubs().get(id)?.delete(msg[1]);
      this.sql.exec('DELETE FROM subs WHERE ws = ? AND sub = ?', id, msg[1]);
      return;
    }
    if (msg[0] === 'TURN') return this.onTurn(ws, msg[1]);
  }

  async onEvent(ws, ev) {
    const bad = await this.check(ev);
    if (bad) return this.send(ws, ['OK', typeof ev?.id === 'string' ? ev.id.slice(0, 64) : '', false, bad]);
    this.send(ws, ['OK', ev.id, true, '']);
    if (ev.kind === MAIL_KIND && !(await this.keep(ev))) return; // already had it
    const line = JSON.stringify(ev);
    const subs = this.allSubs();
    for (const other of this.ctx.getWebSockets()) {
      const mine = subs.get(this.idOf(other));
      if (!mine) continue;
      for (const [sid, filters] of mine) {
        if (filters.some((f) => matches(f, ev))) { try { other.send(`["EVENT",${JSON.stringify(sid)},${line}]`); } catch {} break; }
      }
    }
  }

  /** Returns null if the event is acceptable, else the reason it isn't. */
  async check(ev) {
    if (!validShape(ev)) return 'invalid: malformed event';
    if (ev.kind !== SIGNAL_KIND && ev.kind !== MAIL_KIND) return 'blocked: this relay only carries Walkie-Talkie events';
    if (!ev.tags.some((t) => t[0] === 't')) return 'invalid: no topic';
    if (Math.abs(ev.created_at - this.now()) > 86400) return 'invalid: created_at too far from now';
    const data = new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
    if (hex(await crypto.subtle.digest('SHA-256', data)) !== ev.id) return 'invalid: bad id';
    return null;
  }

  storedBytes() {
    return this.sql.exec("SELECT v FROM meta WHERE k = 'bytes'").toArray()[0]?.v || 0;
  }

  setStoredBytes(n) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('bytes', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", Math.max(0, n));
  }

  /** Store a mail event. Returns false if it was already stored or has expired. */
  async keep(ev) {
    if (this.sql.exec('SELECT 1 FROM mail WHERE id = ?', ev.id).toArray().length) return false;
    const tag = ev.tags.find((t) => t[0] === 'expiration');
    const asked = tag ? Number(tag[1]) : Infinity;
    const expires = Math.min(Number.isFinite(asked) ? asked : Infinity, ev.created_at + this.cfg.mailTtlS);
    if (expires <= this.now()) return false;
    const json = JSON.stringify(ev);
    this.sql.exec('INSERT INTO mail (id, created_at, expires, bytes, json) VALUES (?, ?, ?, ?, ?)', ev.id, ev.created_at, expires, json.length, json);
    for (const t of new Set(ev.tags.filter((x) => x[0] === 't').map((x) => x[1]))) {
      this.sql.exec('INSERT OR IGNORE INTO mail_topic (topic, id) VALUES (?, ?)', t, ev.id);
    }
    let total = this.storedBytes() + json.length;
    // Full: the oldest mail goes first.
    while (total > this.cfg.maxStoredBytes) {
      const old = this.sql.exec('SELECT id, bytes FROM mail ORDER BY created_at ASC LIMIT 1').toArray()[0];
      if (!old) break;
      this.drop(old.id);
      total -= old.bytes;
    }
    this.setStoredBytes(total);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return true;
  }

  drop(id) {
    this.sql.exec('DELETE FROM mail_topic WHERE id = ?', id);
    this.sql.exec('DELETE FROM mail WHERE id = ?', id);
  }

  onReq(ws, id, sub, rawFilters) {
    const subs = this.allSubs();
    let mine = subs.get(id);
    if (!mine) { mine = new Map(); subs.set(id, mine); }
    if (!mine.has(sub) && mine.size >= MAX_SUBS) return this.send(ws, ['CLOSED', sub, 'error: too many subscriptions']);
    const filters = cleanFilters(rawFilters);
    mine.set(sub, withSets(filters));
    this.sql.exec('INSERT INTO subs (ws, sub, filters) VALUES (?, ?, ?) ON CONFLICT (ws, sub) DO UPDATE SET filters = excluded.filters', id, sub, JSON.stringify(filters));

    // Replay stored mail that matches.
    const t0 = this.now();
    const sent = new Set();
    for (const f of filters) {
      if (f.kinds && !f.kinds.includes(MAIL_KIND)) continue;
      for (let i = 0; i < f.t.length; i += SQL_PARAMS) {
        const part = f.t.slice(i, i + SQL_PARAMS);
        const rows = this.sql.exec(
          `SELECT m.id AS id, m.json AS json FROM mail_topic t JOIN mail m ON m.id = t.id
           WHERE t.topic IN (${part.map(() => '?').join(',')}) AND m.expires > ? AND m.created_at >= ? AND m.created_at <= ?
           ORDER BY m.created_at ASC`,
          ...part, t0, f.since ?? 0, f.until ?? Number.MAX_SAFE_INTEGER).toArray();
        for (const r of rows) {
          if (sent.has(r.id)) continue;
          sent.add(r.id);
          try { ws.send(`["EVENT",${JSON.stringify(sub)},${r.json}]`); } catch {}
        }
      }
    }
    this.send(ws, ['EOSE', sub]);
  }

  /** Short-lived credentials for Cloudflare's TURN service, from the deployer's TURN key. */
  async onTurn(ws, code) {
    const env = this.env;
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return this.send(ws, ['TURN', null, 'no TURN server is configured on this relay']);
    if (env.ACCESS_CODE && !(await sameSecret(code ?? '', env.ACCESS_CODE))) return this.send(ws, ['TURN', null, 'wrong access code']);
    try {
      const base = env.TURN_API_BASE || 'https://rtc.live.cloudflare.com';
      const res = await fetch(`${base}/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: this.cfg.turnTtlS }),
      });
      if (!res.ok) throw new Error('status ' + res.status);
      const servers = (await res.json()).iceServers;
      const turn = (Array.isArray(servers) ? servers : [servers]).find((s) => s && s.username && s.credential);
      // Browsers block port 53, and the app takes at most four addresses: prefer the standard ones.
      const urls = [].concat(turn?.urls || []).filter((u) => typeof u === 'string' && /^turns?:/i.test(u) && !/:53(\?|$)/.test(u));
      const pick = [/^turn:[^?]*:3478\?transport=udp/i, /^turn:[^?]*:3478\?transport=tcp/i, /^turns:[^?]*:5349/i, /^turns:[^?]*:443/i]
        .map((re) => urls.find((u) => re.test(u))).filter(Boolean);
      const chosen = pick.length ? pick : urls.slice(0, 4);
      if (!chosen.length) throw new Error('no usable addresses');
      this.send(ws, ['TURN', { urls: chosen, username: turn.username, credential: turn.credential, ttl: this.cfg.turnTtlS }]);
    } catch (e) {
      this.send(ws, ['TURN', null, 'the TURN service refused (' + String(e.message).slice(0, 80) + '); check the TURN key on this relay']);
    }
  }

  forget(ws) {
    const id = this.idOf(ws);
    if (!id) return;
    this.subs?.delete(id);
    this.rate.delete(id);
    this.sql.exec('DELETE FROM subs WHERE ws = ?', id);
  }

  async webSocketClose(ws, code) {
    this.forget(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    this.forget(ws);
  }

  /** Periodic clean-up: expired mail, and the stored-bytes counter. */
  async alarm() {
    const t = this.now();
    for (const row of this.sql.exec('SELECT id FROM mail WHERE expires <= ?', t).toArray()) this.drop(row.id);
    const left = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM mail').one();
    this.setStoredBytes(left.bytes);
    if (left.n > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}
