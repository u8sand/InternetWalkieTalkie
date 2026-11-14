// Who may reach us: removed contacts, strangers in groups, request and storage limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, AUTO_FETCH_BYTES } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';
import * as C from '../../public/js/core/crypto.js';

async function user(name) {
  const e = new Engine(new MemoryStore());
  await e.createIdentity(name);
  return e;
}
const befriend = async (a, b) => { await a.addContact(b.identity.card()); await b.addContact(a.identity.card()); };
const texts = (e, conv) => e.views.get(conv).list().map((m) => m.text);

test('a removed contact is cut off: no connection, no messages, no requests, until re-added', async () => {
  const a = await user('A'), b = await user('B');
  await befriend(a, b);
  const conv = (await b.directConv(a.identity.fp)).id;
  assert.equal((await a.ingest(await b.sendText(conv, 'before'), 'x')).added, true);
  await a.removeContact(b.identity.fp);
  assert.ok(!a.knownPeers().has(b.identity.fp));
  const late = await b.sendText(conv, 'after');
  assert.deepEqual(await a.ingest(structuredClone(late), 'x'), { added: false, reason: 'not a contact' });
  assert.equal(a.requests.size, 0, 'no contact request from someone we removed');
  assert.equal(await a.addRequest(b.identity.card()), false);
  assert.deepEqual(texts(a, conv), ['before']);
  // Adding them again restores everything, including what they wrote meanwhile.
  await a.addContact(b.identity.card());
  assert.equal((await a.ingest(structuredClone(late), 'x')).added, true);
  assert.deepEqual(texts(a, conv), ['before', 'after']);
});

test('a group co-member who is not a contact must ask before messaging directly', async () => {
  const a = await user('A'), b = await user('B'), e = await user('Eve');
  await befriend(a, b); await befriend(b, e);
  let gop; b.addEventListener('op', (ev) => { gop = ev.detail.env; }, { once: true });
  const g = await b.createGroup('g', [a.identity.fp, e.identity.fp]);
  assert.equal((await a.ingest(structuredClone(gop), 'x')).added, true);
  assert.equal(a.convs.get(g.id).trusted, false);
  assert.ok(!a.knownPeers().has(e.identity.fp), 'no connection to the stranger');
  await e.addContact(a.identity.card());
  const dm = await e.sendText((await e.directConv(a.identity.fp)).id, 'hi');
  assert.equal((await a.ingest(structuredClone(dm), 'x')).reason, 'not a contact');
  assert.ok(a.requests.has(e.identity.fp), 'it became a contact request instead');
  await a.addContact(e.identity.card());
  assert.equal((await a.ingest(structuredClone(dm), 'x')).added, true);
});

test('only a contact can put us in a group; a declined group stays gone', async () => {
  const a = await user('A'), b = await user('B'), m = await user('Mallory');
  await befriend(a, b);
  await m.addContact(a.identity.card());
  let gop; m.addEventListener('op', (ev) => { gop = ev.detail.env; }, { once: true });
  await m.createGroup('spam', [a.identity.fp]);
  assert.equal((await a.ingest(structuredClone(gop), 'x')).reason, 'group from a non-contact');
  assert.equal(a.convs.size, 1);

  b.addEventListener('op', (ev) => { gop = ev.detail.env; }, { once: true });
  const g = await b.createGroup('g', [a.identity.fp]);
  assert.equal((await a.ingest(structuredClone(gop), 'x')).added, true);
  assert.equal(a.convs.get(g.id).trusted, true, 'every member is a contact');
  await a.declineGroup(g.id);
  assert.ok(!a.conversations().some((c) => c.conv.id === g.id));
  assert.ok(!a.sharedConvs(b.identity.fp).includes(g.id));
  assert.equal((await a.ingest(await b.sendText(g.id, 'still there?'), 'x')).reason, 'declined');
});

test('contact requests are capped', async () => {
  const a = await user('A');
  for (let i = 0; i < 55; i++) await a.addRequest((await C.generateIdentity('s' + i)).card());
  assert.equal(a.requests.size, 50);
});

test('a member cannot flood a conversation with made-up device streams', async () => {
  const a = await user('A'), b = await user('B');
  await befriend(a, b);
  const conv = (await b.directConv(a.identity.fp)).id;
  const ak = b.keyring.get(a.identity.fp);
  let last;
  for (let i = 0; i < 34; i++) {
    const dev = i.toString(16).padStart(16, '0');
    const env = await C.sealOp(b.identity, [ak], { conv, dev, seq: 1, lamport: 1, ts: Date.now() }, { type: 'msg', text: 'x', ts: 1 });
    last = await a.ingest(env, 'x');
  }
  assert.equal(last.reason, 'too many devices');
  assert.equal(a.logs.get(conv).byAuthor.size, 32);
});

test('large attachments from others wait for the user; small and own ones do not', async () => {
  const a = await user('A'), b = await user('B');
  await befriend(a, b);
  const conv = (await b.directConv(a.identity.fp)).id;
  const big = await b.sendFile(conv, { bytes: new Uint8Array(AUTO_FETCH_BYTES + 1).fill(1), name: 'big.bin', mime: 'application/octet-stream' });
  const small = await b.sendFile(conv, { bytes: new Uint8Array(10).fill(1), name: 'small.bin', mime: 'application/octet-stream' });
  await a.ingest(structuredClone(big), 'x'); await a.ingest(structuredClone(small), 'x');
  assert.deepEqual(a.incompleteFiles().map((f) => f.file.name), ['small.bin']);
  const msg = a.views.get(conv).list().find((m) => m.file.name === 'big.bin');
  assert.ok(a.fileNeedsConsent(msg));
  a.wantFile(msg.file.id);
  assert.deepEqual(a.incompleteFiles().map((f) => f.file.name).sort(), ['big.bin', 'small.bin']);
  assert.equal(b.incompleteFiles().length, 0);
});

test('backup restore rejects absurd key-stretching parameters', async () => {
  const file = await C.encryptBackup({ x: 1 }, 'correct horse battery');
  assert.deepEqual(await C.decryptBackup(file, 'correct horse battery'), { x: 1 });
  await assert.rejects(C.decryptBackup({ ...file, iterations: 1 }, 'correct horse battery'), /not a backup file/);
  await assert.rejects(C.decryptBackup({ ...file, iterations: 1e12 }, 'correct horse battery'), /not a backup file/);
});
