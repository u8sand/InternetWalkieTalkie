// Minimal in-memory Nostr relay (NIP-01 subset) for tests: node test/relay.mjs [port]
// Verifies event ids and Schnorr signatures exactly like public relays do. Regular kinds
// (1000–9999) are stored and replayed to new subscriptions until their NIP-40 expiration;
// ephemeral kinds (20000–29999) are only forwarded.
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function matches(f, ev) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (k[0] !== '#') continue;
    const tag = k.slice(1);
    if (!ev.tags.some((t) => t[0] === tag && vals.includes(t[1]))) return false;
  }
  return true;
}

export function startRelay(port = 7777) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const stats = { events: 0, rejected: 0, log: [], kinds: {} };
  const stored = [];
  const live = (ev) => { const t = ev.tags.find((x) => x[0] === 'expiration'); return !t || Number(t[1]) > Date.now() / 1000; };
  wss.on('connection', (ws) => {
    ws.subs = new Map();
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg[0] === 'REQ') {
        const filters = msg.slice(2);
        ws.subs.set(msg[1], filters);
        for (const ev of stored) if (live(ev) && filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(['EVENT', msg[1], ev]));
        ws.send(JSON.stringify(['EOSE', msg[1]]));
      }
      else if (msg[0] === 'CLOSE') ws.subs.delete(msg[1]);
      else if (msg[0] === 'EVENT') {
        const ev = msg[1];
        const id = createHash('sha256').update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])).digest('hex');
        let ok = id === ev.id;
        try { ok = ok && schnorr.verify(ev.sig, ev.id, ev.pubkey); } catch { ok = false; }
        ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'invalid: bad signature']));
        if (!ok) { stats.rejected++; return; }
        stats.events++;
        stats.log.push(JSON.stringify(ev));
        stats.kinds[ev.kind] = (stats.kinds[ev.kind] || 0) + 1;
        if (ev.kind >= 1000 && ev.kind < 10000) stored.push(ev);
        for (const c of wss.clients) for (const [sid, filters] of c.subs) {
          if (filters.some((f) => matches(f, ev))) c.send(JSON.stringify(['EVENT', sid, ev]));
        }
      }
    });
  });
  return new Promise((r) => wss.on('listening', () => r({ wss, stats, close: () => new Promise((d) => { for (const c of wss.clients) c.terminate(); wss.close(d); }) })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 7777);
  await startRelay(port);
  console.log(`Test relay on ws://127.0.0.1:${port}`);
}
