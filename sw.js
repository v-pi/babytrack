const CACHE = 'babytrack-v63';
const ASSETS = [
  './', './index.html', './manifest.json',
  './main.css', './utils.js', './db.js',
  './state.js', './render.js', './sync.js', './app.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for HTML navigation → always get the latest version
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first for other assets (icons, manifest, versioned JS/CSS…)
  // Versioned URLs (?v=N) bust the cache automatically when version changes.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
