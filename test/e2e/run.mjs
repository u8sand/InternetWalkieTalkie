// End-to-end test in real Chromium: three users, relay-signalled and manual WebRTC
// connections, offline catch-up, group gossip, and running from the service-worker cache
// with the web server shut down.
//
//   node test/e2e/run.mjs            (SHOTS=dir to save screenshots)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { serve } from '../serve.mjs';
import { startRelay } from '../relay.mjs';

// Resolved via require so a globally installed Playwright (NODE_PATH) also works.
const { chromium } = createRequire(import.meta.url)('playwright');

const WEB = 8080, RELAY = 7777;
const URL_ = `http://127.0.0.1:${WEB}/`;
const SHOTS = process.env.SHOTS;

const step = (s) => console.log('•', s);
let server = await serve(WEB, { build: 'e2e-' + Date.now() });
const relay = await startRelay(RELAY);
const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });

const users = [];
async function newUser(name, { relays = [`ws://127.0.0.1:${RELAY}`] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL_ });
  if (process.env.IWT_DEBUG) await ctx.addInitScript(() => { globalThis.IWT_DEBUG = true; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] pageerror`, e));
  page.on('console', (m) => { if (m.type() === 'error' || process.env.IWT_DEBUG) console.error(`[${name}]`, m.text()); });
  await page.goto(URL_);
  await page.waitForSelector('#onboard:not([hidden])');
  await page.fill('#onboardName', name);
  await page.click('#onboardForm button[type=submit]');
  await page.waitForSelector('#main:not([hidden])');
  // Point at the local relay, no STUN (loopback only).
  await page.click('#btnSettings');
  await page.fill('textarea[aria-label=Relays]', relays.join('\n'));
  await page.fill('textarea[aria-label="ICE servers"]', '');
  await page.click('text=Save settings');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const u = { name, ctx, page };
  users.push(u);
  return u;
}

const link = (u) => u.page.evaluate(() => {
  const card = window.__iwt.engine.identity.card();
  return location.origin + location.pathname + '#add=' + btoa(JSON.stringify(card)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
});

const fp = (u) => u.page.evaluate(() => window.__iwt.engine.identity.fp);

async function openChatWith(u, title) {
  await u.page.click('.tabs [data-tab=chats]');
  await u.page.click(`#convList li:has-text("${title}")`);
}

async function send(u, text) {
  await u.page.waitForFunction(() => !document.getElementById('dialog').open);
  await u.page.fill('#composerInput', text);
  await u.page.press('#composerInput', 'Enter');
}

const expectMsg = (u, text, timeout = 20000) => u.page.waitForSelector(`#messages .msg:has-text("${text}")`, { timeout });

const shot = async (u, name) => { if (SHOTS) await u.page.screenshot({ path: `${SHOTS}/${name}.png` }); };

try {
  step('create Alice and Bob');
  const alice = await newUser('Alice');
  const bob = await newUser('Bob');

  step('Bob adds Alice from her link; Alice accepts the request');
  await bob.page.click('#btnAdd');
  await bob.page.fill('textarea[aria-label="Contact link"]', await link(alice));
  await bob.page.click('dialog button.primary:has-text("Add contact")');
  await alice.page.waitForSelector('#reqBadge:not([hidden])', { timeout: 30000 });
  await alice.page.click('.tabs [data-tab=contacts]');
  await shot(alice, '1-request');
  await alice.page.click('#contactList li.request >> text=Accept');

  step('they connect over WebRTC via the relay');
  const bobFp = await fp(bob), aliceFp = await fp(alice);
  await alice.page.waitForFunction((f) => window.__iwt.net.isOnline(f), bobFp, { timeout: 30000 });
  await bob.page.waitForFunction((f) => window.__iwt.net.isOnline(f), aliceFp, { timeout: 30000 });

  step('messages flow both ways');
  await send(bob, 'Hi Alice, it is Bob 👋');
  await openChatWith(alice, 'Bob');
  await expectMsg(alice, 'Hi Alice, it is Bob');
  await send(alice, 'Hey Bob! Encrypted and serverless.');
  await expectMsg(bob, 'Hey Bob! Encrypted and serverless.');
  await shot(alice, '2-chat');

  step('Bob goes offline; Alice keeps writing; Bob catches up on return');
  await bob.page.close();
  await alice.page.waitForFunction((f) => !window.__iwt.net.isOnline(f), bobFp, { timeout: 30000 });
  await send(alice, 'Written while you were offline');
  bob.page = await bob.ctx.newPage();
  await bob.page.goto(URL_);
  await bob.page.waitForSelector('#main:not([hidden])');
  await openChatWith(bob, 'Alice');
  await expectMsg(bob, 'Written while you were offline', 40000);

  step('Carol (no relays at all) connects to Alice with manual codes');
  const carol = await newUser('Carol', { relays: [] });
  await alice.page.click('#btnSettings');
  await alice.page.click('text=Direct connection codes…');
  await alice.page.click('text=Create an invite code');
  const offer = await alice.page.inputValue('#manualArea textarea[readonly]');
  await carol.page.click('#btnSettings');
  await carol.page.click('text=Direct connection codes…');
  await carol.page.click('text=I have a code');
  await carol.page.fill('#manualArea textarea', offer);
  await carol.page.click('text=Create reply');
  const reply = await carol.page.inputValue('#manualArea textarea[readonly]', { timeout: 15000 });
  await shot(carol, '3-manual-code');
  await alice.page.fill('#manualArea textarea:not([readonly])', reply);
  await alice.page.click('#manualArea >> text=Connect');
  const carolFp = await fp(carol);
  await alice.page.waitForFunction((f) => window.__iwt.net.isOnline(f), carolFp, { timeout: 30000 });
  await carol.page.waitForSelector('#chatTitle:has-text("Alice")', { timeout: 15000 });
  await send(carol, 'Hello from Carol, no relay needed');
  await alice.page.waitForFunction(() => document.querySelector('#convList')?.textContent.includes('Hello from Carol'), null, { timeout: 15000 });

  step('Alice makes a group; Carol and Bob never met, but sync through Alice');
  await alice.page.click('#btnGroup');
  await alice.page.fill('dialog input[placeholder="Group name"]', 'Walkie crew');
  await alice.page.check(`dialog input[value="${bobFp}"]`);
  await alice.page.check(`dialog input[value="${carolFp}"]`);
  await alice.page.click('text=Create group');
  await alice.page.waitForSelector('#chatTitle:has-text("Walkie crew")');
  await send(alice, 'Welcome to the crew');
  await openChatWith(carol, 'Walkie crew');
  await expectMsg(carol, 'Welcome to the crew');
  await send(carol, 'Carol here, via Alice');
  await openChatWith(bob, 'Walkie crew');
  await expectMsg(bob, 'Carol here, via Alice');
  await send(bob, 'Bob says hi to the group');
  await expectMsg(carol, 'Bob says hi to the group');
  await shot(bob, '4-group');

  step('all three replicas converge on identical history');
  const history = (u) => u.page.evaluate(() => {
    const e = window.__iwt.engine;
    const g = [...e.convs.values()].find((c) => c.kind === 'group');
    return e.views.get(g.id).list().map((m) => m.author.slice(0, 6) + ':' + m.text);
  });
  await alice.page.waitForTimeout(500);
  const [ha, hb, hc] = await Promise.all([history(alice), history(bob), history(carol)]);
  assert.deepEqual(ha, hb);
  assert.deepEqual(hb, hc);
  assert.equal(ha.length, 3);

  step('nothing readable is stored at rest');
  const leaked = await alice.page.evaluate(async () => {
    const all = await window.__iwt.engine.store.all('ops');
    return JSON.stringify(all).includes('Welcome to the crew');
  });
  assert.equal(leaked, false);

  step('relay saw only opaque, validly signed events (no names, keys, fingerprints or SDP)');
  assert.ok(relay.stats.events > 0 && relay.stats.rejected === 0, 'relay accepted our Schnorr-signed events');
  const wire = relay.stats.log.join('\n');
  for (const needle of ['Alice', 'Bob', aliceFp, bobFp, 'a=fingerprint', 'candidate', 'hello']) {
    assert.ok(!wire.includes(needle), `relay saw "${needle}"`);
  }

  step('web server shut down: app still loads from cache, history intact, can still write');
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
  await alice.page.reload();
  await alice.page.waitForSelector('#main:not([hidden])');
  await openChatWith(alice, 'Walkie crew');
  await expectMsg(alice, 'Bob says hi to the group');
  await send(alice, 'Still works with the site down');
  await expectMsg(bob, 'Still works with the site down', 40000);
  await shot(alice, '5-offline-site');

  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e);
  for (const u of users) {
    try {
      if (SHOTS) await u.page.screenshot({ path: `${SHOTS}/fail-${u.name}.png` });
      console.error(`--- ${u.name} state:`, JSON.stringify(await u.page.evaluate(() => {
        const e = window.__iwt.engine;
        return [...e.convs.values()].map((c) => ({ id: c.id.slice(0, 10), kind: c.kind, vv: e.vv(c.id), msgs: e.views.get(c.id).list().map((m) => m.text) }));
      })));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await relay.close();
  server.close?.();
}
