// The self-hosted relay (relay/server.mjs): the server people run from the Docker Compose file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { startRelay } from '../../relay/server.mjs';
import { randomSecret, publicKey, nostrEvent } from '../../public/js/core/schnorr.js';
import { hex } from '../../public/js/core/encoding.js';

const secret = randomSecret(), pub = hex(publicKey(secret));
const event = (kind, topic, content = 'b3BhcXVl', extra = []) => nostrEvent(secret, pub, kind, [['t', topic], ...extra], content);

/** A client that collects everything the relay sends it. */
async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const wait = async (pred, ms = 3000) => {
    const t = Date.now();
    for (;;) {
      const hit = got.find(pred);
      if (hit) return hit;
      if (Date.now() - t > ms) throw new Error('timed out; got ' + JSON.stringify(got).slice(0, 300));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, got, wait, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}
const quiet = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('forwards signalling live without storing it; stores mail until it expires', async () => {
  let now = Date.now();
  const relay = await startRelay({ port: 0, host: '127.0.0.1', env: {}, now: () => now });
  const a = await client(relay.port), b = await client(relay.port);
  b.send(['REQ', 's', { kinds: [25050, 4050], '#t': ['topic-b'] }]);
  await b.wait((m) => m[0] === 'EOSE');

  const sig = await event(25050, 'topic-b');
  a.send(['EVENT', sig]);
  assert.equal((await a.wait((m) => m[0] === 'OK' && m[1] === sig.id))[2], true);
  await b.wait((m) => m[0] === 'EVENT' && m[2].id === sig.id);
  assert.equal(relay.stored.size, 0, 'signalling is never stored');

  const mail = await event(4050, 'topic-b', 'bWFpbA', [['expiration', String(Math.floor(now / 1000) + 3600)]]);
  a.send(['EVENT', mail]);
  await b.wait((m) => m[0] === 'EVENT' && m[2].id === mail.id);
  // Someone who connects later still gets the mail, but not the old signal.
  const late = await client(relay.port);
  late.send(['REQ', 'x', { kinds: [25050, 4050], '#t': ['topic-b'] }]);
  await late.wait((m) => m[0] === 'EOSE');
  assert.deepEqual(late.got.filter((m) => m[0] === 'EVENT').map((m) => m[2].id), [mail.id]);
  // A different topic sees nothing; `since` after the mail hides it.
  late.send(['REQ', 'y', { kinds: [4050], '#t': ['other'] }]);
  late.send(['REQ', 'z', { kinds: [4050], '#t': ['topic-b'], since: mail.created_at + 10 }]);
  await late.wait((m) => m[0] === 'EOSE' && m[1] === 'z');
  assert.equal(late.got.filter((m) => m[0] === 'EVENT' && m[1] !== 'x').length, 0);
  // Past its expiry the mail is gone.
  now += 2 * 3600 * 1000;
  relay.compact();
  assert.equal(relay.stored.size, 0);
  for (const c of [a, b, late]) c.close();
  await relay.close();
});

test('rejects anything that is not a valid Walkie-Talkie event, and cannot be browsed', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', env: {} });
  const c = await client(relay.port);
  const good = await event(25050, 't1');
  const cases = {
    'other kind': await event(1, 't1', 'a public note'),
    'bad signature': { ...good, sig: good.sig.replace(/^../, good.sig.startsWith('00') ? '11' : '00') },
    'bad id': { ...good, content: 'tampered' },
    'no topic': await nostrEvent(secret, pub, 25050, [['x', 'y']], 'b3A'),
    'stale': { ...(await event(25050, 't1')), created_at: 1000 },
    'malformed': { id: 'nope' },
  };
  for (const [name, ev] of Object.entries(cases)) {
    const before = c.got.length;
    c.send(['EVENT', ev]);
    const ok = await c.wait((m) => m[0] === 'OK' && c.got.indexOf(m) >= before);
    assert.equal(ok[2], false, name + ' must be refused: ' + ok[3]);
  }
  // A filter with no topic returns nothing: stored mail can only be fetched by whoever knows its topic.
  const mail = await event(4050, 'secret-topic', 'bQ');
  c.send(['EVENT', mail]);
  await c.wait((m) => m[0] === 'OK' && m[1] === mail.id && m[2] === true);
  c.send(['REQ', 'all', {}, { kinds: [4050] }]);
  await c.wait((m) => m[0] === 'EOSE' && m[1] === 'all');
  assert.equal(c.got.filter((m) => m[0] === 'EVENT').length, 0);
  c.close();
  await relay.close();
});

test('mail survives a restart; storage is capped with the oldest dropped first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwt-relay-'));
  let relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, env: {} });
  let c = await client(relay.port);
  const m1 = await event(4050, 'tp', 'bWFpbDE');
  c.send(['EVENT', m1]);
  await c.wait((m) => m[0] === 'OK' && m[2] === true);
  await quiet();
  c.close(); await relay.close();

  relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, env: {}, cfg: { maxStoredBytes: 1500 } });
  assert.equal(relay.stored.size, 1, 'reloaded from disk');
  c = await client(relay.port);
  const big = [];
  for (let i = 0; i < 4; i++) { big.push(await event(4050, 'tp', 'A'.repeat(600) + i)); c.send(['EVENT', big[i]]); }
  await c.wait((m) => m[0] === 'OK' && m[1] === big[3].id);
  assert.ok(!relay.stored.has(m1.id), 'oldest mail dropped when full');
  assert.ok(relay.stored.has(big[3].id));
  assert.ok(relay.stored.size < 5);
  c.close(); await relay.close();
  fs.rmSync(dir, { recursive: true });
});

test('TURN credentials: only with the access code, and valid for coturn\'s shared-secret scheme', async () => {
  const env = { RELAY_HOST: 'relay.example.org', TURN_SECRET: 'shh', ACCESS_CODE: 'open sesame' };
  const relay = await startRelay({ port: 0, host: '127.0.0.1', env });
  const c = await client(relay.port);
  c.send(['TURN']);
  assert.match((await c.wait((m) => m[0] === 'TURN'))[2], /wrong access code/);
  c.got.length = 0;
  c.send(['TURN', 'open sesame']);
  const cred = (await c.wait((m) => m[0] === 'TURN'))[1];
  assert.deepEqual(cred.urls, ['turn:relay.example.org:3478?transport=udp', 'turn:relay.example.org:3478?transport=tcp']);
  assert.ok(Number(cred.username) > Date.now() / 1000 + 3600, 'username is the expiry time');
  assert.equal(cred.credential, createHmac('sha1', 'shh').update(cred.username).digest('base64'));
  c.close(); await relay.close();

  const none = await startRelay({ port: 0, host: '127.0.0.1', env: {} });
  const d = await client(none.port);
  d.send(['TURN', 'x']);
  assert.match((await d.wait((m) => m[0] === 'TURN'))[2], /no TURN server/);
  d.close(); await none.close();
});

test('per-connection rate limit', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', env: {}, cfg: { rateBurst: 5, ratePerSec: 1 } });
  const c = await client(relay.port);
  for (let i = 0; i < 12; i++) c.send(['REQ', 's', { '#t': ['x'] }]);
  await c.wait((m) => m[0] === 'NOTICE' && /rate-limited/.test(m[1]));
  assert.ok(c.got.filter((m) => m[0] === 'EOSE').length <= 5);
  c.close(); await relay.close();
});

test('the app fetches TURN credentials from the relay in the form its settings use', async () => {
  const { fetchTurn } = await import('../../public/js/core/signaling.js');
  const { parseIceServers } = await import('../../public/js/core/peer.js');
  const relay = await startRelay({ port: 0, host: '127.0.0.1', env: { RELAY_HOST: 'relay.example.org', TURN_SECRET: 'shh', ACCESS_CODE: 'code' } });
  const url = `ws://127.0.0.1:${relay.port}`;
  await assert.rejects(fetchTurn(url, 'wrong'), /wrong access code/);
  const { servers, ttl } = await fetchTurn(url, 'code');
  assert.equal(ttl, 12 * 3600);
  const ice = parseIceServers(servers);
  assert.equal(ice.length, 2);
  assert.equal(ice[0].urls, 'turn:relay.example.org:3478?transport=udp');
  assert.equal(ice[0].credential, createHmac('sha1', 'shh').update(ice[0].username).digest('base64'));
  await relay.close();
  await assert.rejects(fetchTurn(url, 'code', 1500), /could not reach|no answer/);
});
