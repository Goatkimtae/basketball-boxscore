/* Offline cache for the app shell and the analysis libraries. Bump VERSION on every release. */
const VERSION = 'hoopstat-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'stats.js', 'flow.js', 'export.js', 'engine.js', 'worker.js', '사용법.html',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'vendor/opencv.js', 'vendor/mp4box.all.min.js', 'vendor/xlsx.full.min.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // network first for the app's own code (updates show up), cache first for the large libraries
  const lib = req.url.includes('/vendor/');
  e.respondWith(lib
    ? caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }))
    : fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
});
