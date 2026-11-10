// Service worker de Cielo: app shell en caché, datos con red primero y respaldo en caché
const V = 'cielo-v13';
const SHELL = ['./', 'index.html', 'app.js', 'scene.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isTile = /basemaps\.cartocdn\.com|server\.arcgisonline\.com|tilecache\.rainviewer\.com/.test(url.host);
  const isShell = url.origin === location.origin || url.host === 'unpkg.com';
  if (isShell) { // caché primero, actualiza en segundo plano
    e.respondWith(caches.match(req).then(hit => { const net = fetch(req).then(r => { if (r.ok) caches.open(V).then(c => c.put(req, r.clone())); return r; }).catch(() => hit); return hit || net; }));
  } else if (isTile) {
    e.respondWith(caches.open(V + '-tiles').then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok && !url.host.includes('rainviewer')) c.put(req, r.clone()); return r; }))));
  }
  // las APIs meteorológicas van directas a la red; la app guarda su propia copia en localStorage
});
