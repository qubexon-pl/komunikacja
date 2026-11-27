/* ON/WARD service worker (served as /sw.js): the app shell works offline, and the signed-in user's own data
   (account, favourites with saved trips and itineraries, photos, trip weather) is readable offline.
   Live data and map tiles are not kept: an old bus position or price shown as current would mislead. */
const VERSION = 'onward-v36';
const SHELL = `${VERSION}-shell`;
const API = 'onward-api'; // cleared at logout by the page
const PRECACHE = ['/plan', '/login', '/assets/app.css', '/assets/app.mobile.css', '/assets/app.js', '/assets/app.transport.js', '/assets/app.shell.css', '/assets/app.ui.js', '/assets/app.transport.css', '/assets/app.cities.js', '/assets/app.defaults.js', '/assets/i18n.js', '/assets/app.native.js', '/assets/app.photos.js', '/assets/app.tour.js', '/assets/app.welcome.css', '/assets/app.welcome.js', '/assets/onward/illustrations/welcome-journey.svg',
  '/assets/app.config.js', '/assets/login.css', '/assets/login.js', '/assets/manifest.webmanifest', '/assets/onward/css/tokens.css',
  '/assets/onward/logos/wordmark-on-dark.svg', '/assets/onward/logos/mark-transparent.svg', '/assets/hero.svg'];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const OFFLINE_API = ['/api/auth/me', '/api/auth/config', '/api/favorites', '/api/preferences', '/api/photos', '/api/weather', '/api/flights/network'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('onward-v') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request, cacheName, fallbackUrl){
  const cache = await caches.open(cacheName);
  try{
    const response = await fetch(request);
    if(response.ok && response.type !== 'opaque') cache.put(request, response.clone());
    return response;
  }catch(error){
    const hit = await cache.match(request) || (fallbackUrl && await caches.match(fallbackUrl));
    if(hit) return hit;
    throw error;
  }
}

async function staleWhileRevalidate(request){
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((response) => { if(response.ok || response.type === 'opaque') cache.put(request, response.clone()); return response; }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if(request.method !== 'GET') return;
  const url = new URL(request.url);
  const same = url.origin === self.location.origin;
  if(request.mode === 'navigate' && same){
    event.respondWith(networkFirst(request, SHELL, url.pathname.startsWith('/login') ? '/login' : '/plan'));
    return;
  }
  if(same && url.pathname.startsWith('/api/')){
    if(OFFLINE_API.some((p) => url.pathname === p || url.pathname.startsWith(p + '/') || url.pathname.startsWith(p + '?'))) event.respondWith(networkFirst(request, API));
    return; // other API calls always go to the network
  }
  // The app's own files change with every update: always from the server, the copy is only for offline use.
  if(same && url.pathname.startsWith('/assets/')){ event.respondWith(networkFirst(request, SHELL)); return; }
  if(CDN.includes(url.hostname)) event.respondWith(staleWhileRevalidate(request)); // versioned libraries
});
