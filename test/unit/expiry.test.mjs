import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';

const DAY = 86400000;
let clock = Date.now();

async function user(name) {
  const e = new Engine(new MemoryStore());
  e.now = () => clock;
  await e.createIdentity(name);
  return e;
}

async function pair() {
  const a = await user('A'), b = await user('B');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await b.directConv(a.identity.fp);
  return { a, b, conv };
}

/** One sync session; returns how many ops crossed the wire. */
async function sync(x, y) {
  let sent = 0;
  for (const [p, q] of [[x, y], [y, x]]) {
    for (const conv of p.sharedConvs(q.identity.fp)) {
      for (const env of p.missingFor(conv, q.vv(conv))) { sent++; await q.ingest(structuredClone(env), p.identity.fp); }
    }
  }
  return sent;
}

const texts = (e, conv) => e.views.get(conv).list().map((m) => m.text);

test('expired messages are deleted, leaving one signed watermark per author', async () => {
  clock = Date.now();
  const { a, b, conv } = await pair();
  for (let i = 0; i < 5; i++) await a.sendText(conv, 'old ' + i);
  await sync(a, b);
  clock += 366 * DAY;
  await a.sendText(conv, 'fresh');
  await a.prune(); await b.prune();
  assert.deepEqual(texts(a, conv), ['fresh']);
  assert.deepEqual(texts(b, conv), []);
  assert.equal((await a.store.all('ops')).length, 2, 'watermark + fresh op');
  assert.equal(a.logs.get(conv).floor(a.identity.fp), 5);
  await sync(a, b);
  assert.deepEqual(texts(b, conv), ['fresh']);
  assert.equal(await sync(a, b), 0, 'nothing expired is resent');
});

test('a peer away longer than the retention period skips straight past the expired history', async () => {
  clock = Date.now();
  const { a, b, conv } = await pair();
  await a.sendText(conv, 'seen by B');
  await sync(a, b);
  // B goes away for more than a year; A keeps talking.
  for (let i = 0; i < 20; i++) await a.sendText(conv, 'missed ' + i);
  clock += 400 * DAY;
  await a.sendText(conv, 'after the gap');
  await a.prune(); await b.prune();
  const sent = await sync(a, b);
  assert.equal(sent, 2, 'only the watermark and the live op are transferred');
  assert.deepEqual(texts(b, conv), ['after the gap']);
  assert.deepEqual(a.vv(conv), b.vv(conv));
  assert.equal(await sync(a, b), 0);
  // B's new messages still get fresh sequence numbers above the floor.
  const env = await b.sendText(conv, 'reply');
  assert.equal(env.seq, 1);
  await sync(b, a);
  assert.deepEqual(texts(a, conv), ['after the gap', 'reply']);
});

test('a group fixes its retention at creation; membership and name never expire', async () => {
  clock = Date.now();
  const a = await user('A'), b = await user('B'), c = await user('C');
  for (const x of [b, c]) { await a.addContact(x.identity.card()); await x.addContact(a.identity.card()); }
  const g = await a.createGroup('Weekly', [b.identity.fp, c.identity.fp], 7);
  await a.sendText(g.id, 'short-lived');
  await sync(a, b);
  assert.equal(b.convs.get(g.id).retentionDays, 7, 'B learned the agreed retention from the signed group op');
  clock += 8 * DAY;
  await a.prune();
  assert.deepEqual(texts(a, g.id), []);
  // C joins the conversation late: still learns the group, its name and members, but not the expired message.
  await sync(a, c);
  assert.equal(c.views.get(g.id).name, 'Weekly');
  assert.deepEqual(c.convs.get(g.id).members, g.members);
  assert.deepEqual(texts(c, g.id), []);
});

test('reload rebuilds floors from stored watermarks', async () => {
  clock = Date.now();
  const store = new MemoryStore();
  const a = new Engine(store); a.now = () => clock; await a.createIdentity('A');
  const b = await user('B');
  await a.addContact(b.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await a.sendText(conv, 'x'); await a.sendText(conv, 'y');
  clock += 366 * DAY;
  await a.sendText(conv, 'z');
  const a2 = new Engine(store); a2.now = () => clock;
  await a2.load();
  assert.deepEqual(texts(a2, conv), ['z']);
  assert.equal(a2.logs.get(conv).floor(a.identity.fp), 2);
  const next = await a2.sendText(conv, 'w');
  assert.equal(next.seq, 4);
  assert.ok(next.ts >= clock);
});

test('ops stamped far in the future are rejected', async () => {
  clock = Date.now();
  const { a, b, conv } = await pair();
  clock += 3 * DAY; // A's clock runs ahead
  const env = await a.sendText(conv, 'from the future');
  clock -= 3 * DAY;
  assert.equal((await b.ingest(structuredClone(env))).reason, 'timestamp in the future');
});
