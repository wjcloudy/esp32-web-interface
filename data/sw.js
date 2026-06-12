// Minimal service worker: no caching (the device is the single source of
// truth on a LAN) — exists to satisfy PWA installability criteria.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
