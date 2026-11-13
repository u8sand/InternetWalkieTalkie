import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';

async function user(name) {
  const e = new Engine(new MemoryStore());
  await e.createIdentity(name);
  return e;
}

/** Clone `src` onto a fresh installation, as device linking does. */
async function cloneDevice(src) {
  const store = new MemoryStore();
  await new Engine(store).importState(structuredClone(await src.exportState()));
  const e = new Engine(store);
  await e.load();
  return e;
}

async function sync(x, y) {
  for (const [p, q] of [[x, y], [y, x]]) {
    for (const conv of p.sharedConvs(q.identity.fp)) {
      for (const env of p.missingFor(conv, q.vv(conv))) await q.ingest(structuredClone(env), p.identity.fp);
    }
  }
}

const texts = (e, conv) => e.views.get(conv).list().filter((m) => !m.deleted).map((m) => m.text);

test('a cloned device shares the identity but writes its own CRDT stream', async () => {
  const laptop = await user('Bob');
  const alice = await user('Alice');
  await laptop.addContact(alice.identity.card()); await alice.addContact(laptop.identity.card());
  const conv = (await laptop.directConv(alice.identity.fp)).id;
  await laptop.sendText(conv, 'before cloning');

  const phone = await cloneDevice(laptop);
  assert.equal(phone.identity.fp, laptop.identity.fp, 'same identity');
  assert.notEqual(phone.device, laptop.device, 'different device id');
  assert.deepEqual(texts(phone, conv), ['before cloning'], 'history came along');

  // Both devices write concurrently while apart — same identity, same next seq number.
  const a = await laptop.sendText(conv, 'from laptop');
  const b = await phone.sendText(conv, 'from phone');
  assert.notEqual(a.dev, b.dev);
  assert.deepEqual([a.seq, b.seq], [2, 1], 'each device numbers its own stream');
  await alice.sendText(conv, 'from alice');

  // Alice syncs with the phone only; the laptop catches up through her.
  await sync(phone, alice);
  await sync(alice, laptop);
  const expect = texts(alice, conv);
  assert.equal(expect.length, 4);
  assert.deepEqual(texts(laptop, conv), expect);
  await sync(laptop, phone); // own devices also sync directly
  assert.deepEqual(texts(phone, conv), expect);
  assert.deepEqual(phone.vv(conv), alice.vv(conv));

  // Deleting your own message works from either device.
  const fromLaptop = phone.views.get(conv).list().find((m) => m.text === 'from laptop');
  await phone.deleteMessage(conv, fromLaptop.id);
  await sync(phone, alice);
  assert.ok(!texts(alice, conv).includes('from laptop'));
});

test('own devices merge their address books (adds, nicknames, removals, name)', async () => {
  const laptop = await user('Bob');
  const phone = await cloneDevice(laptop);
  const carol = await user('Carol'), dave = await user('Dave');

  await phone.addContact(carol.identity.card());
  await new Promise((r) => setTimeout(r, 5));
  await laptop.addContact(dave.identity.card());
  await laptop.setNick(dave.identity.fp, 'Dave from work');
  await laptop.mergeOwnDevice(phone.ownDeviceSummary());
  await phone.mergeOwnDevice(laptop.ownDeviceSummary());
  for (const d of [laptop, phone]) {
    assert.ok(d.isContact(carol.identity.fp) && d.isContact(dave.identity.fp));
    assert.equal(d.displayName(dave.identity.fp), 'Dave from work');
  }

  // A conversation the phone started with its new contact replicates to the laptop.
  const conv = (await phone.directConv(carol.identity.fp)).id;
  await phone.sendText(conv, 'hi carol, from my phone');
  await sync(phone, laptop);
  assert.deepEqual(texts(laptop, conv), ['hi carol, from my phone']);

  await new Promise((r) => setTimeout(r, 5));
  await phone.removeContact(carol.identity.fp);
  await phone.setName('Robert');
  await laptop.mergeOwnDevice(phone.ownDeviceSummary());
  assert.equal(laptop.isContact(carol.identity.fp), false, 'removal propagates');
  assert.equal(laptop.identity.name, 'Robert');
  // A stale summary from before the removal doesn't resurrect the contact.
  await phone.mergeOwnDevice(laptop.ownDeviceSummary());
  assert.equal(phone.isContact(carol.identity.fp), false);
});

test('contact links carry an invite token that can be reset and is shared by own devices', async () => {
  const alice = await user('Alice');
  const bob = await user('Bob');
  const link = alice.myLinkPayload();
  assert.ok(alice.checkInvite(link.i));
  await bob.addContact(link);
  assert.equal(bob.contacts.get(alice.identity.fp).invite, link.i, 'Bob presents it until connected');
  assert.ok(!('i' in bob.contacts.get(alice.identity.fp).card), 'token is not part of the stored card');
  await bob.clearInvite(alice.identity.fp);
  assert.equal(bob.contacts.get(alice.identity.fp).invite, undefined);

  const phone = await cloneDevice(alice);
  assert.ok(phone.checkInvite(link.i), 'a linked device accepts the same link');
  await new Promise((r) => setTimeout(r, 5));
  await phone.resetInvite();
  assert.equal(phone.checkInvite(link.i), false);
  await alice.mergeOwnDevice(phone.ownDeviceSummary());
  assert.equal(alice.checkInvite(link.i), false, 'reset propagates to the other device');
  assert.ok(alice.checkInvite(phone.myLinkPayload().i));
});
