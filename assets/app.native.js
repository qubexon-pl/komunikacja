"use strict";
/* Most ON/WARD code is the same on the web, Android and iOS. This file holds the differences.
   On the web it only adds small helpers (share, photo picking) with browser fallbacks; inside the Capacitor apps it:
   - sends /api/… calls to the API server with the session as a bearer token (kept in the Keychain / Android Keystore),
   - signs in with Google natively and turns the Google ID token into an app session,
   - opens Google Maps links in the Maps app, handles the Android back button, GPS permission, status bar and splash. */
(function(){
  const cap = window.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = native ? cap.Plugins : {};
  const config = window.ONWARD_CONFIG || {};
  const API = String(config.apiBase || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'onward.session';
  let token = null;

  const ON = window.ONWARD = { native, platform: native ? cap.getPlatform() : 'web', apiBase: API };
  if(native) document.documentElement.classList.add('is-native', 'platform-' + ON.platform);

  /* ---------- session token in secure storage ---------- */
  const secure = P.SecureStoragePlugin;
  const tokenReady = !native ? Promise.resolve(null) : (secure ? secure.get({ key: TOKEN_KEY }).then(r => (token = r.value || null)).catch(() => null) : Promise.resolve(null));
  ON.setToken = async (value) => {
    token = value || null;
    if(!secure) return;
    try{ if(token) await secure.set({ key: TOKEN_KEY, value: token }); else await secure.remove({ key: TOKEN_KEY }); }catch(e){ /* nothing stored yet */ }
  };
  ON.hasSession = () => !!token;

  /* ---------- API calls: same endpoints for web and apps ---------- */
  const origFetch = window.fetch.bind(window);
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/');
  if(native){
    window.fetch = async function(input, init){
      const url = typeof input === 'string' ? input : input && input.url;
      if(!isApi(url) || !API) return origFetch(input, init);
      await tokenReady;
      const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || {});
      if(token) headers.set('Authorization', 'Bearer ' + token);
      // Sign-in calls answer with the session in the body instead of a cookie the app could not keep.
      if(url.startsWith('/api/auth/')) headers.set('X-Auth-Mode', 'token');
      const response = await origFetch(API + url, { ...(init || {}), headers, credentials: 'omit' });
      if(url.startsWith('/api/auth/') && response.ok){
        const copy = response.clone();
        copy.json().then(body => {
          if(body && typeof body.token === 'string') ON.setToken(body.token);
          if(url.startsWith('/api/auth/logout') || (url.startsWith('/api/auth/account/delete/confirm') && body.deleted)) ON.setToken(null);
        }).catch(() => {});
      }
      if(response.status === 401 && token && url === '/api/auth/me') ON.setToken(null);
      return response;
    };
  }
  ON.apiUrl = (path) => (native && API ? API + path : path);
  ON.authHeaders = () => (native && token ? { Authorization: 'Bearer ' + token } : {});

  /* ---------- pages: in the app the pages are files, not server routes ---------- */
  ON.loginUrl = (returnTo) => native ? '/login.html' : '/login' + (returnTo ? '?returnTo=' + encodeURIComponent(returnTo) : '');
  ON.homeUrl = () => native ? '/index.html' : '/plan';
  ON.whenSignedIn = (fn) => tokenReady.then(() => { if(token) fn(); });
  // The app opens on the welcome page (welcome.html) until the person signs in, once per launch, like / on the website.
  if(native && /^\/(index\.html)?$/.test(location.pathname)){
    let welcomed = false;
    try{ welcomed = sessionStorage.getItem('onward.welcomed') === '1'; }catch(e){}
    if(!welcomed) tokenReady.then(() => { if(!token) location.replace('/welcome.html'); });
  }

  /* ---------- Google sign-in ---------- */
  ON.googleSignIn = async function(){
    const social = P.SocialLogin;
    if(!social) throw new Error('Google sign-in is not available in this build.');
    const google = config.google || {};
    await social.initialize({ google: { webClientId: google.webClientId, iOSClientId: google.iosClientId, iOSServerClientId: google.webClientId, mode: 'online' } });
    const res = await social.login({ provider: 'google', options: { scopes: ['email', 'profile'] } });
    const idToken = res && res.result && res.result.idToken;
    if(!idToken) throw new Error('Google nie zwróciło tokenu logowania.');
    const r = await window.fetch('/api/auth/google/native', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const body = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(body.error || 'Nie udało się zalogować przez Google.');
    await ON.setToken(body.token);
    return body.user;
  };

  /* ---------- external links: Google Maps navigation and other sites ---------- */
  const MAPS = /^https:\/\/(www\.)?google\.[a-z.]+\/maps|^https:\/\/maps\.(google|app\.goo)\.|^https:\/\/goo\.gl\/maps/;
  ON.openExternal = async function(url){
    if(!native){ window.open(url, '_blank', 'noopener'); return; }
    try{
      if(MAPS.test(url) && P.AppLauncher){ await P.AppLauncher.openUrl({ url }); return; } // Maps app if installed, otherwise the browser
      if(P.Browser){ await P.Browser.open({ url }); return; }
    }catch(e){ /* fall through */ }
    window.open(url, '_blank');
  };
  if(native){
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="http"]');
      if(!a || e.defaultPrevented) return;
      const href = a.getAttribute('href');
      if(API && href.startsWith(API + '/')) return;
      e.preventDefault();
      ON.openExternal(href);
    }, true);
  }

  /* ---------- sharing ---------- */
  ON.share = async function({ title, text, url }){
    try{
      if(native && P.Share){ await P.Share.share({ title, text, url, dialogTitle: title }); return true; }
      if(navigator.share){ await navigator.share({ title, text, url }); return true; }
      if(navigator.clipboard){ await navigator.clipboard.writeText([text, url].filter(Boolean).join('\n')); return 'copied'; }
    }catch(e){ if(e && e.name === 'AbortError') return false; }
    return false;
  };

  /* ---------- photos: camera or gallery ---------- */
  ON.pickPhoto = async function(source){
    if(native && P.Camera){
      const photo = await P.Camera.getPhoto({ quality: 85, resultType: 'uri', source: source === 'camera' ? 'CAMERA' : 'PHOTOS', saveToGallery: source === 'camera', // a shot from the camera also goes to the phone's gallery
        correctOrientation: true, width: 2560 });
      const blob = await (await origFetch(photo.webPath)).blob();
      const type = blob.type || ('image/' + (photo.format === 'jpg' ? 'jpeg' : photo.format || 'jpeg'));
      return new File([blob], 'photo.' + (photo.format || 'jpg'), { type });
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
      if(source === 'camera') input.capture = 'environment';
      input.addEventListener('change', () => resolve(input.files && input.files[0] || null), { once: true });
      input.click();
    });
  };
  // In the browser the gallery button takes several photos at once.
  ON.pickPhotos = function(){
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
      input.addEventListener('change', () => resolve(Array.from(input.files || [])), { once: true });
      input.click();
    });
  };

  /* ---------- keyboard: the field you type in goes up to just under the top bar (browser and apps) ----------
     On a phone the top bar (logo, PL/EN, Konto) and the bottom menu always stay on screen; pages, dialogs and the
     keyboard use the space between them. Their heights are kept in --app-top and --app-bottom for the CSS.
     When you tap a field, once the keyboard has opened we scroll the nearest scrolling box (a dialog body, or the
     page) so the field sits right under the top bar (or the top of the dialog), with the place suggestions below it.
     While you type, the page gets extra room at the bottom (.kb-room) so even the last field can go up that far.
     If the app's web view is not resized at all, the part the keyboard covers is --kb-overlap. */
  (function keepFieldUnderHeader(){
    const root = document.documentElement;
    const NO_KEYBOARD = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden|date|time|datetime-local|month|week)$/;
    const isTyping = (el) => !!el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
      (el.tagName === 'INPUT' && !NO_KEYBOARD.test(el.type)));
    const phone = () => window.matchMedia('(max-width:767px)').matches;
    const touch = () => window.matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0;
    let nativeKb = 0;                   // keyboard height from the app plugin, in CSS px
    let fullH = window.innerHeight, fullW = window.innerWidth; // page height without the keyboard
    let overlap = 0, timer = 0, roomTimer = 0, roomEl = null;
    const vv = window.visualViewport;

    /* top bar and bottom menu heights, for dialogs and sheets that sit between them */
    function bars(){
      const top = document.querySelector('.topbar'), nav = document.querySelector('.bottom-nav');
      // on a computer the same <nav> is the left sidebar (app.shell.css), which takes no height from the page
      const navH = nav && phone() && getComputedStyle(nav).display !== 'none' ? nav.offsetHeight : 0;
      if(top) root.style.setProperty('--app-top', top.offsetHeight + 'px');
      root.style.setProperty('--app-bottom', navH + 'px');
    }
    document.addEventListener('DOMContentLoaded', () => {
      bars();
      if(window.ResizeObserver){ const ro = new ResizeObserver(bars); document.querySelectorAll('.topbar, .bottom-nav').forEach(el => ro.observe(el)); }
    });

    function measure(){
      if(window.innerWidth !== fullW){ fullW = window.innerWidth; fullH = window.innerHeight; }
      if(!nativeKb && !isTyping(document.activeElement)) fullH = window.innerHeight;
      else fullH = Math.max(fullH, window.innerHeight);
      const shrunk = fullH - Math.min(window.innerHeight, vv ? vv.height : window.innerHeight);
      // the app reports the keyboard; if the page did not shrink by that much, the rest covers the page
      const covered = nativeKb ? nativeKb - (fullH - window.innerHeight) : 0;
      overlap = covered > 100 ? covered : 0;
      root.style.setProperty('--kb-overlap', overlap + 'px');
      const open = nativeKb > 0 || (isTyping(document.activeElement) && shrunk > 150);
      root.classList.toggle('keyboard-open', open);
      return open;
    }

    // Where the field should end up: under the top bar on the page, under the top of the scrolling body in a dialog.
    function topLimit(el){
      const bar = document.querySelector('.topbar');
      let top = 0;
      if(bar){ const pos = getComputedStyle(bar).position; if(pos === 'sticky' || pos === 'fixed') top = Math.max(0, bar.getBoundingClientRect().bottom); }
      const box = el.closest('.modal-body, .modal');
      if(box) top = Math.max(top, box.getBoundingClientRect().top);
      if(vv) top = Math.max(top, vv.offsetTop);
      return top;
    }

    // Extra room under the content while typing, so the field can scroll up even at the end of the page or dialog.
    function giveRoom(el){
      clearTimeout(roomTimer);
      const box = el.closest('.modal-body') || document.body;
      if(roomEl && roomEl !== box) roomEl.classList.remove('kb-room');
      roomEl = box; box.classList.add('kb-room');
    }
    function takeRoom(){
      // later, so a tap on a place suggestion lands before the page gets shorter
      clearTimeout(roomTimer);
      roomTimer = setTimeout(() => { if(isTyping(document.activeElement)) return; roomEl?.classList.remove('kb-room'); roomEl = null; }, 700);
    }

    function scrollBy(el, delta){
      for(let p = el.parentElement; p && Math.abs(delta) > 1 && p !== document.body && p !== root; p = p.parentElement){
        const oy = getComputedStyle(p).overflowY;
        if(!/(auto|scroll)/.test(oy) || p.scrollHeight <= p.clientHeight) continue;
        const before = p.scrollTop;
        p.scrollTop = before + delta;
        delta -= p.scrollTop - before;
      }
      if(Math.abs(delta) > 1) window.scrollBy(0, delta);
    }

    function reveal(){
      const el = document.activeElement;
      if(!isTyping(el) || !el.isConnected) return;
      const open = measure();
      const onPhone = phone() && touch();
      if(!open && !onPhone) return;    // a computer without an on-screen keyboard: nothing to do
      // small pop-ups (calendar, tour, questions) only need the field visible
      if(el.closest('.tour, .ask-layer, .rng-pop, .dp-pop, .dropdown-menu')){
        const r = el.getBoundingClientRect(), top = topLimit(el), bottom = Math.min(vv ? vv.offsetTop + vv.height : window.innerHeight, window.innerHeight - overlap);
        if(r.top < top + 8) scrollBy(el, r.top - top - 8); else if(r.bottom > bottom - 8) scrollBy(el, r.bottom - bottom + 8);
        return;
      }
      if(onPhone) giveRoom(el);
      // the whole field with its label goes up, not only the text box
      let top = el.getBoundingClientRect().top;
      for(const sel of ['.pl-field', '.ctx-search', 'label', '.cp-field']){
        const box = el.closest(sel);
        if(box && box.getBoundingClientRect().height < 160){ top = Math.min(top, box.getBoundingClientRect().top); break; }
      }
      // a label written just above the field (not around it) goes up with it
      const lab = el.labels && el.labels[0];
      if(lab && !lab.contains(el)){ const lt = lab.getBoundingClientRect().top; if(lt < top && top - lt < 80) top = lt; }
      const delta = top - (topLimit(el) + 8);
      if(Math.abs(delta) > 2) scrollBy(el, delta);
    }

    function later(ms){ clearTimeout(timer); timer = setTimeout(reveal, ms); }

    document.addEventListener('focusin', (e) => {
      if(!isTyping(e.target)) return;
      if(phone() && touch()) giveRoom(e.target);
      later(320);                       // after the keyboard has opened
      setTimeout(reveal, 700);          // and once more if it was slow
    });
    // tapping a field that is already focused brings the keyboard back without a new focus event
    document.addEventListener('click', (e) => { if(isTyping(e.target) && e.target === document.activeElement) later(320); }, true);
    document.addEventListener('focusout', () => setTimeout(() => { if(!isTyping(document.activeElement)){ measure(); takeRoom(); } }, 50));
    const onResize = () => { bars(); measure(); if(isTyping(document.activeElement)) later(80); };
    window.addEventListener('resize', onResize);
    if(vv) vv.addEventListener('resize', onResize);

    if(native && P.Keyboard){
      P.Keyboard.addListener('keyboardWillShow', (info) => { nativeKb = (info && info.keyboardHeight) || 1; root.classList.add('keyboard-open'); });
      P.Keyboard.addListener('keyboardDidShow', (info) => { nativeKb = (info && info.keyboardHeight) || nativeKb || 1; measure(); later(30); });
      P.Keyboard.addListener('keyboardWillHide', () => { nativeKb = 0; measure(); });
      P.Keyboard.addListener('keyboardDidHide', () => { nativeKb = 0; measure(); });
    }
  })();

  /* ---------- phone: the bottom menu and the logo close an open dialog before they take you somewhere ---------- */
  document.addEventListener('click', (e) => {
    if(!e.target.closest || !e.target.closest('.bottom-nav a, .topbar a.brand')) return;
    if(!window.bootstrap) return;
    document.querySelectorAll('.modal.show').forEach(m => window.bootstrap.Modal.getInstance(m)?.hide());
  }, true);

  /* ---------- pull down to refresh (the app, and the web app on the Home Screen) ----------
     A firm swipe down at the top of the page reloads it with fresh data. Browsers have their own, so only installed. */
  (function pullToRefresh(){
    const installed = native || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if(!installed) return;
    const LIMIT = 80;                     // px of pull (after resistance) that reloads
    const SKIP = '.leaflet-container, .modal, .offcanvas, input, textarea, select, [contenteditable], [data-no-pull]';
    let startY = 0, startX = 0, pull = 0, active = false, el = null;
    const ui = () => {
      if(el) return el;
      el = document.createElement('div');
      el.className = 'pull-refresh'; el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
      document.body.appendChild(el);
      return el;
    };
    const draw = (y, ready) => {
      const e = ui();
      e.style.transform = `translate(-50%, ${Math.min(y, LIMIT * 1.4) - 48}px) rotate(${y * 3}deg)`;
      e.style.opacity = String(Math.min(1, y / LIMIT));
      e.classList.toggle('ready', ready);
    };
    const scrolledInside = (node) => {
      for(let n = node; n && n !== document.body && n.nodeType === 1; n = n.parentElement){
        if(n.scrollTop > 0) return true;
      }
      return false;
    };
    document.addEventListener('touchstart', (e) => {
      active = false;
      if(e.touches.length !== 1 || document.body.classList.contains('modal-open')) return;
      if((document.scrollingElement || document.documentElement).scrollTop > 0) return;
      const t = e.target;
      if(t.closest && t.closest(SKIP)) return;
      if(scrolledInside(t)) return;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; pull = 0; active = true;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if(!active) return;
      const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
      if(pull === 0 && (dy <= 0 || Math.abs(dx) > Math.abs(dy))){ active = false; return; } // scrolling up or sideways
      pull = Math.max(0, dy * 0.5);   // resistance: it takes a deliberate swipe
      if(e.cancelable) e.preventDefault();
      draw(pull, pull >= LIMIT);
    }, { passive: false });
    const end = () => {
      if(!active) return;
      active = false;
      if(pull >= LIMIT){
        const e = ui(); e.classList.add('spinning');
        e.style.transform = `translate(-50%, ${LIMIT - 40}px)`;
        setTimeout(() => location.reload(), 150);
        return;
      }
      if(el){ el.style.transition = 'transform .2s, opacity .2s'; draw(0, false); setTimeout(() => { if(el) el.style.transition = ''; }, 220); }
      pull = 0;
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
  })();

  if(!native){
    // The install offer can come before the page script is ready: keep it until the "Install app" button asks for it.
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; });
    window.addEventListener('appinstalled', () => { window.__installPrompt = null; });
    // Web/PWA: cache the app shell and the user's saved trips for offline use.
    if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker', e)));
    }
    return;
  }

  /* ---------- GPS through the native permission prompt ---------- */
  if(P.Geolocation && navigator.geolocation){
    const Geo = P.Geolocation;
    // Ask for the permission explicitly first: some plugin versions fail getCurrentPosition instead of prompting.
    const granted = (st) => st && (st.location === 'granted' || st.coarseLocation === 'granted');
    const allowed = async () => {
      if(!Geo.checkPermissions) return;
      const st = await Geo.checkPermissions();
      if(granted(st)) return;
      if(!granted(await Geo.requestPermissions())) throw new Error('Location permission denied');
    };
    navigator.geolocation.getCurrentPosition = function(ok, fail, opts){
      allowed().then(() => Geo.getCurrentPosition({ enableHighAccuracy: !!(opts && opts.enableHighAccuracy), timeout: (opts && opts.timeout) || 15000, maximumAge: (opts && opts.maximumAge) || 0 }))
        .then(pos => ok({ coords: pos.coords, timestamp: pos.timestamp }))
        .catch(err => fail && fail({ code: /denied|permission/i.test(String(err && err.message)) ? 1 : 2, message: String(err && err.message || err) }));
    };
  }

  /* ---------- Android back button: close what is open, then go back, then leave ---------- */
  if(P.App){
    P.App.addListener('backButton', ({ canGoBack }) => {
      const modal = document.querySelector('.modal.show');
      if(modal && window.bootstrap){ window.bootstrap.Modal.getInstance(modal)?.hide(); return; }
      const menu = document.querySelector('.dropdown-menu.show');
      if(menu){ menu.classList.remove('show'); return; }
      if(canGoBack || history.length > 1) history.back(); else P.App.exitApp();
    });
  }

  /* ---------- status bar and splash (the keyboard is handled above) ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    try{ P.StatusBar?.setStyle({ style: 'DARK' }); if(ON.platform === 'android') P.StatusBar?.setBackgroundColor({ color: '#173B70' }); }catch(e){}
    setTimeout(() => P.SplashScreen?.hide(), 150);
  });
})();
