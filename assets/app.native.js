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

  /* ---------- keyboard: keep the field you type in above it (browser and apps) ----------
     Chrome and the Android app shrink the page when the keyboard opens, but do not always scroll the focused field
     back into sight (it can end up under the keyboard or the bottom bar). After the keyboard settles we check where
     the field is and scroll the nearest scrolling box (a dialog body, or the page) so it sits in the upper part of
     what is still visible, leaving room for the place suggestions under it. If the app's web view is not resized
     at all, the part the keyboard covers is added as space at the bottom (--kb-overlap) so the page can scroll. */
  (function keepFieldAboveKeyboard(){
    const root = document.documentElement;
    const NO_KEYBOARD = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden|date|time|datetime-local|month|week)$/;
    const isTyping = (el) => !!el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
      (el.tagName === 'INPUT' && !NO_KEYBOARD.test(el.type)));
    let nativeKb = 0;                   // keyboard height from the app plugin, in CSS px
    let fullH = window.innerHeight, fullW = window.innerWidth; // page height without the keyboard
    let overlap = 0, timer = 0;
    const vv = window.visualViewport;

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

    function stickyTop(el){
      if(el.closest('.modal, .tour, .ask-layer, .rng-pop, .dp-pop')) return 0;
      const bar = document.querySelector('.topbar');
      if(!bar) return 0;
      const pos = getComputedStyle(bar).position;
      return (pos === 'sticky' || pos === 'fixed') ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    }

    function reveal(){
      const el = document.activeElement;
      if(!isTyping(el) || !el.isConnected) return;
      if(!measure()) return;            // no keyboard: nothing to do
      let top = vv ? vv.offsetTop : 0;
      let bottom = Math.min(vv ? vv.offsetTop + vv.height : window.innerHeight, window.innerHeight - overlap);
      top = Math.max(top, stickyTop(el));
      const r = el.getBoundingClientRect();
      const gap = 12;
      if(r.top >= top + gap && r.bottom <= bottom - gap) return;   // already fully visible
      // put the field near the top of the visible part, so suggestions fit below it
      let delta = r.top - (top + Math.max(gap, Math.min(72, (bottom - top) * 0.15)));
      for(let p = el.parentElement; p && Math.abs(delta) > 1 && p !== document.body && p !== root; p = p.parentElement){
        const oy = getComputedStyle(p).overflowY;
        if(!/(auto|scroll)/.test(oy) || p.scrollHeight <= p.clientHeight) continue;
        const before = p.scrollTop;
        p.scrollTop = before + delta;
        delta -= p.scrollTop - before;
      }
      if(Math.abs(delta) > 1) window.scrollBy(0, delta);
    }

    function later(ms){ clearTimeout(timer); timer = setTimeout(reveal, ms); }

    document.addEventListener('focusin', (e) => {
      if(!isTyping(e.target)) return;
      later(320);                       // after the keyboard has opened
      setTimeout(reveal, 700);          // and once more if it was slow
    });
    // tapping a field that is already focused brings the keyboard back without a new focus event
    document.addEventListener('click', (e) => { if(isTyping(e.target) && e.target === document.activeElement) later(320); }, true);
    document.addEventListener('focusout', () => setTimeout(() => { if(!isTyping(document.activeElement)) measure(); }, 50));
    const onResize = () => { measure(); if(isTyping(document.activeElement)) later(80); };
    window.addEventListener('resize', onResize);
    if(vv) vv.addEventListener('resize', onResize);

    if(native && P.Keyboard){
      P.Keyboard.addListener('keyboardWillShow', (info) => { nativeKb = (info && info.keyboardHeight) || 1; root.classList.add('keyboard-open'); });
      P.Keyboard.addListener('keyboardDidShow', (info) => { nativeKb = (info && info.keyboardHeight) || nativeKb || 1; later(30); });
      P.Keyboard.addListener('keyboardWillHide', () => { nativeKb = 0; measure(); });
      P.Keyboard.addListener('keyboardDidHide', () => { nativeKb = 0; measure(); });
    }
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
    navigator.geolocation.getCurrentPosition = function(ok, fail, opts){
      Geo.getCurrentPosition({ enableHighAccuracy: !!(opts && opts.enableHighAccuracy), timeout: (opts && opts.timeout) || 15000 })
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
