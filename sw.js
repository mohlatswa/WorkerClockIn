// Service Worker — network-first with 5 s timeout so a slow network
// never blocks script loading. Falls back to cache instantly.
const CACHE = 'workclock-v13';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './supabase.min.js',
  './jsQR.js',
  './qrcode.min.js',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => {
        try { client.navigate(client.url); } catch (_) {}
      }))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  // Network-first: try the network, but give up after 5 s and serve
  // the cached copy so a slow connection never blocks page rendering.
  const networkFirst = Promise.race([
    fetch(e.request),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), 5000)),
  ]).then(res => {
    const clone = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, clone));
    return res;
  });

  e.respondWith(networkFirst.catch(() => caches.match(e.request)));
});
