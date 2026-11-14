// Receipts, "delete for me", clearing chats and search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';

async function user(name, store = new MemoryStore()) {
  const e = new Engine(store);
  await e.createIdentity(name);
  return e;
}

async function pair() {
  const a = await user('Alice'), b = await user('Bob');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await b.directConv(a.identity.fp);
  return { a, b, conv };
}

async function sync(x, y) {
  for (const [p, q] of [[x, y], [y, x]]) {
    for (const conv of p.sharedConvs(q.identity.fp)) {
      for (const env of p.missingFor(conv, q.vv(conv))) await q.ingest(structuredClone(env), p.identity.fp);
    }
  }
}

async function cloneDevice(src) {
  const store = new MemoryStore();
  await new Engine(store).importState(structuredClone(await src.exportState()));
  const e = new Engine(store);
  await e.load();
  return e;
}

const texts = (e, conv) => e.views.get(conv).list().filter((m) => !m.deleted).map((m) => m.text);
const msgByText = (e, conv, t) => e.views.get(conv).list().find((m) => m.text === t);

test('receipts: pending → mailbox → delivered → read, never going backwards', async () => {
  const { a, b, conv } = await pair();
  const env = await a.sendText(conv, 'hello');
  const m = msgByText(a, conv, 'hello');
  const bob = b.identity.fp;
  assert.equal(a.receiptState(conv, m).state, null);

  await a.noteRelayed(bob, [env]);
  assert.equal(a.receiptState(conv, m).state, 'relay');

  await sync(a, b);
  await a.noteReceipt(conv, bob, b.myReceipt(conv)); // what Bob's device reports
  assert.equal(a.receiptState(conv, m).state, 'got');

  await b.markRead(conv);
  await a.noteReceipt(conv, bob, b.myReceipt(conv));
  assert.equal(a.receiptState(conv, m).state, 'read');

  // An old receipt arriving late doesn't undo anything.
  await a.noteReceipt(conv, bob, { got: {}, read: 0 });
  assert.equal(a.receiptState(conv, m).state, 'read');

  // Strangers, non-members and garbage are ignored.
  const mallory = await user('Mallory');
  assert.equal(await a.noteReceipt(conv, mallory.identity.fp, { read: 99 }), false);
  assert.equal(await a.noteReceipt(conv, bob, { got: { 'not a stream': 5 }, read: -1 }), false);
});

test('receipts: turning them off hides read marks but delivery is still reported', async () => {
  const { a, b, conv } = await pair();
  await a.sendText(conv, 'hi');
  await sync(a, b);
  await b.markRead(conv);
  await b.saveSettings({ receipts: false });
  const r = b.myReceipt(conv);
  assert.equal(r.read, undefined);
  await a.noteReceipt(conv, b.identity.fp, r);
  assert.equal(a.receiptState(conv, msgByText(a, conv, 'hi')).state, 'got');
});

test('receipts: in a group the least advanced member decides the tick', async () => {
  const a = await user('A'), b = await user('B'), c = await user('C');
  for (const x of [b, c]) { await a.addContact(x.identity.card()); await x.addContact(a.identity.card()); }
  const g = await a.createGroup('G', [b.identity.fp, c.identity.fp]);
  await a.sendText(g.id, 'yo');
  await sync(a, b); await sync(a, c);
  await b.markRead(g.id);
  await a.noteReceipt(g.id, b.identity.fp, b.myReceipt(g.id));
  const m = msgByText(a, g.id, 'yo');
  let r = a.receiptState(g.id, m);
  assert.equal(r.members[b.identity.fp], 'read');
  assert.equal(r.members[c.identity.fp], null);
  assert.equal(r.state, null);
  await a.noteReceipt(g.id, c.identity.fp, c.myReceipt(g.id));
  assert.equal(a.receiptState(g.id, m).state, 'got');
});

test('delete for me: removes the content locally, survives re-sync and reload, peers unaffected', async () => {
  const store = new MemoryStore();
  const a = await user('Alice', store), b = await user('Bob');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await b.sendText(conv, 'secret from bob');
  await b.sendText(conv, 'keep me');
  await a.sendText(conv, 'mine to hide');
  await sync(a, b);

  await a.forgetMessages(conv, [msgByText(a, conv, 'secret from bob').id, msgByText(a, conv, 'mine to hide').id]);
  assert.deepEqual(texts(a, conv), ['keep me']);
  // Bob's op content is gone from Alice's storage (header-only stub); her own op keeps its
  // envelope so it can still reach members who don't have it yet.
  const stored = await store.all('ops');
  assert.equal(stored.filter((e) => e.stub).length, 1);
  assert.ok(stored.find((e) => e.stub).author === b.identity.fp && !('ct' in stored.find((e) => e.stub)));

  // Syncing again neither re-fetches it nor sends the stub anywhere.
  await sync(a, b);
  assert.deepEqual(texts(a, conv), ['keep me']);
  assert.ok(a.missingFor(conv, {}).every((e) => !e.stub));
  assert.deepEqual(texts(b, conv).sort(), ['keep me', 'mine to hide', 'secret from bob'], "Bob's copy is untouched");
  assert.deepEqual(a.vv(conv), b.vv(conv));

  const a2 = new Engine(store);
  await a2.load();
  assert.deepEqual(texts(a2, conv), ['keep me']);
  await a2.sendText(conv, 'after reload');
  await sync(a2, b);
  assert.deepEqual(texts(b, conv).at(-1), 'after reload');
});

test('clearing a chat hides it until a new message arrives, and spreads to our other devices', async () => {
  const { a, b, conv } = await pair();
  await a.sendText(conv, 'one');
  await b.sendText(conv, 'two');
  await sync(a, b);
  const phone = await cloneDevice(a);

  await a.clearConv(conv, { hide: true });
  assert.deepEqual(texts(a, conv), []);
  assert.ok(!a.conversations().some((c) => c.conv.id === conv), 'left the chat list');

  // Our phone learns about it from the own-device summary and drops the same messages.
  await phone.mergeOwnDevice(a.ownDeviceSummary());
  assert.deepEqual(texts(phone, conv), []);

  // Bob writes again: the chat comes back with only the new message, everywhere.
  await b.sendText(conv, 'three');
  await sync(b, a); await sync(b, phone);
  assert.deepEqual(texts(a, conv), ['three']);
  assert.deepEqual(texts(phone, conv), ['three']);
  assert.ok(a.conversations().some((c) => c.conv.id === conv));
});

test('own devices share read position and receipts', async () => {
  const { a, b, conv } = await pair();
  await b.sendText(conv, 'unread?');
  await sync(a, b);
  const phone = await cloneDevice(a);
  await a.markRead(conv);
  await a.noteReceipt(conv, b.identity.fp, { read: 5 });
  await phone.mergeOwnDevice(a.ownDeviceSummary());
  assert.equal(phone.conversations().find((c) => c.conv.id === conv).unread, 0);
  assert.equal(phone.receipts.get(conv)[b.identity.fp].read, 5);
});

test('search finds messages across chats, accent- and case-insensitively, newest first', async () => {
  const { a, b, conv } = await pair();
  await a.sendText(conv, 'Meet at the Café at noon');
  await b.sendText(conv, 'unrelated');
  await sync(a, b);
  await new Promise((r) => setTimeout(r, 2));
  await b.sendText(conv, 'which cafe?');
  await sync(a, b);
  const hits = a.search('CAFE');
  assert.deepEqual(hits.map((h) => h.msg.text), ['which cafe?', 'Meet at the Café at noon']);
  assert.deepEqual(a.search('cafe noon').map((h) => h.msg.text), ['Meet at the Café at noon']);
  assert.deepEqual(a.search('   '), []);
  await a.deleteMessage(conv, msgByText(a, conv, 'Meet at the Café at noon').id);
  assert.equal(a.search('noon').length, 0, 'deleted messages are not searchable');
});

test('signed receipts can be relayed by group members but not forged', async () => {
  const a = await user('A'), b = await user('B'), c = await user('C');
  for (const x of [b, c]) { await a.addContact(x.identity.card()); await x.addContact(a.identity.card()); }
  const g = await a.createGroup('G', [b.identity.fp, c.identity.fp]);
  await sync(a, b); await sync(a, c);
  await b.sendText(g.id, 'from b');
  await sync(b, a); await sync(a, c); // C gets B's message through A
  await c.markRead(g.id);

  // C's receipt travels C → A → B; B and C are never connected.
  const rc = await c.signedReceipt(g.id);
  assert.equal(await a.ingestSignedReceipt(structuredClone(rc)), true);
  const [relayed] = a.relayReceipts(g.id);
  assert.equal(await b.ingestSignedReceipt(structuredClone(relayed)), true);
  assert.equal(b.receiptState(g.id, msgByText(b, g.id, 'from b')).members[c.identity.fp], 'read');
  assert.equal(await b.ingestSignedReceipt(structuredClone(relayed)), false, 'nothing new the second time');

  // A can't claim C read further, or put words in C's mouth.
  const forged = { ...structuredClone(rc), read: rc.read + 10 };
  const fresh = await user('B2'); // any member-side check fails the same way
  assert.equal(await b.ingestSignedReceipt(forged), false);
  assert.equal(await fresh.ingestSignedReceipt(rc), false, 'unknown conversation');
});
