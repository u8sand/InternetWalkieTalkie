// Walkie-Talkie relay: everything one person (or family, or group of friends) needs to host
// for the app, in one small process.
//
//  * A Nostr relay limited to the two event kinds the app uses:
//      25050  signalling and relayed messages — forwarded to live subscribers, never stored
//      4050   mailbox mail                    — stored until it expires (at most MAIL_TTL days)
//    Everything it handles is end-to-end encrypted by the app; the relay sees topics (hashes),
//    sizes and timing, never content, names or keys.
//  * Short-lived TURN credentials for the coturn server next to it (["TURN", accessCode]),
//    so the app can carry a WebRTC connection through it when two devices can't connect directly.
//
// Configuration is by environment variable (see .env.example). No database: stored mail is
// kept in memory and in an append-only file that is compacted as events expire.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1';

const SIGNAL_KIND = 25050, MAIL_KIND = 4050;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

export function startRelay(opts = {}) {
  const env = opts.env || process.env;
  const cfg = {
    port: num(opts.port ?? env.PORT, 7777),
    host: opts.host || env.BIND || '0.0.0.0',
    dataDir: opts.dataDir ?? env.DATA_DIR ?? '',
    mailTtlS: num(env.MAIL_TTL_DAYS, 8) * 86400,
    maxStoredBytes: num(env.MAX_STORED_MB, 100) * 1024 * 1024,
    maxEventBytes: num(env.MAX_EVENT_KB, 256) * 1024,
    maxConnections: num(env.MAX_CONNECTIONS, 500),
    ratePerSec: num(env.RATE_PER_SEC, 20), rateBurst: num(env.RATE_BURST, 100),
    turnHost: env.TURN_HOST || env.RELAY_HOST || '',
    turnPort: num(env.TURN_PORT, 3478),
    turnSecret: env.TURN_SECRET || '',
    turnTtlS: num(env.TURN_TTL_HOURS, 12) * 3600,
    accessCode: env.ACCESS_CODE || '',
    ...opts.cfg,
  };
  const now = () => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const stats = { events: 0, rejected: 0, stored: 0, kinds: {}, log: opts.record ? [] : null };

  // ------------------------------------------------------------ stored mail

  const stored = new Map(); // id -> {ev, bytes, expires}
  let storedBytes = 0;
  const file = cfg.dataDir ? path.join(cfg.dataDir, 'mail.jsonl') : null;

  const expiryOf = (ev) => {
    const tag = ev.tags.find((t) => t[0] === 'expiration');
    const asked = tag ? Number(tag[1]) : Infinity;
    return Math.min(Number.isFinite(asked) ? asked : Infinity, ev.created_at + cfg.mailTtlS);
  };

  function keep(ev, persist = true) {
    if (stored.has(ev.id)) return;
    const line = JSON.stringify(ev);
    const rec = { ev, bytes: line.length, expires: expiryOf(ev) };
    if (rec.expires <= now()) return;
    stored.set(ev.id, rec);
    storedBytes += rec.bytes;
    // Full: the oldest mail goes first.
    for (const [id, old] of stored) {
      if (storedBytes <= cfg.maxStoredBytes) break;
      stored.delete(id); storedBytes -= old.bytes;
    }
    if (persist && file) fs.appendFile(file, line + '\n', () => {});
    stats.stored = stored.size;
  }

  function compact() {
    const t = now();
    for (const [id, rec] of stored) if (rec.expires <= t) { stored.delete(id); storedBytes -= rec.bytes; }
    stats.stored = stored.size;
    if (!file) return;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, [...stored.values()].map((r) => JSON.stringify(r.ev) + '\n').join(''));
    fs.renameSync(tmp, file);
  }

  if (file) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const ev = JSON.parse(line); if (validShape(ev)) keep(ev, false); } catch {}
      }
    }
    compact();
  }
  const sweeper = setInterval(compact, 15 * 60000);
  sweeper.unref?.();

  // ------------------------------------------------------------ events and filters

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

  /** Returns null if the event is acceptable, else the reason it isn't. */
  function check(ev) {
    if (!validShape(ev)) return 'invalid: malformed event';
    if (ev.kind !== SIGNAL_KIND && ev.kind !== MAIL_KIND) return 'blocked: this relay only carries Walkie-Talkie events';
    if (!ev.tags.some((t) => t[0] === 't')) return 'invalid: no topic';
    if (Math.abs(ev.created_at - now()) > 86400) return 'invalid: created_at too far from now';
    const id = createHash('sha256').update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])).digest('hex');
    if (id !== ev.id) return 'invalid: bad id';
    try { if (!schnorr.verify(ev.sig, ev.id, ev.pubkey)) return 'invalid: bad signature'; } catch { return 'invalid: bad signature'; }
    return null;
  }

  function cleanFilters(list) {
    const out = [];
    for (const f of list.slice(0, 20)) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const g = {};
      if (Array.isArray(f.kinds)) g.kinds = f.kinds.filter(Number.isSafeInteger).slice(0, 8);
      if (Number.isSafeInteger(f.since)) g.since = f.since;
      if (Number.isSafeInteger(f.until)) g.until = f.until;
      if (Array.isArray(f['#t'])) g.t = new Set(f['#t'].filter((x) => typeof x === 'string' && x.length <= 128).slice(0, 500));
      // The app always asks by topic. Refusing topic-less filters means nobody can list what's here.
      if (g.t?.size) out.push(g);
    }
    return out;
  }

  const matches = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind))
    && (f.since === undefined || ev.created_at >= f.since)
    && (f.until === undefined || ev.created_at <= f.until)
    && ev.tags.some((t) => t[0] === 't' && f.t.has(t[1]));

  // ------------------------------------------------------------ TURN credentials

  function safeEqual(a, b) {
    const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(x, y);
  }

  /** coturn "REST API" credentials: valid until the time in the username, proven by an HMAC of it. */
  function turnCredentials() {
    const username = String(now() + cfg.turnTtlS);
    const credential = createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
    const at = `${cfg.turnHost}:${cfg.turnPort}`;
    return { urls: [`turn:${at}?transport=udp`, `turn:${at}?transport=tcp`], username, credential, ttl: cfg.turnTtlS };
  }

  // ------------------------------------------------------------ server

  const info = {
    name: env.RELAY_NAME || 'Walkie-Talkie relay',
    description: 'Carries end-to-end encrypted Walkie-Talkie signalling and mailbox events only.',
    software: 'https://github.com/u8sand/InternetWalkieTalkie',
    supported_nips: [1, 11, 40],
    limitation: { max_message_length: cfg.maxEventBytes, max_subscriptions: 4, max_filters: 20 },
  };

  const server = http.createServer((req, res) => {
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if ((req.headers.accept || '').includes('application/nostr+json')) {
      res.writeHead(200, { ...headers, 'content-type': 'application/nostr+json' }).end(JSON.stringify(info));
    } else if (req.url === '/health') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, connections: wss.clients.size, stored: stored.size }));
    } else {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' })
        .end(`${info.name}\n\nThis is a relay for the Walkie-Talkie messenger. Add this address in the app:\nSettings → My relay.\n`);
    }
  });

  const wss = new WebSocketServer({ server, maxPayload: cfg.maxEventBytes });

  wss.on('connection', (ws) => {
    if (wss.clients.size > cfg.maxConnections) { ws.close(1013, 'relay is full'); return; }
    ws.subs = new Map();
    let tokens = cfg.rateBurst, at = Date.now();
    const send = (msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(JSON.stringify(msg)); };
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      // Per-connection rate limit.
      const t = Date.now();
      tokens = Math.min(cfg.rateBurst, tokens + (t - at) / 1000 * cfg.ratePerSec); at = t;
      if (tokens < 1) return send(['NOTICE', 'rate-limited: slow down']);
      tokens -= 1;

      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(msg)) return;

      if (msg[0] === 'EVENT') {
        const ev = msg[1];
        const bad = check(ev);
        if (bad) { stats.rejected++; return send(['OK', typeof ev?.id === 'string' ? ev.id.slice(0, 64) : '', false, bad]); }
        send(['OK', ev.id, true, '']);
        stats.events++;
        stats.kinds[ev.kind] = (stats.kinds[ev.kind] || 0) + 1;
        stats.log?.push(JSON.stringify(ev)); // tests only (opts.record)
        if (ev.kind === MAIL_KIND) { if (stored.has(ev.id)) return; keep(ev); }
        for (const c of wss.clients) {
          if (!c.subs) continue;
          for (const [sid, filters] of c.subs) {
            if (filters.some((f) => matches(f, ev))) { c.send(JSON.stringify(['EVENT', sid, ev])); break; }
          }
        }
      } else if (msg[0] === 'REQ' && typeof msg[1] === 'string' && msg[1].length <= 64) {
        if (!ws.subs.has(msg[1]) && ws.subs.size >= 4) return send(['CLOSED', msg[1], 'error: too many subscriptions']);
        const filters = cleanFilters(msg.slice(2));
        ws.subs.set(msg[1], filters);
        const t0 = now();
        for (const { ev, expires } of stored.values()) {
          if (expires > t0 && filters.some((f) => matches(f, ev))) send(['EVENT', msg[1], ev]);
        }
        send(['EOSE', msg[1]]);
      } else if (msg[0] === 'CLOSE') {
        ws.subs.delete(msg[1]);
      } else if (msg[0] === 'TURN') {
        if (!cfg.turnSecret || !cfg.turnHost) return send(['TURN', null, 'no TURN server is configured on this relay']);
        if (cfg.accessCode && !safeEqual(msg[1] ?? '', cfg.accessCode)) return send(['TURN', null, 'wrong access code']);
        send(['TURN', turnCredentials()]);
      }
    });
  });

  return new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve({
    server, wss, stats, cfg, stored,
    port: server.address().port,
    compact,
    close: () => new Promise((done) => { clearInterval(sweeper); for (const c of wss.clients) c.terminate(); wss.close(() => server.close(() => done())); }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await startRelay();
  console.log(`Walkie-Talkie relay listening on :${r.port}`
    + ` · mail ${r.cfg.dataDir ? 'stored in ' + r.cfg.dataDir : 'in memory only'}`
    + ` · TURN ${r.cfg.turnSecret && r.cfg.turnHost ? 'credentials for ' + r.cfg.turnHost : 'not configured'}`
    + ` · access code ${r.cfg.accessCode ? 'required for TURN' : 'not set'}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { r.compact(); process.exit(0); });
}
