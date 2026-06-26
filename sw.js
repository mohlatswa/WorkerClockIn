var CACHE = 'wc-v34';
var ASSETS = [
  './', './index.html', './app.js', './config.js',
  './style.css', './supabase.min.js', './manifest.json',
  './jsQR.js', './qrcode.min.js',
  './icon-192.png', './icon-512.png', './promo.html', './privacy.html'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return Promise.allSettled(ASSETS.map(function(a) { return c.add(a).catch(function(){}); }));
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  // Network-first for Supabase API — never serve stale attendance data
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response(JSON.stringify({ error: 'offline', message: 'No internet connection' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
  // Cache-first for all static assets — app loads even with no internet
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(res) {
        if (res && res.status === 200 && e.request.method === 'GET') {
          var clone = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
