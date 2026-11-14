// Service worker: precaches the whole app so it runs with the site unreachable.
// The deploy workflow replaces __BUILD__ with the commit SHA, so every deploy is a
// new cache and old ones are deleted once the new worker activates.

const VERSION = '__BUILD__';
const CACHE = 'iwt-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/core/crdt.js',
  'js/core/crypto.js',
  'js/core/encoding.js',
  'js/core/engine.js',
  'js/core/fetch.js',
  'js/core/files.js',
  'js/core/link.js',
  'js/core/net.js',
  'js/core/peer.js',
  'js/core/schnorr.js',
  'js/core/signaling.js',
  'js/core/store.js',
  'js/core/topics.js',
  'js/vendor/qrcode.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // First install: activate immediately. Updates wait for the user to accept.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('iwt-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      if (VERSION === '__' + 'BUILD__') {
        try { return await fetch(req); } catch {}
      }
      return (await cache.match('index.html')) || fetch(req);
    }
    if (VERSION === '__' + 'BUILD__') {
      // Undeployed dev copy: prefer the network so edits show up, fall back to cache.
      try { return await fetch(req); } catch { return (await cache.match(req, { ignoreSearch: true })) || Response.error(); }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

// ---------------------------------------------------------------- background mailbox check
//
// Chromium can wake an *installed* PWA with Periodic Background Sync. The browser decides
// how often (based on engagement, typically a few times a day at most), so this is
// best-effort. The worker never decrypts anything: it copies still-encrypted events from the
// user's OWN mailbox relays into IndexedDB and shows a content-free notification. The app
// verifies, decrypts and merges them the next time it opens.

const MAIL_KIND = 4050;
const MAIL_TTL_S = 7 * 86400;
// Anyone holding the user's card can post to their mailbox, so bound what a wake-up stores.
const MAX_INBOX = 500;              // events held for the app to process
const MAX_EVENT_CHARS = 512 * 1024; // larger than any mail the app sends

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'iwt-mailbox') event.waitUntil(checkMailbox());
});

function openDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('iwt');
    req.onupgradeneeded = (e) => { if (e.oldVersion === 0) req.transaction.abort(); }; // no app data yet
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db.objectStoreNames.contains('inbox') ? db : (db.close(), null));
    };
    req.onerror = () => resolve(null);
  });
}

function idb(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}

function fetchRelay(url, filters, ms = 15000) {
  return new Promise((resolve) => {
    const events = [];
    let ws;
    const sub = 'bg' + Math.random().toString(36).slice(2, 8);
    const done = () => { clearTimeout(t); try { ws.close(); } catch {} resolve(events); };
    const t = setTimeout(done, ms);
    try { ws = new WebSocket(url); } catch { return done(); }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, ...filters]));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === 'EVENT' && msg[1] === sub && msg[2] && msg[2].kind === MAIL_KIND && events.length < MAX_INBOX) events.push(msg[2]);
      if (msg[0] === 'EOSE' && msg[1] === sub) done();
    };
    ws.onerror = done;
  });
}

async function checkMailbox() {
  // If the app is open it is already listening live.
  const windows = await self.clients.matchAll({ type: 'window' });
  if (windows.some((c) => c.visibilityState === 'visible')) return;
  const db = await openDB();
  if (!db) return;
  try {
    const bg = await idb(db, 'kv', 'readonly', (s) => s.get('bg'));
    const relays = (bg && bg.mailboxRelays) || [];
    // The app works out which topics mail for us can arrive on (they derive from secrets the
    // worker never sees) and leaves the list here.
    const topics = ((bg && bg.mailTopics) || []).filter((t) => typeof t === 'string').slice(0, 2000);
    if (!relays.length || !topics.length) return;
    const floor = Math.floor(Date.now() / 1000) - MAIL_TTL_S;
    const since = Math.max(floor, (bg.mailSince || 0) - 3600);
    const filters = [];
    for (let i = 0; i < topics.length; i += 400) filters.push({ kinds: [MAIL_KIND], '#t': topics.slice(i, i + 400), since });
    const batches = await Promise.all(relays.map((u) => fetchRelay(u, filters)));
    let fresh = 0;
    let held = (await idb(db, 'inbox', 'readonly', (s) => s.count())) || 0;
    for (const ev of batches.flat()) {
      if (held >= MAX_INBOX) break;
      if (typeof ev.id !== 'string' || ev.id.length > 64 || typeof ev.content !== 'string' || ev.content.length > MAX_EVENT_CHARS) continue;
      if (await idb(db, 'inbox', 'readonly', (s) => s.get(ev.id))) continue;
      // Keep only the fields the app reads.
      await idb(db, 'inbox', 'readwrite', (s) => s.put({ id: ev.id, kind: ev.kind, content: ev.content, created_at: ev.created_at }, ev.id));
      held++;
      if (ev.created_at > (bg.mailSince || 0)) fresh++;
    }
    if (fresh && bg.notifications && self.Notification && Notification.permission === 'granted') {
      await self.registration.showNotification('Walkie-Talkie', {
        body: 'You have new encrypted messages. Open the app to read them.',
        tag: 'iwt-mailbox', icon: 'icons/icon-192.png', data: {},
      });
    }
  } finally {
    db.close();
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conv = event.notification.data?.conv;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (conv) client.postMessage({ type: 'open-conv', conv });
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
