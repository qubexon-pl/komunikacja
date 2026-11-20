"use strict";
/* Trip photos, local first.
   Every photo is kept on this device (IndexedDB) and shown from there; in the app a camera shot is also saved to the
   phone's own gallery. Copying photos to the cloud (the account) is an option the traveller turns on; it uploads in
   chunks that resume after a dropped connection (the server says how many bytes it already has).
   cloudAllowed() is the one place that decides whether the cloud option is offered, so it can later be limited to a
   paid plan without touching the rest. */
(function(){
  const DB_NAME = 'onward-photos', QUEUE = 'uploads', LOCAL = 'photos';
  const CLOUD_KEY = 'onward.photosCloud';
  const en = () => document.documentElement.lang === 'en';
  const t = (pl, en_) => en() ? en_ : pl;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const listeners = new Set();
  let running = false, retryTimer = null;

  /* ---------- storage ---------- */
  let dbOpen = null;
  function db(){
    if(dbOpen) return dbOpen;
    dbOpen = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = (e) => {
        const d = req.result;
        if(!d.objectStoreNames.contains(QUEUE)) d.createObjectStore(QUEUE, { keyPath: 'id' });
        if(!d.objectStoreNames.contains(LOCAL)){
          const local = d.createObjectStore(LOCAL, { keyPath: 'id' });
          // Version 1 kept photos only in the upload queue: they become local photos that are on their way to the cloud.
          if(e.oldVersion >= 1){
            const q = req.transaction.objectStore(QUEUE).getAll();
            q.onsuccess = () => {
              // Those photos were meant for the cloud, so the cloud option starts on for this device.
              if(q.result.length){ try{ localStorage.setItem(CLOUD_KEY, '1'); }catch(err){} }
              q.result.forEach(x => local.put({ id: x.id, tripId: x.tripId, blob: x.blob, type: x.type, size: x.size,
              caption: x.caption || '', takenAt: x.takenAt, cloud: 'queued', serverId: x.serverId || null }));
            };
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbOpen = null; reject(req.error); };
    });
    return dbOpen;
  }
  async function tx(store, mode, fn){
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = fn(d.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const queued = () => tx(QUEUE, 'readonly', s => s.getAll());
  const putQueued = (item) => tx(QUEUE, 'readwrite', s => s.put(item));
  const unqueue = (id) => tx(QUEUE, 'readwrite', s => s.delete(id));
  const locals = () => tx(LOCAL, 'readonly', s => s.getAll());
  const getLocal = (id) => tx(LOCAL, 'readonly', s => s.get(id));
  const putLocal = (item) => tx(LOCAL, 'readwrite', s => s.put(item));
  const removeLocal = (id) => tx(LOCAL, 'readwrite', s => s.delete(id));
  const changed = (tripId) => listeners.forEach(fn => fn(tripId));
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  /* ---------- the cloud option ---------- */
  const signedIn = () => !document.body.classList.contains('guest');
  // Whether this account may copy photos to the cloud. Today every signed-in account may; to make it a paid option,
  // check the plan here (or set ONWARD_CONFIG.features.cloudPhotos = false to hide it everywhere).
  function cloudAllowed(){
    const flag = window.ONWARD_CONFIG && window.ONWARD_CONFIG.features && window.ONWARD_CONFIG.features.cloudPhotos;
    return signedIn() && flag !== false;
  }
  function cloudChosen(){ try{ return localStorage.getItem(CLOUD_KEY) === '1'; }catch(e){ return false; } }
  const cloudOn = () => cloudAllowed() && cloudChosen();
  async function setCloud(on){
    try{ localStorage.setItem(CLOUD_KEY, on ? '1' : '0'); }catch(e){}
    const trips = new Set();
    if(on){
      for(const p of await locals()) if(!p.cloud){ await enqueue(p); trips.add(p.tripId); }
      run();
    } else {
      // Photos not yet sent stay on the phone only; photos already in the cloud stay there.
      clearTimeout(retryTimer);
      for(const q of await queued()){
        await unqueue(q.id); trips.add(q.tripId);
        const p = await getLocal(q.id); if(p && p.cloud === 'queued'){ p.cloud = ''; await putLocal(p); }
      }
    }
    trips.forEach(changed);
  }
  async function enqueue(p){
    await putQueued({ id: p.id, tripId: p.tripId, blob: p.blob, type: p.type, size: p.size, caption: p.caption || '', takenAt: p.takenAt,
      state: 'queued', received: 0, serverId: null });
    p.cloud = 'queued'; await putLocal(p);
  }

  /* ---------- upload ---------- */
  async function api(path, init){
    let r;
    try{ r = await window.fetch(path, init); }
    catch(e){ throw Object.assign(new Error('network'), { status: 0 }); }
    let body = null; try{ body = await r.json(); }catch(e){}
    return { ok: r.ok, status: r.status, body: body || {} };
  }

  // Server says "not found" for a trip that is not synced yet; that, network errors and 5xx are worth retrying.
  const retryable = (status) => status === 0 || status === 404 || status === 408 || status === 429 || status >= 500;
  // Why a photo is still waiting: 'offline' (no internet), 'trip' (the trip is not on the account yet) or 'server'.
  // Only the photo server's own "trip-not-found" means the trip is not on the account; any other 404 is a server that
  // does not handle photos (e.g. the request never reached FastAPI).
  const waitReason = (status, code) => status === 0 ? (navigator.onLine === false ? 'offline' : 'server') : status === 404 && code === 'trip-not-found' ? 'trip' : 'server';
  const RETRY_MS = 30000;

  async function uploadOne(item){
    if(!item.serverId){
      const r = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: item.tripId, contentType: item.type, size: item.size, caption: item.caption || '', takenAt: item.takenAt }) });
      if(!r.ok) throw Object.assign(new Error(r.body.error || 'upload start failed'), { status: r.status, code: r.body.code });
      item.serverId = r.body.photo.id; item.chunk = r.body.chunkSize || 4 * 1024 * 1024; item.received = 0;
      await putQueued(item);
    } else {
      const r = await api(`/api/photos/${item.serverId}`);
      if(r.ok) item.received = r.body.photo.received;
      else if(r.status === 404){ item.serverId = null; item.received = 0; await putQueued(item); return uploadOne(item); }
    }
    while(item.received < item.size){
      const part = item.blob.slice(item.received, Math.min(item.size, item.received + item.chunk));
      const r = await api(`/api/photos/${item.serverId}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(item.received) }, body: part });
      if(r.status === 409 && Number.isFinite(r.body.received)){ item.received = r.body.received; continue; }
      if(!r.ok) throw Object.assign(new Error(r.body.error || 'upload failed'), { status: r.status, code: r.body.code });
      item.received = r.body.photo.received; item.state = 'uploading';
      await putQueued(item); changed(item.tripId);
    }
    await unqueue(item.id);
    const p = await getLocal(item.id);
    if(p){ p.cloud = 'done'; p.serverId = item.serverId; await putLocal(p); }
  }

  async function run(){
    if(running || !cloudOn()) return;
    running = true; clearTimeout(retryTimer);
    let again = false;
    try{
      for(const item of await queued()){
        if(item.state === 'failed') continue;
        if(!navigator.onLine){ again = true; break; }
        if(item.state === 'waiting'){ item.state = 'sending'; changed(item.tripId); }
        try{ await uploadOne(item); }
        catch(e){
          const status = e.status || 0;
          if(retryable(status)){ item.state = 'waiting'; item.reason = waitReason(status, e.code); item.error = ''; again = true; }
          else { item.state = 'failed'; item.reason = ''; item.error = e.message; }
          await putQueued(item);
        }
        changed(item.tripId);
      }
    } finally { running = false; }
    if(again) retryTimer = setTimeout(run, RETRY_MS);
  }

  // A new photo is kept on this device; with the cloud option on it is also queued for upload.
  async function add(tripId, file, caption){
    if(!file) return;
    const p = { id: newId(), tripId, blob: file, type: file.type || 'image/jpeg', size: file.size, caption: caption || '', takenAt: new Date().toISOString(), cloud: '', serverId: null };
    await putLocal(p);
    if(cloudOn()){ await enqueue(p); run(); }
    changed(tripId);
  }

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) run(); });

  /* ---------- saving a photo to the phone (web) ---------- */
  // In the app a camera shot already goes to the gallery. In the browser a page cannot write to the gallery, so each
  // photo has a button that hands it to the phone: the share sheet ("Save image") where there is one, else a download.
  async function saveToPhone(p){
    const ext = (p.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([p.blob], `podroz-${(p.takenAt || '').slice(0, 10) || 'zdjecie'}-${p.id.slice(0, 6)}.${ext}`, { type: p.type });
    if(navigator.canShare && navigator.canShare({ files: [file] })){
      try{ await navigator.share({ files: [file] }); return; }catch(e){ if(e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------- trip page section ---------- */
  // The camera button only where there is a phone camera: the apps, and phones/tablets in the browser — not on a PC.
  const isNative = () => !!(window.ONWARD && window.ONWARD.native);
  const phone = () => isNative() || (matchMedia('(pointer: coarse)').matches && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
  const thumbs = new Map(); // server id -> object URL
  async function thumb(id){
    if(thumbs.has(id)) return thumbs.get(id);
    const r = await window.fetch(`/api/photos/${id}/file`);
    if(!r.ok) return '';
    const url = URL.createObjectURL(await r.blob());
    thumbs.set(id, url);
    return url;
  }
  const localUrls = new Map(); // local id -> object URL
  const localUrl = (p) => { if(!localUrls.has(p.id)) localUrls.set(p.id, URL.createObjectURL(p.blob)); return localUrls.get(p.id); };

  // What the cloud copy is doing: a short label on the photo and, while it waits, one sentence under the photos.
  // The photo is on the phone in every case, so nothing is lost.
  function uploadLabel(q, pct){
    if(q.state === 'failed') return { short: t('Nie wysłano', 'Not sent'), long: esc(q.error || t('Nie udało się wysłać kopii do chmury.', 'The cloud copy could not be uploaded.')), failed: true };
    if(navigator.onLine === false || (q.state === 'waiting' && q.reason === 'offline'))
      return { short: t('Brak internetu', 'Offline'), long: t('Brak internetu. Kopię w chmurze wyślemy sama, gdy wróci połączenie.', 'No internet. The cloud copy is sent on its own when you are back online.') };
    if(q.state === 'waiting'){
      const again = t(' Ponawiamy co 30 sekund.', ' We retry every 30 seconds.');
      if(q.reason === 'trip') return { short: t('Czeka na zapis podróży', 'Waiting for the trip'), long: t('Podróż nie jest jeszcze zapisana na Twoim koncie, więc kopia w chmurze czeka. Wyślemy ją, gdy tylko podróż się zapisze.', 'The trip is not saved to your account yet, so the cloud copy waits. It is sent as soon as the trip is saved.') + again };
      return { short: t('Czeka na serwer', 'Waiting for server'), long: t('Masz internet, ale serwer zdjęć chwilowo nie odpowiada.', 'You are online, but the photo server is not answering right now.') + again };
    }
    return { short: `${t('Do chmury', 'To cloud')}${pct ? ` ${pct}%` : '…'}`, long: '' };
  }

  async function render(box, tripId){
    if(!box || !box.isConnected) return;
    const mine = (await locals()).filter(x => x.tripId === tripId).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
    const queue = new Map((await queued()).filter(x => x.tripId === tripId).map(x => [x.id, x]));
    // Photos already in the cloud but not on this device (taken on another phone, or before this version).
    let cloudOnly = [];
    if(signedIn() && navigator.onLine){
      const r = await api(`/api/photos?tripId=${encodeURIComponent(tripId)}`).catch(() => ({ ok: false }));
      const here = new Set(mine.map(p => p.serverId).filter(Boolean));
      if(r.ok) cloudOnly = r.body.photos.filter(p => p.status === 'ready' && !here.has(p.id));
    }
    if(!box.isConnected) return;
    let note = null;
    const localHtml = mine.map(p => {
      const q = queue.get(p.id);
      let badge = '', cls = '';
      if(q){
        const pct = Math.round(100 * (q.received || 0) / q.size), label = uploadLabel(q, pct);
        const stuck = q.state === 'failed' || q.state === 'waiting' || navigator.onLine === false;
        if(label.long && !note) note = { text: label.long, failed: !!label.failed, retry: navigator.onLine !== false };
        cls = q.state === 'failed' ? 'failed' : stuck ? 'waiting' : 'pending';
        badge = `<figcaption><span class="tp-photo-bar"><i style="width:${pct}%"></i></span>${esc(label.short)}</figcaption>`;
      } else if(p.cloud === 'done') badge = `<span class="tp-photo-cloud" title="${t('Kopia jest w chmurze', 'Copied to the cloud')}"><i class="fa-solid fa-cloud" aria-hidden="true"></i></span>`;
      return `<figure class="tp-photo ${cls}"><img data-local="${esc(p.id)}" alt="${esc(p.caption || t('Zdjęcie z podróży', 'Trip photo'))}">${badge}
        <button type="button" class="tp-photo-x" data-photo-remove="${esc(p.id)}" aria-label="${t('Usuń zdjęcie z podróży', 'Remove photo from the trip')}">×</button>
        ${isNative() ? '' : `<button type="button" class="tp-photo-save" data-photo-save="${esc(p.id)}" title="${t('Zapisz w telefonie', 'Save to phone')}" aria-label="${t('Zapisz w telefonie', 'Save to phone')}"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`}</figure>`;
    }).join('');
    const cloudHtml = cloudOnly.map(p => `<figure class="tp-photo"><img data-photo="${esc(p.id)}" alt="${esc(p.caption || t('Zdjęcie z podróży', 'Trip photo'))}"><span class="tp-photo-cloud" title="${t('Tylko w chmurze', 'Only in the cloud')}"><i class="fa-solid fa-cloud" aria-hidden="true"></i></span><button type="button" class="tp-photo-x" data-photo-delete="${esc(p.id)}" aria-label="${t('Usuń zdjęcie', 'Delete photo')}">×</button></figure>`).join('');
    const noteHtml = note ? `<p class="tp-photo-note ${note.failed ? 'err' : ''}" role="status"><i class="fa-solid fa-${note.failed ? 'circle-exclamation' : 'circle-info'}" aria-hidden="true"></i> <span>${note.text}</span>${note.retry ? ` <button type="button" class="btn-ghost tp-photo-retry" data-photo-retry="all"><i class="fa-solid fa-rotate" aria-hidden="true"></i> ${t('Wyślij teraz', 'Send now')}</button>` : ''}</p>` : '';
    const where = isNative()
      ? t('Zdjęcia zostają w telefonie: zdjęcie z aparatu trafia też do galerii.', 'Photos stay on your phone: camera shots also go to your gallery.')
      : t('Zdjęcia zostają na tym urządzeniu. Przycisk ⤓ na zdjęciu zapisze je w telefonie.', 'Photos stay on this device. The ⤓ button on a photo saves it to your phone.');
    const cloudRow = cloudAllowed()
      ? `<label class="tp-cloud-switch"><input type="checkbox" data-photo-cloud ${cloudChosen() ? 'checked' : ''}><span><b>${t('Kopia w chmurze', 'Cloud backup')}</b><small>${t('Zdjęcia będą też na Twoim koncie i na innych urządzeniach.', 'Photos are also kept on your account and your other devices.')}</small></span></label>`
      : !signedIn() ? `<small class="text-soft">${t('Zaloguj się, aby móc włączyć kopię zdjęć w chmurze.', 'Sign in to be able to turn on a cloud backup of your photos.')}</small>` : '';
    box.innerHTML = `<div class="tp-photos-head"><h4>${t('Zdjęcia z podróży', 'Trip photos')}</h4>
      <div class="tp-photos-btns">${phone() ? `<button type="button" class="btn-grad" data-photo-take="camera"><i class="oi oi-camera" aria-hidden="true"></i> ${t('Zrób zdjęcie', 'Take a photo')}</button>
      <button type="button" class="btn-ghost" data-photo-take="gallery"><i class="fa-regular fa-images" aria-hidden="true"></i> ${t('Z galerii', 'From gallery')}</button>`
        : `<button type="button" class="btn-grad" data-photo-take="gallery"><i class="fa-regular fa-images" aria-hidden="true"></i> ${t('Dodaj zdjęcie', 'Add a photo')}</button>`}</div></div>
      ${localHtml || cloudHtml ? `<div class="tp-photo-grid">${localHtml}${cloudHtml}</div>${noteHtml}` : `<p class="text-soft">${t('Nie ma jeszcze zdjęć.', 'No photos yet.')}</p>`}
      <div class="tp-photos-foot"><small class="text-soft"><i class="fa-solid fa-mobile-screen" aria-hidden="true"></i> ${where}</small>${cloudRow}</div>`;
    for(const img of box.querySelectorAll('img[data-local]')){ const p = mine.find(x => x.id === img.dataset.local); if(p) img.src = localUrl(p); }
    for(const img of box.querySelectorAll('img[data-photo]')) thumb(img.dataset.photo).then(src => { if(src) img.src = src; });
  }

  const ask = (msg, opts) => window.askConfirm ? window.askConfirm(msg, opts) : Promise.resolve(confirm(msg));

  function mount(box, tripId){
    if(!box) return;
    box.dataset.trip = tripId;
    const refresh = (id) => { if(!box.isConnected){ listeners.delete(refresh); return; } if(id === tripId) render(box, tripId); };
    listeners.add(refresh);
    box.addEventListener('change', async (e) => {
      const sw = e.target.closest('[data-photo-cloud]'); if(!sw) return;
      sw.disabled = true; await setCloud(sw.checked); render(box, tripId);
    });
    box.addEventListener('click', async (e) => {
      const take = e.target.closest('[data-photo-take]');
      if(take){ try{ await add(tripId, await window.ONWARD.pickPhoto(take.dataset.photoTake)); }catch(err){ if(!/cancel/i.test(String(err && err.message))) console.warn('photo', err); } return; }
      const save = e.target.closest('[data-photo-save]');
      if(save){ const p = await getLocal(save.dataset.photoSave); if(p) saveToPhone(p); return; }
      const rm = e.target.closest('[data-photo-remove]');
      if(rm){
        const p = await getLocal(rm.dataset.photoRemove); if(!p) return;
        const inCloud = p.cloud === 'done' && p.serverId;
        const ok = await ask(t('Usunąć to zdjęcie z podróży?', 'Remove this photo from the trip?'), { ok: t('Usuń zdjęcie', 'Remove photo'), danger: true,
          detail: (isNative() ? t('Kopia w galerii telefonu zostaje.', 'The copy in your phone gallery stays.') + ' ' : '') + (inCloud ? t('Usuniemy też kopię w chmurze.', 'The cloud copy is deleted too.') : '') });
        if(!ok) return;
        await unqueue(p.id).catch(() => {});
        await removeLocal(p.id);
        if(localUrls.has(p.id)){ URL.revokeObjectURL(localUrls.get(p.id)); localUrls.delete(p.id); }
        if(inCloud) await api(`/api/photos/${p.serverId}`, { method: 'DELETE' }).catch(() => {});
        render(box, tripId); return;
      }
      const del = e.target.closest('[data-photo-delete]');
      if(del && await ask(t('Usunąć to zdjęcie z chmury?', 'Delete this photo from the cloud?'), { ok: t('Usuń zdjęcie', 'Delete photo'), danger: true })){ await api(`/api/photos/${del.dataset.photoDelete}`, { method: 'DELETE' }).catch(() => {}); render(box, tripId); return; }
      const retry = e.target.closest('[data-photo-retry]');
      if(retry){
        retry.disabled = true;
        for(const item of (await queued()).filter(x => x.tripId === tripId && (x.state === 'failed' || x.state === 'waiting'))){ item.state = 'queued'; item.error = ''; await putQueued(item); }
        changed(tripId); clearTimeout(retryTimer); run(); return;
      }
    });
    render(box, tripId);
    run();
  }

  window.TripPhotos = { mount, add, run, cloudAllowed, setCloud };
  if(document.readyState !== 'loading') setTimeout(run, 2000); else document.addEventListener('DOMContentLoaded', () => setTimeout(run, 2000));
})();
