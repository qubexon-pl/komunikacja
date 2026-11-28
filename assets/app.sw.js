/* ON/WARD service worker (served as /sw.js): the app shell works offline, and the signed-in user's own data
   (account, favourites with saved trips and itineraries, photos, trip weather) is readable offline.
   Live data and map tiles are not kept: an old bus position or price shown as current would mislead. */
const VERSION = 'onward-v61';
const SHELL = `${VERSION}-shell`;
const API = 'onward-api'; // cleared at logout by the page
const PRECACHE = ['/plan', '/login', '/assets/app.css', '/assets/app.mobile.css', '/assets/app.js', '/assets/app.transport.js', '/assets/app.mapstyle.js', '/assets/app.ios.css', '/assets/app.discover.js', '/assets/app.push.js', '/assets/app.shell.css', '/assets/app.ui.js', '/assets/app.transport.css', '/assets/app.cities.js', '/assets/app.defaults.js', '/assets/i18n.js', '/assets/app.native.js', '/assets/app.photos.js', '/assets/app.tour.js', '/assets/app.welcome.css', '/assets/app.welcome.js', '/assets/onward/illustrations/welcome-journey.svg',
  '/assets/app.config.js', '/assets/login.css', '/assets/login.js', '/assets/manifest.webmanifest', '/assets/onward/css/tokens.css',
  '/assets/onward/logos/wordmark-on-dark.svg', '/assets/onward/logos/mark-transparent.svg', '/assets/hero.svg'];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Read offline from the last copy: the account, saved trips and what was planned for them (AI day plans, places nearby,
// place descriptions, trips shared with the user). Copies carry X-Podavo-Saved-At, so the page can say how old they are.
const OFFLINE_API = ['/api/auth/me', '/api/auth/config', '/api/favorites', '/api/preferences', '/api/photos', '/api/weather', '/api/flights/network',
  '/api/ai/status', '/api/ai/style', '/api/ai/city-plan', '/api/places/about', '/api/places/nearby', '/api/trips/shared', '/api/trips/mine/shares'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('onward-v') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The cached copy remembers when it was saved.
async function stamped(response){
  const headers = new Headers(response.headers);
  headers.set('X-Podavo-Saved-At', new Date().toISOString());
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request, cacheName, fallbackUrl){
  const cache = await caches.open(cacheName);
  try{
    const response = await fetch(request);
    if(response.ok && response.type !== 'opaque') cache.put(request, await stamped(response.clone()));
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

/* Web Push (src/push.js): show the notification even when Podavo is closed, and open its page when tapped. */
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { title: 'Podavo', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Podavo', {
    body: msg.body || '',
    icon: '/assets/logo-180.png',
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    data: { to: msg.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.to) || '/';
  // Only pages of this site: a notification never opens another address.
  const to = new URL(raw, self.location.origin);
  const target = to.origin === self.location.origin ? to.href : self.location.origin + '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus().then((c) => (c && 'navigate' in c ? c.navigate(target) : undefined));
    return self.clients.openWindow(target);
  }));
});
