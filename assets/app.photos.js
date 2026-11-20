"use strict";
/* Trip photos: take one with the camera or pick from the gallery, keep it on the device until it is uploaded,
   and upload in chunks that resume after a dropped connection (the server says how many bytes it already has).
   The queue lives in IndexedDB, so photos taken offline or before closing the app are sent later. */
(function(){
  const DB_NAME = 'onward-photos', STORE = 'uploads';
  const en = () => document.documentElement.lang === 'en';
  const t = (pl, en_) => en() ? en_ : pl;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const listeners = new Set();
  let running = false, retryTimer = null;

  function db(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn){
    const d = await db();
    return new Promise((resolve, reject) => {
      const store = d.transaction(STORE, mode).objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const all = () => tx('readonly', s => s.getAll());
  const put = (item) => tx('readwrite', s => s.put(item));
  const remove = (id) => tx('readwrite', s => s.delete(id));
  const changed = (tripId) => listeners.forEach(fn => fn(tripId));

  async function api(path, init){
    let r;
    try{ r = await window.fetch(path, init); }
    catch(e){ throw Object.assign(new Error('network'), { status: 0 }); }
    let body = null; try{ body = await r.json(); }catch(e){}
    return { ok: r.ok, status: r.status, body: body || {} };
  }

  // Server says "not found" for a trip that is not synced yet; that, network errors and 5xx are worth retrying.
  const retryable = (status) => status === 0 || status === 404 || status === 408 || status === 429 || status >= 500;
  // Why a photo is still waiting, so the label can say what it waits for instead of a generic "waiting for connection":
  // 'offline' (no internet), 'trip' (the trip is not on the account yet) or 'server' (the photo server did not answer).
  const waitReason = (status) => status === 0 ? (navigator.onLine === false ? 'offline' : 'server') : status === 404 ? 'trip' : 'server';
  const RETRY_MS = 30000;

  async function uploadOne(item){
    if(!item.serverId){
      const r = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: item.tripId, contentType: item.type, size: item.size, caption: item.caption || '', takenAt: item.takenAt }) });
      if(!r.ok) throw Object.assign(new Error(r.body.error || 'upload start failed'), { status: r.status, code: r.body.code });
      item.serverId = r.body.photo.id; item.chunk = r.body.chunkSize || 4 * 1024 * 1024; item.received = 0;
      await put(item);
    } else {
      const r = await api(`/api/photos/${item.serverId}`);
      if(r.ok) item.received = r.body.photo.received;
      else if(r.status === 404){ item.serverId = null; item.received = 0; await put(item); return uploadOne(item); }
    }
    while(item.received < item.size){
      const part = item.blob.slice(item.received, Math.min(item.size, item.received + item.chunk));
      const r = await api(`/api/photos/${item.serverId}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(item.received) }, body: part });
      if(r.status === 409 && Number.isFinite(r.body.received)){ item.received = r.body.received; continue; }
      if(!r.ok) throw Object.assign(new Error(r.body.error || 'upload failed'), { status: r.status, code: r.body.code });
      item.received = r.body.photo.received; item.state = 'uploading';
      await put(item); changed(item.tripId);
    }
    await remove(item.id);
  }

  async function run(){
    if(running) return;
    running = true; clearTimeout(retryTimer);
    let again = false;
    try{
      for(const item of await all()){
        if(item.state === 'failed') continue;
        if(!navigator.onLine){ again = true; break; }
        if(item.state === 'waiting'){ item.state = 'sending'; changed(item.tripId); }
        try{ await uploadOne(item); }
        catch(e){
          const status = e.status || 0;
          if(retryable(status)){ item.state = 'waiting'; item.reason = waitReason(status); item.error = ''; again = true; }
          else { item.state = 'failed'; item.reason = ''; item.error = e.message; }
          await put(item);
        }
        changed(item.tripId);
      }
    } finally { running = false; }
    if(again) retryTimer = setTimeout(run, RETRY_MS);
  }

  async function add(tripId, file, caption){
    if(!file) return;
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    await put({ id, tripId, blob: file, type: file.type || 'image/jpeg', size: file.size, caption: caption || '', takenAt: new Date().toISOString(),
      state: 'queued', received: 0, serverId: null });
    changed(tripId);
    run();
  }

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) run(); });

  /* ---------- trip page section ---------- */
  // The camera button only where there is a phone camera: the apps, and phones/tablets in the browser — not on a PC.
  const phone = () => !!(window.ONWARD && window.ONWARD.native) || (matchMedia('(pointer: coarse)').matches && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
  const thumbs = new Map(); // server id -> object URL
  async function thumb(id){
    if(thumbs.has(id)) return thumbs.get(id);
    const r = await window.fetch(`/api/photos/${id}/file`);
    if(!r.ok) return '';
    const url = URL.createObjectURL(await r.blob());
    thumbs.set(id, url);
    return url;
  }

  // What the photo is doing now: a short label on the photo and, while it waits, one sentence under the photos that says
  // why and what happens next. The photo stays on the phone in every waiting case, so nothing is lost.
  function pendingLabel(p, pct){
    if(p.state === 'failed') return { short: t('Nie wysłano', 'Not sent'), long: esc(p.error || t('Nie udało się przesłać zdjęcia.', 'The photo could not be uploaded.')) };
    if(navigator.onLine === false || (p.state === 'waiting' && p.reason === 'offline'))
      return { short: t('Brak internetu', 'Offline'), long: t('Brak internetu. Zdjęcia są w telefonie i wyślemy je same, gdy wróci połączenie.', 'No internet. The photos are kept on your phone and sent on their own when you are back online.') };
    if(p.state === 'waiting'){
      const again = t(' Ponawiamy co 30 sekund.', ' We retry every 30 seconds.');
      if(p.reason === 'trip') return { short: t('Czeka na zapis podróży', 'Waiting for the trip'), long: t('Podróż nie jest jeszcze zapisana na Twoim koncie, więc zdjęcie czeka w telefonie. Wyślemy je, gdy tylko podróż się zapisze.', 'The trip is not saved to your account yet, so the photo waits on your phone. It is sent as soon as the trip is saved.') + again };
      return { short: t('Czeka na serwer', 'Waiting for server'), long: t('Masz internet, ale serwer zdjęć chwilowo nie odpowiada. Zdjęcia są w telefonie i nic nie przepadnie.', 'You are online, but the photo server is not answering right now. The photos are kept on your phone, nothing is lost.') + again };
    }
    return { short: `${t('Wysyłam', 'Sending')}${pct ? ` ${pct}%` : '…'}`, long: '' };
  }

  async function render(box, tripId){
    if(!box || !box.isConnected) return;
    const signedIn = !document.body.classList.contains('guest');
    const pending = (await all()).filter(x => x.tripId === tripId);
    let saved = [];
    if(signedIn && navigator.onLine){
      const r = await api(`/api/photos?tripId=${encodeURIComponent(tripId)}`).catch(() => ({ ok: false }));
      if(r.ok) saved = r.body.photos.filter(p => p.status === 'ready');
    }
    let note = null;
    const pendingHtml = pending.map(p => {
      const pct = Math.round(100 * (p.received || 0) / p.size);
      const label = pendingLabel(p, pct), stuck = p.state === 'failed' || p.state === 'waiting' || navigator.onLine === false;
      if(label.long && !note) note = { text: label.long, failed: p.state === 'failed', retry: navigator.onLine !== false };
      return `<figure class="tp-photo pending ${p.state === 'failed' ? 'failed' : stuck ? 'waiting' : ''}"><img data-local="${esc(p.id)}" alt=""><figcaption><span class="tp-photo-bar"><i style="width:${pct}%"></i></span>${esc(label.short)}</figcaption>${stuck ? `<button type="button" class="tp-photo-x" data-photo-drop="${esc(p.id)}" aria-label="${t('Usuń to zdjęcie z kolejki', 'Remove this photo from the queue')}">×</button>` : ''}</figure>`;
    }).join('');
    const noteHtml = note ? `<p class="tp-photo-note ${note.failed ? 'err' : ''}" role="status"><i class="fa-solid fa-${note.failed ? 'circle-exclamation' : 'circle-info'}" aria-hidden="true"></i> <span>${note.text}</span>${note.retry ? ` <button type="button" class="btn-ghost tp-photo-retry" data-photo-retry="all"><i class="fa-solid fa-rotate" aria-hidden="true"></i> ${t('Wyślij teraz', 'Send now')}</button>` : ''}</p>` : '';
    const savedHtml = saved.map(p => `<figure class="tp-photo"><img data-photo="${esc(p.id)}" alt="${esc(p.caption || t('Zdjęcie z podróży', 'Trip photo'))}"><button type="button" class="tp-photo-x" data-photo-delete="${esc(p.id)}" aria-label="${t('Usuń zdjęcie', 'Delete photo')}">×</button>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`).join('');
    box.innerHTML = `<div class="tp-photos-head"><h4>${t('Zdjęcia z podróży', 'Trip photos')}</h4>
      ${signedIn ? `<div class="tp-photos-btns">${phone() ? `<button type="button" class="btn-grad" data-photo-take="camera"><i class="oi oi-camera" aria-hidden="true"></i> ${t('Zrób zdjęcie', 'Take a photo')}</button>
      <button type="button" class="btn-ghost" data-photo-take="gallery"><i class="fa-regular fa-images" aria-hidden="true"></i> ${t('Z galerii', 'From gallery')}</button>`
        : `<button type="button" class="btn-grad" data-photo-take="gallery"><i class="fa-regular fa-images" aria-hidden="true"></i> ${t('Dodaj zdjęcie', 'Add a photo')}</button>`}</div>` : ''}</div>
      ${!signedIn ? `<p class="text-soft">${t('Zaloguj się, aby dodawać zdjęcia do podróży.', 'Sign in to add photos to your trip.')}</p>`
        : pendingHtml || savedHtml ? `<div class="tp-photo-grid">${pendingHtml}${savedHtml}</div>${noteHtml}` : `<p class="text-soft">${t('Nie ma jeszcze zdjęć. Zdjęcia zrobione bez internetu wyślemy, gdy wróci połączenie.', 'No photos yet. Photos taken offline are uploaded when you are back online.')}</p>`}`;
    for(const img of box.querySelectorAll('img[data-local]')){ const p = pending.find(x => x.id === img.dataset.local); if(p) img.src = URL.createObjectURL(p.blob); }
    for(const img of box.querySelectorAll('img[data-photo]')) thumb(img.dataset.photo).then(src => { if(src) img.src = src; });
  }

  function mount(box, tripId){
    if(!box) return;
    box.dataset.trip = tripId;
    const refresh = (id) => { if(!box.isConnected){ listeners.delete(refresh); return; } if(id === tripId) render(box, tripId); };
    listeners.add(refresh);
    box.addEventListener('click', async (e) => {
      const take = e.target.closest('[data-photo-take]');
      if(take){ try{ await add(tripId, await window.ONWARD.pickPhoto(take.dataset.photoTake)); }catch(err){ if(!/cancel/i.test(String(err && err.message))) console.warn('photo', err); } return; }
      const del = e.target.closest('[data-photo-delete]');
      if(del && await (window.askConfirm ? window.askConfirm(t('Usunąć to zdjęcie?', 'Delete this photo?'), {ok: t('Usuń zdjęcie', 'Delete photo'), danger: true}) : Promise.resolve(confirm(t('Usunąć to zdjęcie?', 'Delete this photo?'))))){ await api(`/api/photos/${del.dataset.photoDelete}`, { method: 'DELETE' }); render(box, tripId); return; }
      const retry = e.target.closest('[data-photo-retry]');
      if(retry){
        retry.disabled = true;
        for(const item of (await all()).filter(x => x.tripId === tripId && (x.state === 'failed' || x.state === 'waiting'))){ item.state = 'queued'; item.error = ''; await put(item); }
        changed(tripId); clearTimeout(retryTimer); run(); return;
      }
      const drop = e.target.closest('[data-photo-drop]');
      if(drop){ await remove(drop.dataset.photoDrop); render(box, tripId); }
    });
    render(box, tripId);
    run();
  }

  window.TripPhotos = { mount, add, run };
  if(document.readyState !== 'loading') setTimeout(run, 2000); else document.addEventListener('DOMContentLoaded', () => setTimeout(run, 2000));
})();
