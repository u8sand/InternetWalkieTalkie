// Runs the Worker in Cloudflare's local runtime (wrangler dev / workerd) and checks it behaves
// like relay/server.mjs: forwarding, mailbox storage, refusing other events, and TURN
// credentials (against a stand-in for Cloudflare's TURN API).
//
//   cd worker && npm install && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { randomSecret, publicKey, nostrEvent } from '../../public/js/core/schnorr.js';
import { hex } from '../../public/js/core/encoding.js';
import { fetchTurn } from '../../public/js/core/signaling.js';
import { parseIceServers } from '../../public/js/core/peer.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8787, TURN_API = 8799;
const URL_ = `ws://127.0.0.1:${PORT}`;
let wrangler, turnApi, turnCalls = [];

const secret = randomSecret(), pub = hex(publicKey(secret));
const event = (kind, topic, content = 'b3BhcXVl', extra = []) => nostrEvent(secret, pub, kind, [['t', topic], ...extra], content);

before(async () => {
  // A stand-in for rtc.live.cloudflare.com: the response shape from Cloudflare's docs.
  turnApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      turnCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (req.headers.authorization !== 'Bearer test-token') return res.writeHead(401).end();
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
          'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'cf-user', credential: 'cf-pass' },
      ] }));
    });
  });
  await new Promise((r) => turnApi.listen(TURN_API, '127.0.0.1', r));
  fs.writeFileSync(path.join(DIR, '.dev.vars'),
    `TURN_KEY_ID=test-key\nTURN_KEY_API_TOKEN=test-token\nACCESS_CODE=code\nTURN_API_BASE=http://127.0.0.1:${TURN_API}\n`);
  fs.rmSync(path.join(DIR, '.wrangler', 'state'), { recursive: true, force: true }); // fresh storage
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  wrangler.stdout.on('data', (d) => { log += d; });
  wrangler.stderr.on('data', (d) => { log += d; });
  const t = Date.now();
  while (!/Ready on/.test(log)) {
    if (Date.now() - t > 90000) throw new Error('wrangler dev did not start:\n' + log);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  try { process.kill(-wrangler.pid); } catch {}
  turnApi.close();
  fs.rmSync(path.join(DIR, '.dev.vars'), { force: true });
});

async function client() {
  const ws = new WebSocket(URL_);
  const got = [];
  ws.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const wait = async (pred, ms = 5000) => {
    const t = Date.now();
    for (;;) {
      const hit = got.find(pred);
      if (hit) return hit;
      if (Date.now() - t > ms) throw new Error('timed out; got ' + JSON.stringify(got).slice(0, 300));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { got, wait, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

test('HTTP: a plain page and NIP-11 information', async () => {
  assert.match(await (await fetch(`http://127.0.0.1:${PORT}/`)).text(), /Walkie-Talkie relay/);
  const info = await (await fetch(`http://127.0.0.1:${PORT}/`, { headers: { accept: 'application/nostr+json' } })).json();
  assert.deepEqual(info.supported_nips, [1, 11, 40]);
});

test('forwards signalling without storing it; stores and replays mail', async () => {
  const a = await client(), b = await client();
  b.send(['REQ', 's', { kinds: [25050, 4050], '#t': ['topic-b'] }]);
  await b.wait((m) => m[0] === 'EOSE');
  const sig = await event(25050, 'topic-b');
  a.send(['EVENT', sig]);
  assert.equal((await a.wait((m) => m[0] === 'OK' && m[1] === sig.id))[2], true);
  await b.wait((m) => m[0] === 'EVENT' && m[2].id === sig.id);

  const mail = await event(4050, 'topic-b', 'bWFpbA', [['expiration', String(Math.floor(Date.now() / 1000) + 3600)]]);
  a.send(['EVENT', mail]);
  await b.wait((m) => m[0] === 'EVENT' && m[2].id === mail.id);
  const late = await client();
  late.send(['REQ', 'x', { kinds: [25050, 4050], '#t': ['zzz', 'topic-b'] }]);
  await late.wait((m) => m[0] === 'EOSE');
  assert.deepEqual(late.got.filter((m) => m[0] === 'EVENT').map((m) => m[2].id), [mail.id], 'mail replayed, signal not');
  late.send(['REQ', 'z', { kinds: [4050], '#t': ['topic-b'], since: mail.created_at + 10 }]);
  await late.wait((m) => m[0] === 'EOSE' && m[1] === 'z');
  assert.equal(late.got.filter((m) => m[0] === 'EVENT' && m[1] === 'z').length, 0, 'since is honoured');
  // Sending the same mail again is acknowledged but not delivered twice.
  a.send(['EVENT', mail]);
  await a.wait((m) => m[0] === 'OK' && m[1] === mail.id && a.got.filter((x) => x[0] === 'OK' && x[1] === mail.id).length === 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.got.filter((m) => m[0] === 'EVENT' && m[2].id === mail.id).length, 1);
  // Closed subscriptions stop receiving.
  b.send(['CLOSE', 's']);
  await new Promise((r) => setTimeout(r, 100));
  const after = await event(25050, 'topic-b', 'YWZ0ZXI'); // different content, so a different id
  a.send(['EVENT', after]);
  await a.wait((m) => m[0] === 'OK' && m[1] === after.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!b.got.some((m) => m[0] === 'EVENT' && m[2].id === after.id), JSON.stringify(b.got.map((m) => [m[0], m[1], m[2]?.id?.slice(0, 6)])) + ' after=' + after.id.slice(0, 6));
  for (const c of [a, b, late]) c.close();
});

test('refuses other events, and stored mail cannot be listed without its topic', async () => {
  const c = await client();
  const good = await event(25050, 't1');
  const cases = {
    'other kind': await event(1, 't1', 'a public note'),
    'bad id': { ...good, content: 'tampered' },
    'no topic': await nostrEvent(secret, pub, 25050, [['x', 'y']], 'b3A'),
    'stale': { ...(await event(25050, 't1')), created_at: 1000 },
    'malformed': { id: 'nope' },
  };
  for (const [name, ev] of Object.entries(cases)) {
    const before = c.got.length;
    c.send(['EVENT', ev]);
    const ok = await c.wait((m) => m[0] === 'OK' && c.got.indexOf(m) >= before);
    assert.equal(ok[2], false, name + ' must be refused');
  }
  const mail = await event(4050, 'secret-topic', 'bQ');
  c.send(['EVENT', mail]);
  await c.wait((m) => m[0] === 'OK' && m[1] === mail.id && m[2] === true);
  c.send(['REQ', 'all', {}, { kinds: [4050] }]);
  await c.wait((m) => m[0] === 'EOSE' && m[1] === 'all');
  assert.equal(c.got.filter((m) => m[0] === 'EVENT').length, 0);
  c.close();
});

test('many topics in one subscription (more than one SQL query\'s worth)', async () => {
  const c = await client();
  const topics = Array.from({ length: 250 }, (_, i) => 'many-' + i);
  const mail = await event(4050, 'many-237', 'bWFueQ');
  c.send(['EVENT', mail]);
  await c.wait((m) => m[0] === 'OK' && m[1] === mail.id);
  c.send(['REQ', 'm', { kinds: [4050], '#t': topics }]);
  await c.wait((m) => m[0] === 'EOSE' && m[1] === 'm');
  assert.deepEqual(c.got.filter((m) => m[0] === 'EVENT' && m[1] === 'm').map((m) => m[2].id), [mail.id]);
  c.close();
});

test('TURN: Cloudflare credentials behind the access code, in the form the app uses', async () => {
  const c = await client();
  c.send(['TURN', 'wrong']);
  assert.match((await c.wait((m) => m[0] === 'TURN'))[2], /wrong access code/);
  c.close();
  turnCalls = [];
  const { servers, ttl } = await fetchTurn(URL_, 'code');
  assert.equal(ttl, 12 * 3600);
  assert.equal(turnCalls.length, 1);
  assert.equal(turnCalls[0].url, '/v1/turn/keys/test-key/credentials/generate-ice-servers');
  assert.deepEqual(turnCalls[0].body, { ttl: 12 * 3600 });
  const ice = parseIceServers(servers);
  assert.deepEqual(ice.map((s) => s.urls), [
    'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp']);
  assert.ok(ice.every((s) => s.username === 'cf-user' && s.credential === 'cf-pass'));
  assert.ok(!servers.some((s) => /:53\?/.test(s)), 'port 53 is dropped (browsers block it)');
});

test('per-connection rate limit', async () => {
  const c = await client();
  for (let i = 0; i < 130; i++) c.send(['REQ', 's', { '#t': ['x'] }]);
  await c.wait((m) => m[0] === 'NOTICE' && /rate-limited/.test(m[1]));
  c.close();
});
