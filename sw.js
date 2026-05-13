// Service Worker — network-first so updates are always picked up immediately
const CACHE = 'workclock-v12';
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
  // Pre-cache all assets with cache: 'reload' to bypass the HTTP cache
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(
        ASSETS.map(url =>
          fetch(url, { cache: 'reload' })
            .then(res => c.put(url, res))
            .catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => client.navigate(client.url)))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Skip non-GET and cross-origin requests (Supabase, Nominatim, etc.)
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  // Network-first with cache bypass so HTTP cache never serves stale files
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
