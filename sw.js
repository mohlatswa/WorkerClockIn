// v15 — self-healing SW.
// On first activation it deletes all old caches, unregisters itself,
// and reloads every open tab so they load without any SW in the way.
// On the second registration (fresh install, no old caches) it just
// claims clients and stays passive — no fetch handler, so every
// request goes straight to the network and nothing can get stuck.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();

    // Always wipe every cache left by previous broken versions
    await Promise.all(keys.map(k => caches.delete(k)));

    if (keys.length > 0) {
      // There were old caches → we are upgrading from a broken version.
      // Unregister this SW so the next page load is completely SW-free,
      // then navigate every open tab to reload cleanly.
      await self.registration.unregister().catch(() => {});
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
      return;
    }

    // Fresh install (no old caches) — just claim clients and stay passive.
    self.clients.claim();
  })());
});

// NO fetch handler — zero SW interference with network requests.
