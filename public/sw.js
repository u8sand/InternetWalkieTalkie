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
  'js/core/net.js',
  'js/core/peer.js',
  'js/core/schnorr.js',
  'js/core/signaling.js',
  'js/core/store.js',
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
