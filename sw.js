// Service Worker for Stock Accounting PWA
const CACHE_NAME = 'stock-app-v5';
const CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(CACHE_URLS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Network-first for API requests (East Money)
  if (url.hostname.includes('eastmoney.com') || url.hostname.includes('sinajs.cn')) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Cache-first for static resources, fallback to network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
