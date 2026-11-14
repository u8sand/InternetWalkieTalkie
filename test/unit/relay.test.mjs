// The sync protocol over relays (no WebRTC), and TURN server settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';
import { parseIceServers } from '../../public/js/core/peer.js';
import { RelaySession } from '../../public/js/core/relaysession.js';

async function user(name) {
  const e = new Engine(new MemoryStore());
  await e.createIdentity(name);
  return e;
}
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('ICE server settings: plain addresses, and TURN with a username and password', () => {
  assert.deepEqual(parseIceServers([
    'stun:stun.example.org:3478',
    '  turn:turn.example.org:3478?transport=udp   alice   s3cret ',
    'turns:turn.example.org:5349 bob',  // a username without a password: sent without credentials
    'https://not-an-ice-server', '', 42,
  ]), [
    { urls: 'stun:stun.example.org:3478' },
    { urls: 'turn:turn.example.org:3478?transport=udp', username: 'alice', credential: 's3cret' },
    { urls: 'turns:turn.example.org:5349' },
  ]);
  assert.deepEqual(parseIceServers(undefined), []);
});

/** Two engines joined by relay sessions whose "relay" may drop, duplicate and reorder parts. */
function link(a, b, { lossy = false } = {}) {
  let sa, sb, n = 0;
  const deliver = (to) => async (part) => {
    n++;
    const p = structuredClone(part);
    if (lossy && n % 7 === 0) return;                       // lost
    if (lossy && n % 5 === 0) setTimeout(() => to().receive(structuredClone(p)), 30); // late duplicate
    to().receive(p);
  };
  sa = new RelaySession(a, { remote: a.keyring.get(b.identity.fp), dev: b.device, sendSignal: deliver(() => sb) });
  sb = new RelaySession(b, { remote: b.keyring.get(a.identity.fp), dev: a.device, sendSignal: deliver(() => sa) });
  return [sa, sb];
}
const texts = (e, conv) => e.views.get(conv).list().map((m) => m.text);

test('relay session: history syncs both ways in parts, with receipts, and never serves files', async () => {
  const a = await user('A'), b = await user('B');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await a.sendText(conv, 'x'.repeat(15000));                 // large enough that the sync spans several parts
  for (let i = 0; i < 5; i++) await a.sendText(conv, 'from a ' + i);
  await b.sendText(conv, 'from b');
  const [sa, sb] = link(a, b);
  assert.equal(sa.route, 'relay'); assert.equal(sa.direct, false);
  sa.sendSync(); sb.sendSync();
  await until(() => texts(a, conv).length === 7 && texts(b, conv).length === 7);
  assert.deepEqual(texts(a, conv), texts(b, conv));
  // B's sync told A what B holds: delivered ticks without any direct connection.
  sb.sendSync();
  const mine = a.views.get(conv).list().find((m) => m.text === 'from a 4');
  await until(() => a.receiptState(conv, mine).state === 'got');
  assert.equal(sa.requestChunks('abc', [0]), false, 'attachments are never requested over a relay');
  sa.close(); sb.close();
});

test('relay session: converges despite lost, duplicated and reordered parts (re-sync repairs it)', async () => {
  const a = await user('A'), b = await user('B');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  for (let i = 0; i < 30; i++) await a.sendText(conv, 'm' + i + ' ' + 'y'.repeat(3000));
  const [sa, sb] = link(a, b, { lossy: true });
  for (let round = 0; round < 12 && texts(b, conv).length < 30; round++) {
    sb.sendSync();
    await new Promise((r) => setTimeout(r, 700));
  }
  assert.equal(texts(b, conv).length, 30);
  sa.close(); sb.close();
});

test('relay session: malformed and oversized parts are ignored', async () => {
  const a = await user('A'), b = await user('B');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const [sa, sb] = link(a, b);
  for (const p of [null, {}, { id: 'x', i: 0, n: 1, d: 'not json' }, { id: 'x', i: 5, n: 2, d: '{}' }, { id: 'x', i: 0, n: 1e9, d: '{}' },
    { id: 'x', i: 0, n: 1, d: 'z'.repeat(30000) }, { id: 'y'.repeat(40), i: 0, n: 1, d: '{"t":"sync"}' }]) sa.receive(p);
  for (let i = 0; i < 40; i++) sa.receive({ id: 'p' + i, i: 0, n: 3, d: '{' }); // never-completed messages
  assert.ok(sa.partial.size <= 16, 'partial messages are bounded');
  sa.close(); sb.close();
});
