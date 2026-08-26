// Cache-first service worker so the app (including the movie catalog data)
// keeps working offline once installed — everything here is already static,
// no live API dependency at runtime, so this is a natural fit.
importScripts('./version.js');
// Deriving the cache name from APP_VERSION means bumping the version (see
// version.js) is the *only* thing needed to force every installed copy of
// the PWA to fetch fresh assets instead of serving a stale cache forever —
// forgetting this bump is exactly what silently kept old code alive across
// several earlier deploys.
const CACHE_NAME = 'movie-dna-' + self.APP_VERSION;
const CORE_ASSETS = [
  './',
  './index.html',
  './version.js',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/data.js',
  './js/history.js',
  './js/learn.js',
  './js/sampling.js',
  './js/similarity.js',
  './data/movies.json',
  './data/taxonomy.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't intercept the tag-learner Worker calls

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504 });
        });
    })
  );
});
