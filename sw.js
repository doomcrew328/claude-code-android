// LEASELINE service worker — app shell + LSD database offline, imagery/terrain tiles kept as you view them.
const VERSION = 'leaseline-v2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/lsd.js', 'js/data.js', 'js/route.js', 'js/wells.js', 'js/v2.js',
  'data/places.json', 'data/hospitals.json',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'data/lsd.bin.gz', 'manifest.webmanifest',
  'vendor/fonts/b612-mono-latin-400-normal.woff2', 'vendor/fonts/b612-mono-latin-700-normal.woff2',
  'vendor/fonts/chakra-petch-latin-500-normal.woff2', 'vendor/fonts/chakra-petch-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const TILE_CACHE = 'leaseline-tiles', TILE_MAX = 6000;

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try { const c = await caches.open(TILE_CACHE); const keys = await c.keys(); for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]); } finally { trimming = false; }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // imagery + terrain tiles: cache-first, keep what you've looked at
  if (url.hostname === 'server.arcgisonline.com' || url.hostname === 's3.amazonaws.com') {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok) { c.put(e.request, r.clone()); if (Math.random() < 0.02) trimTiles(); } return r; }
      catch { return new Response('', { status: 504 }); }
    }));
    return;
  }
  // daily data (rigs, new licences): network first so it's fresh, cached copy when offline
  if (url.origin === location.origin && /\/data\/(rigs|wells_new|meta)\.json$/.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      try { const r = await fetch(e.request, { cache: 'no-cache' }); if (r.ok) c.put(e.request, r.clone()); return r; }
      catch { return (await c.match(e.request, { ignoreSearch: true })) || new Response('[]', { headers: { 'content-type': 'application/json' } }); }
    }));
    return;
  }
  // big data files (LSD grid, wells): cache-first, re-check at most once a week
  if (url.origin === location.origin && /\.gz$/.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const age = hit ? Date.now() - new Date(hit.headers.get('date') || 0).getTime() : Infinity;
      if (hit && age < 7 * 864e5) return hit;
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // app shell: cache-first, refresh in background
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Alberta REST + weather go to the network; the app keeps its own copies in IndexedDB
});
