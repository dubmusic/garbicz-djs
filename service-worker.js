/* ============================================================
   Garbicz DJ Shortlist — service worker
   Caches the app shell for offline launch. Data (the Sheet API)
   is NOT cached here — app.js manages that in IndexedDB.
   Bump CACHE_VERSION whenever the shell files change.
   ============================================================ */

const CACHE_VERSION = 'garbicz-v5';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

// Cross-origin font hosts we opportunistically cache (enhancement).
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache writes

  const url = new URL(req.url);

  // Apps Script API — always go to the network, never cache.
  if (url.hostname.indexOf('script.google') > -1) return;

  // Google Fonts — stale-while-revalidate.
  if (FONT_HOSTS.indexOf(url.hostname) > -1) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-origin app shell — cache-first, refresh in background.
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(
        staleWhileRevalidate(req).catch(function () {
          return caches.match('./index.html');
        })
      );
    } else {
      event.respondWith(staleWhileRevalidate(req));
    }
  }
});

function staleWhileRevalidate(req) {
  return caches.open(CACHE_VERSION).then(function (cache) {
    return cache.match(req).then(function (cached) {
      const network = fetch(req).then(function (res) {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    });
  });
}
