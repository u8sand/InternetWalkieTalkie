import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';
import * as C from '../../public/js/core/crypto.js';

async function user(name) {
  const e = new Engine(new MemoryStore());
  await e.createIdentity(name);
  return e;
}

/** Simulate a full sync session between two engines (what peer.js does over a DataChannel). */
async function sync(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    for (const conv of x.sharedConvs(y.identity.fp)) {
      for (const env of x.missingFor(conv, y.vv(conv))) await y.ingest(structuredClone(env), x.identity.fp);
    }
  }
}

const texts = (e, conv) => e.views.get(conv).list().filter((m) => !m.deleted).map((m) => m.text);

test('op seal/open/verify round trip and tamper detection', async () => {
  const a = await C.generateIdentity('a');
  const b = await C.generateIdentity('b');
  const bk = await C.importCard(b.card());
  assert.equal(bk.fp, b.fp);
  const env = await C.sealOp(a, [{ fp: a.fp, dhKey: a.dhPub }, bk], { conv: 'd:x', dev: '00000000000000aa', seq: 1, lamport: 1, ts: Date.now() }, { type: 'msg', text: 'hi' });
  assert.ok(await C.verifyOp(env, a.signPub));
  assert.deepEqual(await C.openOp(b, env), { type: 'msg', text: 'hi' });
  assert.deepEqual(await C.openOp(a, env), { type: 'msg', text: 'hi' });
  const c = await C.generateIdentity('c');
  await assert.rejects(C.openOp(c, env));
  const tampered = { ...env, seq: 2 };
  assert.equal(await C.verifyOp(tampered, a.signPub), false);
  await assert.rejects(C.openOp(b, tampered)); // header is bound as AAD too
});

test('signal seal/open authenticates sender and binds recipient', async () => {
  const a = await C.generateIdentity('alice');
  const b = await C.generateIdentity('bob');
  const c = await C.generateIdentity('carol');
  const blob = await C.sealSignal(a, await C.importCard(b.card()), { type: 'hello' });
  const { payload, sender } = await C.openSignal(b, blob);
  assert.equal(sender.fp, a.fp);
  assert.equal(payload.type, 'hello');
  await assert.rejects(C.openSignal(c, blob));
});

test('backup encrypt/decrypt', async () => {
  const f = await C.encryptBackup({ x: 1 }, 'pw');
  assert.deepEqual(await C.decryptBackup(f, 'pw'), { x: 1 });
  await assert.rejects(C.decryptBackup(f, 'nope'));
});

test('direct chat: concurrent edits converge in identical order', async () => {
  const a = await user('Alice');
  const b = await user('Bob');
  await a.addContact(b.identity.card());
  await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  assert.equal(conv, (await b.directConv(a.identity.fp)).id);

  await a.sendText(conv, 'a1');
  await b.sendText(conv, 'b1'); // concurrent, offline
  await a.sendText(conv, 'a2');
  await sync(a, b);
  assert.deepEqual(texts(a, conv), texts(b, conv));
  assert.equal(texts(a, conv).length, 3);

  const id = a.views.get(conv).list().find((m) => m.text === 'a1').id;
  await a.deleteMessage(conv, id);
  await b.sendText(conv, 'b2');
  await sync(b, a);
  assert.deepEqual(texts(a, conv), texts(b, conv));
  assert.ok(!texts(b, conv).includes('a1'));
  // idempotent re-sync
  await sync(a, b);
  assert.deepEqual(a.vv(conv), b.vv(conv));
});

test('group: membership learned from signed create op, relayed via third member', async () => {
  const a = await user('A'), b = await user('B'), c = await user('C');
  // A knows B and C; B and C don't know each other.
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  await a.addContact(c.identity.card()); await c.addContact(a.identity.card());
  const g = await a.createGroup('Trio', [b.identity.fp, c.identity.fp]);
  await a.sendText(g.id, 'hello group');
  await sync(a, b);
  assert.equal(b.views.get(g.id).name, 'Trio');
  await b.sendText(g.id, 'from b');
  await b.renameGroup(g.id, 'Renamed');
  // B's op reaches C only through A (store-and-forward by a member).
  await sync(b, a);
  await sync(a, c);
  assert.deepEqual(texts(c, g.id), ['hello group', 'from b']);
  assert.equal(c.views.get(g.id).name, 'Renamed');
  // C doesn't connect to B (a stranger) until C approves the group.
  assert.ok(!c.knownPeers().has(b.identity.fp), 'a co-member C never met is not a known peer yet');
  assert.deepEqual(c.groupStrangers(c.convs.get(g.id)), [b.identity.fp]);
  await c.trustGroup(g.id);
  assert.ok(c.knownPeers().has(b.identity.fp), 'C learns B as co-member once the group is approved');
});

test('rejects forged, foreign and non-member ops', async () => {
  const a = await user('A'), b = await user('B'), m = await user('Mallory');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  await b.addContact(m.identity.card()); await m.addContact(b.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  const env = await a.sendText(conv, 'legit');

  // Mallory re-signs a modified copy: signature won't match A's key.
  const forged = { ...structuredClone(env), seq: 2, lamport: 9 };
  assert.equal((await b.ingest(forged)).added, false);
  // Mallory authors an op claiming to be in the A<->B conversation.
  const mi = m.identity;
  const bk = m.keyring.get(b.identity.fp);
  const fake = await C.sealOp(mi, [bk], { conv, dev: '00000000000000aa', seq: 1, lamport: 1, ts: Date.now() }, { type: 'msg', text: 'evil' });
  assert.equal((await b.ingest(fake)).reason, 'author not a member');
  // Genuine op is accepted once, duplicates ignored.
  assert.equal((await b.ingest(structuredClone(env))).added, true);
  assert.equal((await b.ingest(structuredClone(env))).added, false);
});

test('persistence: reload engine from store', async () => {
  const store = new MemoryStore();
  const a = new Engine(store); await a.createIdentity('A');
  const b = await user('B');
  await a.addContact(b.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await a.sendText(conv, 'persist me');
  const a2 = new Engine(store);
  assert.equal(await a2.load(), true);
  assert.equal(a2.identity.fp, a.identity.fp);
  assert.deepEqual(texts(a2, conv), ['persist me']);
  // No plaintext at rest.
  const raw = JSON.stringify(await store.all('ops'));
  assert.ok(!raw.includes('persist me'));
});

test('backup restore into a fresh store', async () => {
  const a = await user('A'); const b = await user('B');
  await a.addContact(b.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await a.sendText(conv, 'backed up');
  const file = await a.exportBackup('secret');
  const store = new MemoryStore();
  await new Engine(store).importBackup(JSON.parse(JSON.stringify(file)), 'secret');
  const r = new Engine(store); await r.load();
  assert.equal(r.identity.fp, a.identity.fp);
  assert.deepEqual(texts(r, conv), ['backed up']);
});
