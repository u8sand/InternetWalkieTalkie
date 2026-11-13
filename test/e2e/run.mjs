// End-to-end test in real Chromium: three users, relay-signalled and manual WebRTC
// connections, offline catch-up, store-and-forward through the recipient's own mailbox
// relay (live and via a background Periodic Sync wake-up), group gossip, and running from
// the service-worker cache with the web server shut down.
//
//   node test/e2e/run.mjs            (SHOTS=dir to save screenshots)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { serve } from '../serve.mjs';
import { startRelay } from '../relay.mjs';

// Resolved via require so a globally installed Playwright (NODE_PATH) also works.
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const WEB = 8080, RELAY = 7777, MAILBOX = 7778;
const MAIL_KIND = 4050;
const URL_ = `http://127.0.0.1:${WEB}/`;
const SHOTS = process.env.SHOTS;

const step = (s) => console.log('•', s);
let server = await serve(WEB, { build: 'e2e-' + Date.now() });
const relay = await startRelay(RELAY);          // stands in for a public relay
const bobsRelay = await startRelay(MAILBOX);    // a relay Bob runs himself
// channel 'chromium' = full headless Chromium; the lighter headless shell can't show notifications.
const browser = await chromium.launch({ channel: 'chromium', args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });

const users = [];
async function newUser(name, { relays = [`ws://127.0.0.1:${RELAY}`], mailbox = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'notifications']);
  if (process.env.IWT_DEBUG) await ctx.addInitScript(() => { globalThis.IWT_DEBUG = true; });
  await ctx.addInitScript(() => addEventListener('unhandledrejection', (e) => console.error('unhandled rejection:', String(e.reason?.stack || e.reason))));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] pageerror`, e));
  page.on('crash', () => console.error(`[${name}] page CRASHED`));
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
  await page.fill('textarea[aria-label="Mailbox relays"]', mailbox.join('\n'));
  if (mailbox.length) await page.check('dialog input[type=checkbox]'); // notifications
  await page.click('text=Save settings');
  await page.waitForFunction(() => !document.getElementById('dialog').open); // save handler finished
  await page.evaluate(() => navigator.serviceWorker.ready);
  const u = { name, ctx, page };
  users.push(u);
  return u;
}

/** The contact link exactly as the "Invite someone" screen shows it. */
async function link(u) {
  await u.page.click('#btnAdd');
  const url = await u.page.inputValue('input[aria-label="Your link"]');
  await u.page.click('dialog button[aria-label=Close]');
  return url;
}

const fp = (u) => u.page.evaluate(() => window.__iwt.engine.identity.fp);

async function reopen(u) {
  u.page = await u.ctx.newPage();
  u.page.on('pageerror', (e) => console.error(`[${u.name}] pageerror`, e));
  u.page.on('crash', () => console.error(`[${u.name}] page CRASHED`));
  u.page.on('console', (m) => { if (m.type() === 'error' || process.env.IWT_DEBUG) console.error(`[${u.name}]`, m.text()); });
  await u.page.goto(URL_);
  await u.page.waitForSelector('#main:not([hidden])');
}

const until = async (fn, ms = 20000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 200)); }
};

async function openChatWith(u, title) {
  if (await u.page.isVisible('#btnBack')) await u.page.click('#btnBack'); // phone layout: back to the list
  await u.page.click('.tabs [data-tab=chats]');
  await u.page.click(`#convList li:has(.title span:text-is("${title}"))`);
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
  const bob = await newUser('Bob', { mailbox: [`ws://127.0.0.1:${MAILBOX}`] });

  step("Bob opens the link Alice shared; they're connected, nothing to approve");
  await alice.page.click('#btnAdd');
  await shot(alice, '1-invite');
  await alice.page.click('dialog button[aria-label=Close]');
  const aliceLink = await link(alice);
  await bob.page.goto(aliceLink);
  await bob.page.waitForSelector('#main:not([hidden])');
  await bob.page.click('dialog button.primary:has-text("Add Alice")');
  await alice.page.waitForSelector('#toast:has-text("Bob added you from your link")', { timeout: 30000 });
  assert.equal(await alice.page.evaluate(() => window.__iwt.engine.requests.size), 0, 'no request to accept');

  step('they connect over WebRTC via the relay');
  const bobFp = await fp(bob), aliceFp = await fp(alice);
  await alice.page.waitForFunction((f) => window.__iwt.net.isOnline(f), bobFp, { timeout: 45000 });
  await bob.page.waitForFunction((f) => window.__iwt.net.isOnline(f), aliceFp, { timeout: 45000 });

  if (process.env.E2E_STOP === 'connect') throw Object.assign(new Error('stopped early (E2E_STOP)'), { early: true });
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

  step("never online together: Alice's message waits on Bob's own mailbox relay");
  await bob.page.close();
  await alice.page.waitForFunction((f) => !window.__iwt.net.isOnline(f), bobFp, { timeout: 30000 });
  const mailed = () => bobsRelay.stats.kinds[MAIL_KIND] || 0;
  let before = mailed();
  await send(alice, 'Left in your mailbox');
  await until(() => mailed() > before, 20000, 'mail on Bob\'s relay');
  await alice.page.close();                     // Alice is gone before Bob returns
  await reopen(bob);
  await openChatWith(bob, 'Alice');
  await expectMsg(bob, 'Left in your mailbox', 20000);
  const mailWire = bobsRelay.stats.log.join('\n');
  assert.ok(!mailWire.includes('Left in your mailbox') && !mailWire.includes(aliceFp), 'mailbox relay holds only ciphertext');

  step('background wake-up: the service worker fetches mail while the app is closed and notifies');
  await bob.page.close();
  await reopen(alice);
  await openChatWith(alice, 'Bob');
  before = mailed();
  await send(alice, 'Fetched in the background');
  await until(() => mailed() > before, 20000, 'second mail');
  await alice.page.close();
  const blank = await bob.ctx.newPage();        // not same-origin: the app itself stays closed
  const cdp = await bob.ctx.newCDPSession(blank);
  const regs = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await until(() => regs.some((r) => r.scopeURL === URL_), 10000, 'SW registration');
  const registrationId = regs.find((r) => r.scopeURL === URL_).registrationId;
  await cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin: URL_.slice(0, -1), registrationId, tag: 'iwt-mailbox' });
  let bgState;
  await until(async () => {
    const sw = bob.ctx.serviceWorkers().find((w) => w.url().startsWith(URL_));
    if (!sw) return false;
    bgState = await sw.evaluate(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open('iwt'); q.onsuccess = () => r(q.result); });
      const n = await new Promise((r) => { const q = db.transaction('inbox').objectStore('inbox').count(); q.onsuccess = () => r(q.result); });
      const bg = await new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get('bg'); q.onsuccess = () => r(q.result); });
      db.close();
      return { inbox: n, notifications: (await self.registration.getNotifications()).map((x) => x.body), perm: Notification.permission, bg };
    });
    return bgState.inbox > 0 && bgState.notifications.length > 0;
  }, 20000, 'background fetch + notification').catch((e) => { console.error('SW state:', bgState, 'workers:', bob.ctx.serviceWorkers().map((w) => w.url())); throw e; });
  assert.ok(!bgState.notifications.join().includes('Fetched in the background'), 'notification reveals no content');
  await blank.close();
  await reopen(bob);
  await openChatWith(bob, 'Alice');
  await expectMsg(bob, 'Fetched in the background', 20000);
  assert.equal(await bob.page.evaluate(async () => (await window.__iwt.engine.store.all('inbox')).length), 0, 'inbox drained');
  await reopen(alice);

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
  // Relaying through Alice needs her connected to both (Bob and Alice just reopened their apps).
  await alice.page.waitForFunction((f) => window.__iwt.net.isOnline(f), bobFp, { timeout: 45000 })
    .catch(() => { throw new Error('Alice and Bob did not reconnect within 45s of reopening'); });
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

  step("Bob links his phone by opening the QR link; it gets his identity and full history");
  await bob.page.click('#btnSettings');
  await bob.page.click('text=Link a new device…');
  const linkUrl = await bob.page.inputValue('input[aria-label="Device link"]');
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await phoneCtx.grantPermissions(['notifications']);
  const phone = { name: 'Bob-phone', ctx: phoneCtx, page: await phoneCtx.newPage() };
  users.push(phone);
  phone.page.on('pageerror', (e) => console.error('[Bob-phone] pageerror', e));
  phone.page.on('console', (m) => { if (m.type() === 'error' || process.env.IWT_DEBUG) console.error('[Bob-phone]', m.text()); });
  await phone.page.goto(linkUrl);                   // what scanning the QR code does
  await bob.page.waitForSelector('dialog :text("Linked. Your new device is ready.")', { timeout: 40000 });
  await shot(bob, '6-link-host');
  await phone.page.waitForSelector('#main:not([hidden])', { timeout: 20000 });
  assert.equal(await fp(phone), bobFp, 'same identity on the phone');
  const devs = await Promise.all([bob, phone].map((u) => u.page.evaluate(() => window.__iwt.engine.device)));
  assert.notEqual(devs[0], devs[1], 'but a distinct device id');
  await bob.page.click('dialog button[aria-label=Close]');
  await openChatWith(phone, 'Walkie crew');
  await expectMsg(phone, 'Bob says hi to the group');
  await shot(phone, '7-phone-history');

  step("the phone and laptop sync with each other, and both chat as Bob");
  await phone.page.waitForFunction((f) => window.__iwt.net.devicesOf(f).length > 0, bobFp, { timeout: 40000 });
  await send(phone, 'Bob, now on his phone');
  await expectMsg(carol, 'Bob, now on his phone', 30000);
  await expectMsg(bob, 'Bob, now on his phone', 30000);
  await openChatWith(alice, 'Bob');
  await send(alice, 'Reaches both of your devices');
  await openChatWith(phone, 'Alice');
  await expectMsg(phone, 'Reaches both of your devices', 30000);
  await openChatWith(bob, 'Alice');
  await expectMsg(bob, 'Reaches both of your devices', 30000);
  await openChatWith(alice, 'Walkie crew');
  await openChatWith(bob, 'Walkie crew');

  step('all replicas, including both of Bob\'s devices, converge on identical history');
  const history = (u) => u.page.evaluate(() => {
    const e = window.__iwt.engine;
    const g = [...e.convs.values()].find((c) => c.kind === 'group');
    return e.views.get(g.id).list().map((m) => m.author.slice(0, 6) + ':' + m.text);
  });
  await alice.page.waitForTimeout(1000);
  const [ha, hb, hc, hp] = await Promise.all([history(alice), history(bob), history(carol), history(phone)]);
  assert.deepEqual(ha, hb);
  assert.deepEqual(hb, hc);
  assert.deepEqual(hc, hp);
  assert.equal(ha.length, 4);

  step('a brand-new person opens Alice\'s link: setup says who invited them, then they\'re connected');
  const daveCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const dave = { name: 'Dave', ctx: daveCtx, page: await daveCtx.newPage() };
  users.push(dave);
  dave.page.on('pageerror', (e) => console.error('[Dave] pageerror', e));
  await dave.page.goto(aliceLink);                // e.g. tapped in a text message
  await dave.page.waitForSelector('#onboardInvite:has-text("Alice invited you to chat")');
  await shot(dave, '8-invited-onboarding');
  await dave.page.fill('#onboardName', 'Dave');
  await dave.page.click('#onboardForm button[type=submit]');
  await dave.page.waitForSelector('#chatTitle:has-text("Alice")', { timeout: 15000 });
  await dave.page.evaluate((r) => window.__iwt.engine.saveSettings({ relays: [r], iceServers: [] }), `ws://127.0.0.1:${RELAY}`);
  await alice.page.waitForSelector('#toast:has-text("Dave added you from your link")', { timeout: 30000 });
  await send(dave, 'Hi Alice, Dave here');
  await openChatWith(alice, 'Dave');
  await expectMsg(alice, 'Hi Alice, Dave here', 30000);

  step('after Alice resets her link, the old one only produces a contact request');
  await alice.page.click('#btnSettings');
  alice.page.once('dialog', (d) => d.accept());
  await alice.page.click('text=Reset my contact link');
  await alice.page.click('dialog button[aria-label=Close]').catch(() => {});
  const erin = await newUser('Erin');
  await erin.page.goto(aliceLink);                // the stale link
  await erin.page.waitForSelector('#main:not([hidden])');
  await erin.page.click('dialog button.primary:has-text("Add Alice")');
  await alice.page.waitForSelector('#reqBadge:not([hidden])', { timeout: 30000 });
  assert.equal(await alice.page.evaluate(() => window.__iwt.engine.requests.size), 1);
  assert.notEqual(await link(alice), aliceLink, 'Alice now shares a different link');

  step('nothing readable is stored at rest');
  const leaked = await alice.page.evaluate(async () => {
    const all = await window.__iwt.engine.store.all('ops');
    return JSON.stringify(all).includes('Welcome to the crew');
  });
  assert.equal(leaked, false);

  step('relay saw only opaque, validly signed events (no names, keys, fingerprints or SDP)');
  assert.ok(relay.stats.events > 0 && relay.stats.rejected === 0, 'relay accepted our Schnorr-signed events');
  assert.deepEqual(Object.keys(relay.stats.kinds), ['25050'], 'public relay only ever saw ephemeral events: nothing to store');
  const wire = relay.stats.log.join('\n');
  // Structural check: every event is an opaque base64url blob with only a hashed topic tag.
  // (Short substrings like "Bob" occur by chance inside ~60 KB of random base64, so we
  // check shape instead, plus long markers that can't occur by chance.)
  for (const ev of relay.stats.log.map((l) => JSON.parse(l))) {
    assert.match(ev.content, /^[A-Za-z0-9_-]+$/, 'content is a single opaque base64url blob');
    assert.deepEqual(ev.tags.map((t) => t[0]), ['t'], 'only a topic tag');
    assert.match(ev.tags[0][1], /^[0-9a-f]{32}$/, 'topic is a hash');
  }
  for (const needle of [aliceFp, bobFp, 'a=fingerprint', 'candidate:', '"type":"hello"', '"card"']) {
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
      console.error(`--- ${u.name} net:`, JSON.stringify(await u.page.evaluate(() => {
        const n = window.__iwt.net;
        return { relays: n.pool.status(), peers: [...n.peers.keys()].map((k) => k.slice(0, 8)), pending: [...n.pending.values()].map((p) => [p.fp?.slice(0, 8), p.state, Date.now() - p.createdAt, p.pc.connectionState, p.pc.signalingState]), contacts: [...window.__iwt.engine.contacts.keys()].map((k) => k.slice(0, 8)), requests: window.__iwt.engine.requests.size };
      })));
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
  await bobsRelay.close();
  server.close?.();
}
