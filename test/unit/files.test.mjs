// Attachments: encrypted chunk storage, authenticated transfer, relaying, clean-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../public/js/core/engine.js';
import { MemoryStore } from '../../public/js/core/store.js';
import { CHUNK, MAX_FILE_BYTES, chunkCount, inlineKind, cleanFileMeta } from '../../public/js/core/files.js';

async function user(name, store = new MemoryStore()) {
  const e = new Engine(store);
  await e.createIdentity(name);
  return e;
}

async function sync(x, y) {
  for (const [p, q] of [[x, y], [y, x]]) {
    for (const conv of p.sharedConvs(q.identity.fp)) {
      for (const env of p.missingFor(conv, q.vv(conv))) await q.ingest(structuredClone(env), p.identity.fp);
    }
  }
}

/** What the fetcher does over a DataChannel: ask `from` for every chunk `to` is missing. */
async function transfer(from, to) {
  for (const { file, missing } of to.incompleteFiles()) {
    if (!from.canServe(file.id, to.identity.fp)) continue;
    for (const i of missing) {
      const ct = await from.readChunk(file.id, i);
      if (ct) await to.putChunk(file.id, i, structuredClone(ct));
    }
  }
}

const bytes = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

async function pair() {
  const a = await user('Alice'), b = await user('Bob');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  return { a, b, conv };
}

test('a multi-chunk file arrives intact; storage holds only ciphertext', async () => {
  const store = new MemoryStore();
  const a = await user('Alice'), b = await user('Bob', store);
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  const data = bytes(CHUNK * 2 + 123);
  await a.sendFile(conv, { bytes: data, name: 'report.pdf', mime: 'application/pdf', caption: 'the report' });

  await sync(a, b);
  const m = b.views.get(conv).list()[0];
  assert.equal(m.text, 'the report');
  assert.equal(m.file.name, 'report.pdf');
  assert.equal(m.file.size, data.length);
  assert.equal(b.hasFile(m.file.id), false);
  assert.equal(b.incompleteFiles()[0].missing.length, 3);

  await transfer(a, b);
  assert.equal(b.hasFile(m.file.id), true);
  assert.deepEqual(await b.readFile(m.file.id), data);
  assert.deepEqual(b.incompleteFiles(), []);

  // Encrypted at rest: no run of the plaintext appears in stored chunks.
  const needle = Buffer.from(data.subarray(1000, 1064)).toString('hex');
  for (const ct of await store.all('blobs')) assert.ok(!Buffer.from(ct).toString('hex').includes(needle));

  // Survives a reload.
  const b2 = new Engine(store); await b2.load();
  assert.deepEqual(await b2.readFile(m.file.id), data);
});

test('tampered, swapped or foreign chunks are rejected', async () => {
  const { a, b, conv } = await pair();
  await a.sendFile(conv, { bytes: bytes(CHUNK + 10), name: 'x.bin', mime: 'application/octet-stream' });
  await a.sendFile(conv, { bytes: bytes(50, 9), name: 'y.bin', mime: 'application/octet-stream' });
  await sync(a, b);
  const [f1, f2] = b.views.get(conv).list().map((m) => m.file);
  const c0 = await a.readChunk(f1.id, 0), c1 = await a.readChunk(f1.id, 1);
  const bad = Uint8Array.from(c0); bad[5] ^= 1;
  assert.equal(await b.putChunk(f1.id, 0, bad), false, 'bit flip');
  assert.equal(await b.putChunk(f1.id, 0, c1), false, 'chunk from another position');
  assert.equal(await b.putChunk(f2.id, 0, c0), false, "another file's chunk");
  assert.equal(await b.putChunk(f1.id, 7, c0), false, 'out of range');
  assert.equal(await b.putChunk('A'.repeat(22), 0, c0), false, 'unknown file');
  assert.equal(await b.putChunk(f1.id, 0, c0), true);
  assert.equal(await b.putChunk(f1.id, 0, c0), false, 'duplicate');
});

test('a group member relays a file to someone who never meets the sender', async () => {
  const a = await user('A'), b = await user('B'), c = await user('C');
  for (const x of [b, c]) { await a.addContact(x.identity.card()); await x.addContact(a.identity.card()); }
  const g = await a.createGroup('G', [b.identity.fp, c.identity.fp]);
  await sync(a, b);
  const data = bytes(1000);
  await b.sendFile(g.id, { bytes: data, name: 'pic.webp', mime: 'image/webp' });
  await sync(b, a); await transfer(b, a);
  await sync(a, c); await transfer(a, c);
  const id = c.views.get(g.id).list()[0].file.id;
  assert.deepEqual(await c.readFile(id), data);

  // Only members (or our own devices) get served.
  const m = await user('Mallory');
  assert.equal(a.canServe(id, m.identity.fp), false);
  assert.equal(a.canServe(id, a.identity.fp), true);
});

test('chunks are deleted with the message: deleted for everyone, for me, or expired', async () => {
  const store = new MemoryStore();
  const a = await user('Alice', store), b = await user('Bob');
  await a.addContact(b.identity.card()); await b.addContact(a.identity.card());
  const conv = (await a.directConv(b.identity.fp)).id;
  await a.sendFile(conv, { bytes: bytes(10), name: '1', mime: 'text/plain' });
  await a.sendFile(conv, { bytes: bytes(10), name: '2', mime: 'text/plain' });
  await b.sendText(conv, 'x');
  await sync(a, b);
  await b.sendFile(conv, { bytes: bytes(10), name: '3', mime: 'text/plain' });
  await sync(a, b); await transfer(b, a);
  assert.equal((await store.keys('blobs')).length, 3);

  const byName = (n) => a.views.get(conv).list().find((m) => m.file?.name === n);
  const [m1, m3] = [byName('1'), byName('3')];
  const id1 = m1.file.id;
  await a.deleteMessage(conv, m1.id);
  assert.equal(a.hasFile(id1), false);
  assert.equal((await store.keys('blobs')).length, 2);
  await a.forgetMessages(conv, [m3.id]);
  assert.equal((await store.keys('blobs')).length, 1);

  a.now = () => Date.now() + 400 * 86400000; // past the 1-year retention
  await a.prune();
  assert.equal((await store.keys('blobs')).length, 0, 'expired');
});

test('file metadata is validated', () => {
  const ok = { id: 'A'.repeat(22), key: 'B'.repeat(43), name: 'a/b\u0000.txt', mime: 'Text/Plain', size: 5 };
  assert.deepEqual(cleanFileMeta(ok), { id: ok.id, key: ok.key, name: 'ab.txt', mime: 'text/plain', size: 5 });
  assert.equal(cleanFileMeta({ ...ok, size: MAX_FILE_BYTES + 1 }), null);
  assert.equal(cleanFileMeta({ ...ok, mime: 'text/html; x' }), null);
  assert.equal(cleanFileMeta({ ...ok, thumb: 'data:text/html;base64,AAAA' }).thumb, undefined);
  assert.equal(chunkCount(CHUNK), 1);
  assert.equal(chunkCount(CHUNK + 1), 2);
  assert.equal(inlineKind('image/svg+xml'), null, 'SVG is never shown inline');
  assert.equal(inlineKind('text/html'), null);
  assert.equal(inlineKind('image/png'), 'image');
});

test('size limit and empty files', async () => {
  const { a, conv } = await pair();
  assert.throws(() => a.sendFile(conv, { bytes: new Uint8Array(MAX_FILE_BYTES + 1), name: 'big', mime: 'application/zip' }), /at most/);
  assert.throws(() => a.sendFile(conv, { bytes: new Uint8Array(0), name: 'e', mime: 'text/plain' }), /Empty/);
});
