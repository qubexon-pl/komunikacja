"use strict";
async function initializeUserMenu(){
  const response=await fetch('/api/auth/me');
  if(!response.ok) throw new Error('Nie udało się sprawdzić sesji logowania.');
  const {user}=await response.json();
  document.body.classList.toggle('guest', !user);
  if(!user){ document.getElementById('loginLink').href='/login?returnTo='+encodeURIComponent(location.pathname); return null; }
  document.getElementById('currentUser').textContent=user.displayName||user.email;
  const deleteAccountBtn=document.getElementById('deleteAccountBtn');
  deleteAccountBtn.disabled=true;
  fetch('/api/auth/config')
    .then(async configResponse=>{
      if(!configResponse.ok) throw new Error('Nie udało się sprawdzić konfiguracji poczty.');
      const config=await configResponse.json();
      deleteAccountBtn.disabled=!config.emailEnabled;
      if(!config.emailEnabled) deleteAccountBtn.title='Usuwanie konta wymaga skonfigurowanej usługi e-mail.';
    })
    .catch(error=>console.error('Błąd konfiguracji usuwania konta',error));
  return user;
}
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  const response=await fetch('/api/auth/logout',{method:'POST'});
  if(response.ok){ store('rzbus.favs', []); location.reload(); }
});
const deleteAccountModalElement=document.getElementById('deleteAccountModal');
const deleteAccountModal=bootstrap.Modal.getOrCreateInstance(deleteAccountModalElement);
const deleteAccountMessage=document.getElementById('deleteAccountMessage');
const requestDeleteCodeButton=document.getElementById('requestDeleteCodeBtn');
const confirmDeleteAccountButton=document.getElementById('confirmDeleteAccountBtn');
function showDeleteAccountMessage(text,kind='danger'){
  deleteAccountMessage.textContent=text;
  deleteAccountMessage.className=text?`alert alert-${kind} mb-3`:'alert d-none mb-3';
}
async function postAccountAction(endpoint,body){
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||'Nie udało się wykonać tej operacji.');
  return result;
}
document.getElementById('deleteAccountBtn').addEventListener('click',()=>{
  showDeleteAccountMessage('');
  document.getElementById('deleteAccountCodeStep').hidden=true;
  document.getElementById('deleteAccountCode').required=false;
  document.getElementById('confirmAccountDeletion').checked=false;
  requestDeleteCodeButton.hidden=false;
  confirmDeleteAccountButton.hidden=true;
  deleteAccountModal.show();
});
requestDeleteCodeButton.addEventListener('click',async()=>{
  requestDeleteCodeButton.disabled=true;
  try{
    await postAccountAction('/api/auth/account/delete',{});
    document.getElementById('deleteAccountCodeStep').hidden=false;
    document.getElementById('deleteAccountCode').required=true;
    requestDeleteCodeButton.hidden=true;
    confirmDeleteAccountButton.hidden=false;
    showDeleteAccountMessage('Kod potwierdzający został wysłany na Twój adres e-mail.','success');
    document.getElementById('deleteAccountCode').focus();
  }catch(error){ showDeleteAccountMessage(error.message); }
  finally{ requestDeleteCodeButton.disabled=false; }
});
confirmDeleteAccountButton.addEventListener('click',async()=>{
  const code=document.getElementById('deleteAccountCode').value.trim();
  if(!/^\d{6}$/.test(code)){
    showDeleteAccountMessage('Wpisz 6-cyfrowy kod z wiadomości e-mail.');
    return;
  }
  if(!document.getElementById('confirmAccountDeletion').checked){
    showDeleteAccountMessage('Zaznacz potwierdzenie, aby kontynuować.');
    return;
  }
  confirmDeleteAccountButton.disabled=true;
  try{
    await postAccountAction('/api/auth/account/delete/confirm',{code});
    deleteAccountModal.hide();
    store('rzbus.favs', []);
    location.assign('/');
  }catch(error){ showDeleteAccountMessage(error.message); }
  finally{ confirmDeleteAccountButton.disabled=false; }
});
const sessionUser=initializeUserMenu().catch(error=>{ console.error('Błąd sesji użytkownika',error); return null; });
/* ============================================================
   Konfiguracja
   ============================================================ */
const DEFAULTS = {
  threshold: 3,           // min — od tylu minut autobus jest „spóźniony” (czerwony)
  refresh: 20,            // s
  rtUrls: [
    'https://kmrzeszow.live/gtfs/rt/gtfsrt.pb',
    'https://www.mpkrzeszow.pl/gtfs/rt/gtfsrt.pb'
  ],
  staticUrls: [
    'https://mkuran.pl/gtfs/rzeszow.zip',
    'https://cdn.zbiorkom.live/gtfs/rzeszow.zip'
  ],
  proxy: 'auto',
  proxyCustom: '',
  demo: false,
  tiles: 'esri',
  gkey: '',
  traffic: true,
  // PKS Rzeszów (ZGPKS) — linie podmiejskie. Dokładne adresy z kmrzeszow.live/otwartedane można wkleić w Ustawieniach.
  pks: true,
  pksRtUrls: [
    'https://kmrzeszow.live/gtfs/rt/pks/gtfsrt.pb',
    'https://kmrzeszow.live/gtfs/pks/rt/gtfsrt.pb',
    'https://www.mpkrzeszow.pl/gtfs/rt/pks/gtfsrt.pb'
  ],
  pksStaticUrls: [
    'https://kmrzeszow.live/gtfs/pks.zip',
    'https://kmrzeszow.live/gtfs/pks/gtfs.zip',
    'https://www.mpkrzeszow.pl/gtfs/pks.zip'
  ],
  // Pociągi — Otwarte Dane Kolejowe PKP PLK (darmowy klucz: pdp-api.plk-sa.pl)
  trains: true,
  plkKey: '',
  // Pogoda — Open-Meteo (bez klucza)
  weather: true
};
const TZ = 'Europe/Warsaw';
const RZ_CENTER = [50.0378, 22.0049];

function store(k, v){ try{ if(v===undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); }catch(e){ return null; } }
// Jednorazowo: stare ustawienia źródeł i pamięć rozkładu potrafiły blokować wczytanie linii. Adresy PKS i klucze zostają.
if(store('rzbus.sourcesV')!==2){
  const saved=store('rzbus.cfg');
  if(saved){ delete saved.proxy; delete saved.proxyCustom; delete saved.staticUrls; store('rzbus.cfg', saved); }
  try{ indexedDB.deleteDatabase('rzbus'); }catch(e){}
  store('rzbus.sourcesV', 2);
}
let CFG = Object.assign({}, DEFAULTS, store('rzbus.cfg') || {});
if(CFG.proxy!=='custom') CFG.proxy='auto';
if(!TILE_KEYS_OK(CFG.tiles)) CFG.tiles='esri';
function TILE_KEYS_OK(k){ return ['esri','osm','hot','sat','carto','google'].includes(k); }

/* ============================================================
   Narzędzia czasu (strefa Europe/Warsaw)
   ============================================================ */
const dtf = new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function zparts(tsSec){ const o={}; for(const p of dtf.formatToParts(new Date(tsSec*1000))) o[p.type]=+p.value; return o; }
function tzOffset(tsSec){ const p=zparts(tsSec); return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)/1000 - Math.floor(tsSec); }
function midnightEpoch(y,m,d){ const g=Date.UTC(y,m-1,d,12,0,0)/1000; return g - tzOffset(g) - 12*3600; }
function nowSec(){ return Date.now()/1000; }
function todayMidnight(){ const p=zparts(nowSec()); return midnightEpoch(p.year,p.month,p.day); }
function dateStrMidnight(s){ return midnightEpoch(+s.slice(0,4), +s.slice(4,6), +s.slice(6,8)); }
function fmtClock(ts){ if(ts==null||!isFinite(ts)) return '—'; const p=zparts(ts); return String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0'); }
function fmtClockS(ts){ const p=zparts(ts); return [p.hour,p.minute,p.second].map(x=>String(x).padStart(2,'0')).join(':'); }
function parseHMS(s){ if(!s) return null; const a=s.split(':'); if(a.length<2) return null; return (+a[0])*3600 + (+a[1])*60 + (+(a[2]||0)); }
function fmtDelay(sec, short){
  if(sec==null) return 'brak danych';
  const a=Math.abs(Math.round(sec)), m=Math.floor(a/60), s=a%60;
  const body = m>0 ? (short ? `${m} min` : `${m} min${s?` ${s} s`:''}`) : `${s} s`;
  if(Math.abs(sec)<60) return 'na czas';
  return (sec>0?'+':'−')+body;
}
function ago(ts){ if(!ts) return '—'; const d=Math.max(0,Math.round(nowSec()-ts)); if(d<60) return d+' s temu'; if(d<3600) return Math.floor(d/60)+' min temu'; return fmtClock(ts); }
function toNum(x){ if(x==null) return null; if(typeof x==='object'){ if(typeof x.toNumber==='function') return x.toNumber(); if('low' in x) return (x.high>>>0)*4294967296+(x.low>>>0); } return Number(x); }
function has(o,k){ return o!=null && Object.prototype.hasOwnProperty.call(o,k); }
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function hav(a,b){ const R=6371000, toR=x=>x*Math.PI/180; const dLa=toR(b[0]-a[0]), dLo=toR(b[1]-a[1]);
  const h=Math.sin(dLa/2)**2+Math.cos(toR(a[0]))*Math.cos(toR(b[0]))*Math.sin(dLo/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function bearingOf(a,b){ const toR=x=>x*Math.PI/180; const y=Math.sin(toR(b[1]-a[1]))*Math.cos(toR(b[0]));
  const x=Math.cos(toR(a[0]))*Math.sin(toR(b[0]))-Math.sin(toR(a[0]))*Math.cos(toR(b[0]))*Math.cos(toR(b[1]-a[1])); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
function compass(deg){ if(deg==null) return '—'; return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg/45)%8]+` (${Math.round(deg)}°)`; }

/* ============================================================
   Pobieranie (bezpośrednio / przez proxy CORS)
   ============================================================ */
// Uwaga: bez AbortController/signal — niektóre podglądy (iframe) przekazują fetch przez postMessage
// i nie potrafią sklonować AbortSignal (DataCloneError). Limit czasu realizujemy przez Promise.race.
function withTimeout(promise, ms){ let tm; return Promise.race([promise, new Promise((_,rej)=>{ tm=setTimeout(()=>rej(new Error('przekroczono czas')), ms); })]).finally(()=>clearTimeout(tm)); }
async function fetchTimeout(url, ms){
  return withTimeout((async()=>{ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); const b = await r.arrayBuffer(); if(!b || b.byteLength===0) throw new Error('pusta odpowiedź'); return b; })(), ms);
}
function isZip(buf){ const b=new Uint8Array(buf,0,Math.min(2,buf.byteLength)); return b[0]===0x50 && b[1]===0x4B; } // „PK”
async function fetchBin(url, timeoutMs=20000, check){
  const tries=[CFG.proxy==='custom' && CFG.proxyCustom ? CFG.proxyCustom + encodeURIComponent(url) : url, '/api/feeds/fetch?url='+encodeURIComponent(url)]; // własny serwer: gdy źródło nie ma nagłówków CORS
  let lastErr;
  for(const u of tries){
    try{
      const buf = await fetchTimeout(u + (u.includes('?')?'&':'?') + '_=' + Date.now(), timeoutMs);
      if(check && !check(buf)){ lastErr=new Error('nieprawidłowa odpowiedź'); break; } // adres działa, ale nie ma tam pliku
      return buf;
    }catch(e){ lastErr=e; }
  }
  throw lastErr || new Error('Nie udało się pobrać');
}
async function fetchFirst(urls, timeout, check){
  let err; for(const u of urls){ try{ return {buf: await fetchBin(u, timeout, check), url:u}; }catch(e){ err=e; } }
  throw err;
}

/* ============================================================
   GTFS-Realtime (protobuf)
   ============================================================ */
const RT_PROTO = `
syntax = "proto2";
package transit_realtime;
message FeedMessage { optional FeedHeader header = 1; repeated FeedEntity entity = 2; }
message FeedHeader { optional string gtfs_realtime_version = 1; optional uint32 incrementality = 2; optional uint64 timestamp = 3; }
message FeedEntity { optional string id = 1; optional bool is_deleted = 2; optional TripUpdate trip_update = 3; optional VehiclePosition vehicle = 4; optional Alert alert = 5; }
message TripUpdate {
  optional TripDescriptor trip = 1; optional VehicleDescriptor vehicle = 3; repeated StopTimeUpdate stop_time_update = 2;
  optional uint64 timestamp = 4; optional int32 delay = 5;
  message StopTimeEvent { optional int32 delay = 1; optional int64 time = 2; optional int32 uncertainty = 3; }
  message StopTimeUpdate { optional uint32 stop_sequence = 1; optional string stop_id = 4; optional StopTimeEvent arrival = 2; optional StopTimeEvent departure = 3; optional uint32 schedule_relationship = 5; }
}
message VehiclePosition {
  optional TripDescriptor trip = 1; optional VehicleDescriptor vehicle = 8; optional Position position = 2;
  optional uint32 current_stop_sequence = 3; optional string stop_id = 7; optional uint32 current_status = 4 [default = 2];
  optional uint64 timestamp = 5; optional uint32 congestion_level = 6; optional uint32 occupancy_status = 9; optional uint32 occupancy_percentage = 10;
}
message Position { optional float latitude = 1; optional float longitude = 2; optional float bearing = 3; optional double odometer = 4; optional float speed = 5; }
message TripDescriptor { optional string trip_id = 1; optional string start_time = 2; optional string start_date = 3; optional uint32 schedule_relationship = 4; optional string route_id = 5; optional uint32 direction_id = 6; }
message VehicleDescriptor { optional string id = 1; optional string label = 2; optional string license_plate = 3; }
message Alert { repeated TimeRange active_period = 1; repeated EntitySelector informed_entity = 5; optional uint32 cause = 6; optional uint32 effect = 7; optional TranslatedString url = 8; optional TranslatedString header_text = 10; optional TranslatedString description_text = 11; }
message TimeRange { optional uint64 start = 1; optional uint64 end = 2; }
message EntitySelector { optional string agency_id = 1; optional string route_id = 2; optional int32 route_type = 3; optional TripDescriptor trip = 4; optional string stop_id = 5; }
message TranslatedString { repeated Translation translation = 1; message Translation { optional string text = 1; optional string language = 2; } }
`;
let FeedMessage = null;
function rtType(){ if(!FeedMessage){ FeedMessage = protobuf.parse(RT_PROTO,{keepCase:true}).root.lookupType('transit_realtime.FeedMessage'); } return FeedMessage; }
function tstr(ts){ if(!ts||!ts.translation||!ts.translation.length) return ''; const pl=ts.translation.find(t=>/^pl/i.test(t.language||'')); return (pl||ts.translation[0]).text||''; }

/* ============================================================
   GTFS statyczny (rozkład)
   ============================================================ */
const GT = { cal:new Map(), calDates:new Map(), loaded:false, routes:new Map(), trips:new Map(), stops:new Map(), stopTimes:new Map(), shapes:new Map(), source:null };
async function parseCSV(text, onRow){
  let cnt=0;
  if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
  let i=0, n=text.length, header=null;
  while(i<n){
    let end=text.indexOf('\n', i); if(end<0) end=n;
    let line=text.slice(i,end); i=end+1;
    if(line.endsWith('\r')) line=line.slice(0,-1);
    if(!line) continue;
    let cells;
    if(line.indexOf('"')<0) cells=line.split(',');
    else {
      // obsługa cudzysłowów (również z przełamaniem linii)
      while((line.split('"').length-1)%2===1 && i<n){ let e2=text.indexOf('\n',i); if(e2<0) e2=n; line+='\n'+text.slice(i,e2).replace(/\r$/,''); i=e2+1; }
      cells=[]; let cur='', q=false;
      for(let k=0;k<line.length;k++){ const c=line[k];
        if(q){ if(c==='"'){ if(line[k+1]==='"'){cur+='"';k++;} else q=false; } else cur+=c; }
        else if(c==='"') q=true; else if(c===','){cells.push(cur);cur='';} else cur+=c; }
      cells.push(cur);
    }
    if(!header){ header={}; cells.forEach((c,ix)=>header[c.trim()]=ix); continue; }
    onRow(cells, header);
    if(++cnt % 12000 === 0) await new Promise(r=>setTimeout(r,0));   // oddaj wątek — UI pozostaje płynne
  }
}
function idbOpen(){ return new Promise((res,rej)=>{ try{ const r=indexedDB.open('rzbus',1); r.onupgradeneeded=()=>r.result.createObjectStore('kv'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }catch(e){ rej(e); } }); }
async function idbGet(k){ try{ const db=await idbOpen(); return await new Promise(res=>{ const q=db.transaction('kv').objectStore('kv').get(k); q.onsuccess=()=>res(q.result||null); q.onerror=()=>res(null); }); }catch(e){ return null; } }
async function idbSet(k,v){ try{ const db=await idbOpen(); db.transaction('kv','readwrite').objectStore('kv').put(v,k); }catch(e){} }
function clearGtfsFeed(agency){
  const routeIds=new Set([...GT.routes.values()].filter(route=>route.agency===agency).map(route=>route.id));
  const trips=[...GT.trips.values()].filter(trip=>routeIds.has(trip.route));
  for(const trip of trips){ GT.trips.delete(trip.id); GT.stopTimes.delete(trip.id); }
  for(const routeId of routeIds) GT.routes.delete(routeId);
  for(const [id,stop] of GT.stops) if(stop.agency===agency) GT.stops.delete(id);
  const serviceIds=new Set(trips.map(trip=>trip.service));
  for(const id of serviceIds){ GT.cal.delete(id); GT.calDates.delete(id); }
  for(const id of new Set(trips.map(trip=>trip.shape).filter(Boolean))) GT.shapes.delete(id);
}
function hydrateGtfsFeed(feed){
  for(const route of feed.routes) GT.routes.set(route.id, route);
  for(const trip of feed.trips) GT.trips.set(trip.id, trip);
  for(const stop of feed.stops) GT.stops.set(stop.id, stop);
  for(const stopTime of feed.stopTimes){
    let rows=GT.stopTimes.get(stopTime.trip_id);
    if(!rows){ rows=[]; GT.stopTimes.set(stopTime.trip_id,rows); }
    rows.push({seq:stopTime.sequence, stop:stopTime.stop_id, arr:stopTime.arrival_seconds, dep:stopTime.departure_seconds});
  }
  for(const rows of GT.stopTimes.values()) rows.sort((a,b)=>a.seq-b.seq);
  for(const service of feed.calendar) GT.cal.set(service.service_id,{days:service.days,start:service.start,end:service.end});
  for(const exception of feed.calendarDates){
    let dates=GT.calDates.get(exception.service_id);
    if(!dates){ dates=new Map(); GT.calDates.set(exception.service_id,dates); }
    dates.set(exception.date,exception.exception_type);
  }
  for(const shape of feed.shapes) GT.shapes.set(shape.id,shape.points);
}
async function loadGtfsFeed(urls, pfx, agency, cacheKey, progress){
  const P = x => (x==null||x==='') ? x : pfx + x;
  const key=urls.join('|');
  let buf, url;
  if(key===(agency==='pks'?DEFAULTS.pksStaticUrls:DEFAULTS.staticUrls).join('|')){ // własne adresy z Ustawień pobieramy bezpośrednio
    try{
      progress(`Pobieranie rozkładu ${agency.toUpperCase()} w tle…`);
      const stored=await withTimeout(fetch('/api/schedule/'+agency), 60000);
      if(stored.ok){ const feed=await stored.json(); clearGtfsFeed(agency); hydrateGtfsFeed(feed); return 'baza danych'; }
    }catch(e){ console.warn(`Baza nie udostępniła rozkładu ${agency.toUpperCase()}.`,e); }
    try{
      const r=await withTimeout(fetch('/api/timetable/'+agency), 60000);
      if(r.ok){ const b=await r.arrayBuffer(); if(isZip(b)){ buf=b; url='serwer aplikacji'; } }
    }catch(e){ console.warn(`Serwer nie udostępnił rozkładu ${agency.toUpperCase()}.`,e); }
  }
  const cached = buf ? null : await idbGet(cacheKey);
  const usable=cached && cached.buf && isZip(cached.buf);
  if(buf){ /* gotowe */ }
  else if(usable && cached.key===key && Date.now()-cached.t < 12*3600*1000){ buf=cached.buf; url=cached.url+' (pamięć podręczna)'; }
  else {
    try{ progress(`Pobieranie rozkładu ${agency.toUpperCase()} w tle…`); ({buf,url} = await fetchFirst(urls, 60000, isZip)); idbSet(cacheKey, {key, t:Date.now(), buf, url}); }
    catch(e){ if(usable){ buf=cached.buf; url=cached.url+' (starsza kopia)'; } else throw e; }
  }
  const L_ = agency.toUpperCase();
  progress(`${L_}: przygotowywanie rozkładu…`);
  const zip = await JSZip.loadAsync(buf);
  clearGtfsFeed(agency);
  const read = async name => { const f = zip.file(name) || zip.file(new RegExp('(^|/)'+name.replace('.','\\.')+'$'))[0]; return f ? f.async('string') : null; };
  await parseCSV(await read('routes.txt')||'', (c,h)=>{ GT.routes.set(P(c[h.route_id]), {id:P(c[h.route_id]), short:c[h.route_short_name]||c[h.route_id], long:c[h.route_long_name]||'', color:c[h.route_color]?('#'+c[h.route_color]):null, text:c[h.route_text_color]?('#'+c[h.route_text_color]):null, type:+c[h.route_type], agency}); });
  progress(`${L_}: kursy…`);
  await parseCSV(await read('trips.txt')||'', (c,h)=>{ GT.trips.set(P(c[h.trip_id]), {id:P(c[h.trip_id]), route:P(c[h.route_id]), service:P(c[h.service_id]), headsign:c[h.trip_headsign]||'', dir:c[h.direction_id], shape:h.shape_id!=null?P(c[h.shape_id]):null, block:h.block_id!=null?c[h.block_id]:null, brigade:h.brigade!=null?c[h.brigade]:(h.block_short_name!=null?c[h.block_short_name]:null)}); });
  progress(`${L_}: przystanki…`);
  await parseCSV(await read('stops.txt')||'', (c,h)=>{ GT.stops.set(P(c[h.stop_id]), {id:P(c[h.stop_id]), name:c[h.stop_name], code:h.stop_code!=null?c[h.stop_code]:'', lat:+c[h.stop_lat], lon:+c[h.stop_lon], agency}); });
  progress(`${L_}: godziny odjazdów…`);
  const newTrips=[];
  await parseCSV(await read('stop_times.txt')||'', (c,h)=>{
    const t=P(c[h.trip_id]); let a=GT.stopTimes.get(t); if(!a){a=[];GT.stopTimes.set(t,a);newTrips.push(a);}
    const arr=parseHMS(c[h.arrival_time]), dep=parseHMS(c[h.departure_time]);
    a.push({seq:+c[h.stop_sequence], stop:P(c[h.stop_id]), arr:arr??dep, dep:dep??arr});
  });
  for(const a of newTrips) a.sort((x,y)=>x.seq-y.seq);
  progress(`${L_}: kalendarz…`);
  await parseCSV(await read('calendar.txt')||'', (c,h)=>{ GT.cal.set(P(c[h.service_id]), {days:['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d=>c[h[d]]==='1'), start:c[h.start_date], end:c[h.end_date]}); });
  await parseCSV(await read('calendar_dates.txt')||'', (c,h)=>{ const sid=P(c[h.service_id]); let m=GT.calDates.get(sid); if(!m){m=new Map();GT.calDates.set(sid,m);} m.set(c[h.date], +c[h.exception_type]); });
  const shapesT = await read('shapes.txt');
  if(shapesT){ progress(`${L_}: przebiegi tras…`);
    const tmp=new Map();
    await parseCSV(shapesT, (c,h)=>{ const sh=P(c[h.shape_id]); let a=tmp.get(sh); if(!a){a=[];tmp.set(sh,a);} a.push([+c[h.shape_pt_sequence], +c[h.shape_pt_lat], +c[h.shape_pt_lon]]); });
    for(const [k,a] of tmp){ a.sort((x,y)=>x[0]-y[0]); GT.shapes.set(k, a.map(q=>[q[1],q[2]])); }
  }
  return url;
}
GT.sources={};
async function loadStatic(progress, onReady){
  // Zapisane ustawienia mogą wskazywać nieaktualny adres, dlatego domyślne źródła zawsze są na końcu listy.
  const withDefaults=(urls,defaults)=>[...new Set([...(urls||[]),...defaults])];
  GT.sources.ztm = await loadGtfsFeed(withDefaults(CFG.staticUrls,DEFAULTS.staticUrls), '', 'ztm', 'gtfs', progress);
  GT.loaded=true; GT.source=GT.sources.ztm;
  onReady();
  if(CFG.pks){
    try{ GT.sources.pks = await loadGtfsFeed(withDefaults(CFG.pksStaticUrls,DEFAULTS.pksStaticUrls), 'pks:', 'pks', 'gtfs-pks', progress); }
    catch(e){ console.warn('Brak rozkładu PKS', e); GT.sources.pks=null;
      S.alerts.push({id:'nopks', header:'Nie wczytano rozkładu PKS', desc:'Linie podmiejskie PKS nie są dostępne w wyszukiwarce i liście linii. Wklej poprawny adres pliku GTFS PKS (z kmrzeszow.live/otwartedane) w Ustawieniach.', routes:[], stops:[]}); }
    onReady();
  }
}

/* ============================================================
   Stan aplikacji
   ============================================================ */
const S = {
  mode:'loading',          // live | demo | loading | error
  vehicles:new Map(),      // id -> vehicle model
  tripUpdates:new Map(),
  alerts:[],
  feedTs:null, lastOk:null, lastErr:null,
  filter:'all', query:'', agency:'ztm',
  selected:null, follow:false, routeLayer:null,
  prevPos:new Map()
};

const LINE_PALETTE = ['#181818','#DA291C','#3c3c3c','#8a1a12','#5a5a5a','#b3231a'];
const PKS_PALETTE = ['#1F5E3B','#2E6B4A','#24513A','#356F57'];
function lineColor(short, gtfsColor, agency){
  if(gtfsColor && gtfsColor!=='#FFFFFF' && gtfsColor!=='#ffffff') return gtfsColor;
  let h=0; for(const ch of String(short)) h=(h*31+ch.charCodeAt(0))>>>0;
  const pal = agency==='pks' ? PKS_PALETTE : LINE_PALETTE; return pal[h%pal.length];
}
const AGENCY_LABEL = {ztm:'ZTM', pks:'PKS', kolej:'Kolej'};
function statusOf(delay){
  if(delay==null) return 'unknown';
  if(delay >= CFG.threshold*60) return 'late';
  if(delay >= 60) return 'minor';
  if(delay <= -60) return 'early';
  return 'ok';
}
const STATUS_COLOR = {late:'#DA291C', minor:'#F2B200', ok:'#1F7A4D', early:'#1E5AA8', unknown:'#8F8F8F'};
const STATUS_TEXT = {minor:'#111'};
const STATUS_LABEL = {late:'Spóźniony', minor:'Lekko spóźniony', ok:'Na czas', early:'Przed czasem', unknown:'Brak danych o punktualności'};
const STOP_STATUS = {0:'Dojeżdża do:', 1:'Na przystanku:', 2:'W drodze do:'};
const OCCUPANCY = {0:'Pusty',1:'Dużo wolnych miejsc',2:'Mało wolnych miejsc',3:'Tylko miejsca stojące',4:'Bardzo tłoczno',5:'Pełny',6:'Nie przyjmuje pasażerów',7:'Brak danych',8:'Nie można wsiąść'};
const CONGESTION = {0:'Nieznane',1:'Płynny ruch',2:'Ruch „stop and go”',3:'Korek',4:'Duży korek'};

/* ---------- Rozkład kursu dla pojazdu (live) ---------- */
function serviceBase(trip, st){
  if(trip && trip.start_date) return dateStrMidnight(trip.start_date);
  const base=todayMidnight(); const now=nowSec();
  if(st && st.length){ const first=st[0].dep; if(now-base < 4*3600 && first >= 20*3600) return base-86400; }
  return base;
}
function buildLiveSchedule(v){
  const st = v.tripId ? GT.stopTimes.get(v.tripId) : null;
  if(!st || !st.length) return null;
  const base = serviceBase(v.rtTrip, st);
  return st.map(s=>({seq:s.seq, stopId:s.stop, name:(GT.stops.get(s.stop)||{}).name||s.stop, arr:base+s.arr, dep:base+s.dep}));
}
function estimateDelay(v, sched){
  // Szacunek: pozycja w kursie vs. rozkład (gdy feed nie podaje opóźnienia)
  if(!sched) return null;
  const now = v.ts || nowSec();
  let idx = -1;
  if(v.stopSeq!=null) idx = sched.findIndex(s=>s.seq===v.stopSeq);
  if(idx<0 && v.stopId) idx = sched.findIndex(s=>s.stopId===v.stopId);
  if(idx<0){ // najbliższy przystanek geograficznie
    let best=1e12; sched.forEach((s,i)=>{ const st=GT.stops.get(s.stopId); if(st){ const d=hav([v.lat,v.lon],[st.lat,st.lon]); if(d<best){best=d; idx=i;} } });
    if(idx<0 || best>1500) return null;
    const st=GT.stops.get(sched[idx].stopId);
    if(best<80) return now - sched[idx].dep;
  }
  const cur = sched[idx];
  if(v.stopStatus===1){ if(now < cur.arr) return now - cur.arr; if(now <= cur.dep) return 0; return now - cur.dep; }
  // w drodze do cur: między poprzednim odjazdem a przyjazdem do cur — interpolacja po odległości
  const prev = sched[idx-1];
  if(!prev) return now - cur.dep;
  const a=GT.stops.get(prev.stopId), b=GT.stops.get(cur.stopId);
  let frac=0.5; if(a&&b){ const dAB=hav([a.lat,a.lon],[b.lat,b.lon]), dA=hav([a.lat,a.lon],[v.lat,v.lon]); if(dAB>0) frac=Math.min(1,Math.max(0,dA/dAB)); }
  const expected = prev.dep + frac*(cur.arr - prev.dep);
  return now - expected;
}
function rtDelay(v, sched){
  const tu = v.tripId ? S.tripUpdates.get(v.tripId) : null;
  if(!tu) return null;
  const list = tu.stu||[];
  let pick=null;
  if(list.length){
    if(v.stopSeq!=null) pick = list.find(s=>s.seq!=null && s.seq>=v.stopSeq) || null;
    if(!pick && v.stopId){ const i=list.findIndex(s=>s.stopId===v.stopId); if(i>=0) pick=list[i]; }
    if(!pick) pick = list[0];
  }
  if(pick){
    const ev = pick.arr || pick.dep;
    if(ev && ev.delay!=null) return ev.delay;
    if(ev && ev.time!=null && sched){
      const s = sched.find(x=>(pick.seq!=null && x.seq===pick.seq) || (pick.stopId && x.stopId===pick.stopId));
      if(s) return ev.time - (pick.arr?s.arr:s.dep);
    }
  }
  if(tu.delay!=null) return tu.delay;
  return null;
}
function predictTimes(v, sched){
  // Zwraca rozkład z prognozą (propagacja opóźnienia + aktualizacje z Trip Updates)
  if(!sched) return null;
  const tu = v.tripId ? S.tripUpdates.get(v.tripId) : null;
  const bySeq=new Map(), byStop=new Map();
  if(tu) for(const s of tu.stu){ if(s.seq!=null) bySeq.set(s.seq,s); if(s.stopId) byStop.set(s.stopId,s); }
  let curIdx = -1;
  if(v.stopSeq!=null) curIdx = sched.findIndex(s=>s.seq===v.stopSeq);
  if(curIdx<0 && v.stopId) curIdx = sched.findIndex(s=>s.stopId===v.stopId);
  if(curIdx<0){ let best=1e12; sched.forEach((s,i)=>{ const st=GT.stops.get(s.stopId); if(st){ const d=hav([v.lat,v.lon],[st.lat,st.lon]); if(d<best){best=d;curIdx=i;} } }); }
  let carry = v.delay ?? 0;
  return sched.map((s,i)=>{
    const u = bySeq.get(s.seq) || byStop.get(s.stopId);
    if(u){ const ev=u.arr||u.dep; if(ev){ if(ev.delay!=null) carry=ev.delay; else if(ev.time!=null) carry=ev.time-(u.arr?s.arr:s.dep); } }
    return Object.assign({}, s, {pred: s.arr + (i>=curIdx ? carry : 0), delay: i>=curIdx?carry:null, passed: i<curIdx, current: i===curIdx});
  });
}

/* ---------- Odświeżanie danych LIVE ---------- */
S.feedStatus={};
function liveFeeds(){
  const f=[{name:'ztm', urls:CFG.rtUrls, pfx:''}];
  if(CFG.pks && CFG.pksRtUrls && CFG.pksRtUrls.length) f.push({name:'pks', urls:CFG.pksRtUrls, pfx:'pks:'});
  return f;
}
// Pobieranie kanału może trwać ponad minutę, gdy zawodzą wszystkie adresy i pośredniki. Trwa wtedy w tle,
// a pierwszy kanał (ZTM) nie czeka na pozostałe — ich dane trafią na mapę przy kolejnym odświeżeniu.
const FEED_GRACE_MS=2500;
const feedJobs=new Map(), feedLast=new Map();
function fetchFeed(f){
  const key=f.urls.join('|');
  if(!feedJobs.has(key)) feedJobs.set(key, fetchFirst(f.urls, 15000)
    .then(r=>{ feedLast.set(key,r); return r; }, e=>{ feedLast.delete(key); throw e; })
    .finally(()=>feedJobs.delete(key)));
  return feedJobs.get(key);
}
function feedResult(f,i){
  const job=fetchFeed(f); if(i===0) return job;
  const late=new Error('kanał wciąż się wczytuje');
  return Promise.race([job, new Promise((_,rej)=>setTimeout(()=>rej(late), FEED_GRACE_MS))])
    .catch(e=>{ const last=feedLast.get(f.urls.join('|')); if(e===late && last) return last; throw e; });
}
async function refreshLive(){
  const feeds=liveFeeds();
  const res = await Promise.allSettled(feeds.map(feedResult));
  const tus=new Map(), alerts=[], vehicles=[]; let ts=0, okAny=false;
  res.forEach((r,i)=>{
    const f=feeds[i];
    if(r.status!=='fulfilled'){ S.feedStatus[f.name]='error'; return; }
    let msg; try{ msg = rtType().decode(new Uint8Array(r.value.buf)); }catch(e){ S.feedStatus[f.name]='error'; return; }
    okAny=true; S.feedStatus[f.name]='ok';
    const P = x => (x==null||x==='') ? x : f.pfx + x;
    ts=Math.max(ts, toNum(msg.header && msg.header.timestamp)||0);
    for(const e of msg.entity||[]){
      if(e.is_deleted) continue;
      if(e.trip_update && e.trip_update.trip){
        const tu=e.trip_update, tid=resolveTripId(P(tu.trip.trip_id));
        const stu=(tu.stop_time_update||[]).map(x=>({
          seq: has(x,'stop_sequence')?x.stop_sequence:null, stopId: has(x,'stop_id')?P(x.stop_id):null, rel:x.schedule_relationship||0,
          arr: x.arrival ? {delay:has(x.arrival,'delay')?x.arrival.delay:null, time:has(x.arrival,'time')?toNum(x.arrival.time):null} : null,
          dep: x.departure ? {delay:has(x.departure,'delay')?x.departure.delay:null, time:has(x.departure,'time')?toNum(x.departure.time):null} : null
        }));
        const trip=Object.assign({}, tu.trip, {trip_id:tid, route_id:P(tu.trip.route_id)});
        const rec={trip, stu, delay:has(tu,'delay')?tu.delay:null, ts:toNum(tu.timestamp), vehicle:tu.vehicle};
        if(tid) tus.set(tid, rec);
        if(tu.vehicle && tu.vehicle.id) tus.set('veh:'+f.pfx+tu.vehicle.id, rec);
      }
      if(e.alert){
        const al=e.alert; const now=nowSec();
        const active=!al.active_period||!al.active_period.length||al.active_period.some(q=>(!toNum(q.start)||toNum(q.start)<=now)&&(!toNum(q.end)||toNum(q.end)>=now));
        if(active) alerts.push({id:f.pfx+e.id, agency:f.name, header:tstr(al.header_text), desc:tstr(al.description_text), url:tstr(al.url), routes:[...new Set((al.informed_entity||[]).map(x=>P(x.route_id||(x.trip&&x.trip.route_id))).filter(Boolean))], stops:(al.informed_entity||[]).map(x=>P(x.stop_id)).filter(Boolean)});
      }
      if(e.vehicle && e.vehicle.position) vehicles.push({e, f, P});
    }
  });
  if(!okAny) throw new Error('Żaden kanał GTFS-RT nie odpowiada');
  S.tripUpdates = tus; S.alerts = alerts.concat(S.alerts.filter(a=>a.id==='nopks'||a.id==='nogtfs'));
  S.feedTs = ts || nowSec();
  const next=new Map();
  for(const {e, f, P} of vehicles){
    const vp=e.vehicle, p=vp.position;
    if(!p.latitude || !p.longitude) continue;
    const rawId = (vp.vehicle && (vp.vehicle.id||vp.vehicle.label)) || e.id;
    const vid = f.pfx + rawId;
    let trip = vp.trip ? Object.assign({}, vp.trip, {trip_id:resolveTripId(P(vp.trip.trip_id)), route_id:P(vp.trip.route_id)}) : null;
    let tripId = trip && trip.trip_id || null;
    if(!tripId){ const tu=S.tripUpdates.get('veh:'+vid); if(tu){ trip=tu.trip; tripId=tu.trip.trip_id; } }
    const gtrip = tripId ? GT.trips.get(tripId) : null;
    const routeId = (trip && trip.route_id) || (gtrip && gtrip.route) || null;
    const groute = routeId ? GT.routes.get(routeId) : null;
    const short = groute ? groute.short : (routeId ? String(routeId).replace(/^pks:/,'') : '—');
    const lat=p.latitude, lon=p.longitude;
    let bearing = has(p,'bearing') ? p.bearing : null;
    const prev = S.prevPos.get(vid);
    if(bearing==null && prev && hav(prev,[lat,lon])>8) bearing = bearingOf(prev,[lat,lon]);
    if(bearing==null && S.vehicles.get(vid)) bearing = S.vehicles.get(vid).bearing;
    S.prevPos.set(vid,[lat,lon]);
    const v = {
      id:vid, agency:f.name, label:(vp.vehicle&&vp.vehicle.label)||rawId, plate:(vp.vehicle&&vp.vehicle.license_plate)||'',
      lat, lon, bearing, speed: has(p,'speed') ? p.speed*3.6 : null, odometer: has(p,'odometer')?p.odometer:null,
      ts: toNum(vp.timestamp) || S.feedTs,
      tripId, rtTrip:trip, routeId, short, color: lineColor(short, groute&&groute.color, f.name),
      routeLong: groute ? groute.long : '', headsign: gtrip ? gtrip.headsign : '', brigade: gtrip ? (gtrip.brigade||gtrip.block) : null,
      startTime: trip && trip.start_time, startDate: trip && trip.start_date,
      stopSeq: has(vp,'current_stop_sequence') ? vp.current_stop_sequence : null,
      stopId: has(vp,'stop_id') ? P(vp.stop_id) : null,
      stopStatus: vp.current_status!=null ? vp.current_status : 2,
      occupancy: has(vp,'occupancy_status') ? vp.occupancy_status : null, occupancyPct: has(vp,'occupancy_percentage')?vp.occupancy_percentage:null,
      congestion: has(vp,'congestion_level') ? vp.congestion_level : null,
      canceled: trip && trip.schedule_relationship===3
    };
    const sched = buildLiveSchedule(v);
    v.hasSchedule = !!sched;
    let d = rtDelay(v, sched), src='rt';
    if(d==null){ d = estimateDelay(v, sched); src = d==null ? null : 'est'; }
    v.delay = d==null ? null : Math.round(d); v.delaySrc = src;
    if(!v.headsign && sched) v.headsign = sched[sched.length-1].name;
    if(v.stopId==null && v.stopSeq!=null && sched){ const x=sched.find(y=>y.seq===v.stopSeq); if(x) v.stopId=x.stopId; }
    v.stopName = v.stopId ? ((GT.stops.get(v.stopId)||{}).name || v.stopId) : null;
    next.set(vid, v);
  }
  S.vehicles = next;
}

/* ============================================================
   Tryb DEMO — symulacja, gdy źródła są niedostępne
   ============================================================ */
const DEMO_STOPS = {
  'Dworzec Główny':[50.0434,22.0067],'Piłsudskiego':[50.0367,22.0049],'Galeria Rzeszów':[50.0343,22.0016],'Rondo Dmowskiego':[50.0402,21.9984],
  'Lwowska':[50.0336,22.0190],'Uniwersytet Rzeszowski':[50.0302,22.0133],'Politechnika':[50.0189,21.9893],'Powstańców Warszawy':[50.0235,21.9928],
  'Podkarpacka':[50.0130,21.9790],'Budziwój':[49.9930,21.9800],'Drabinianka':[50.0105,21.9945],'Kotuli':[50.0060,22.0185],'Zalesie':[50.0160,22.0430],
  'Nowe Miasto':[50.0270,22.0300],'Pobitno':[50.0440,22.0300],'Słocina':[50.0560,22.0520],'Sikorskiego':[50.0510,22.0180],'Załęże':[50.0700,22.0060],
  'Lubelska':[50.0560,21.9990],'Staroniwa':[50.0525,21.9860],'Wilkowyja':[50.0620,21.9630],'Krakowska':[50.0390,21.9800],'Baranówka':[50.0420,21.9600],
  'Bzianka':[50.0330,21.9330],'Przybyszówka':[50.0230,21.9570],'Rejtana':[50.0250,22.0100],'Hetmańska':[50.0230,22.0020],'Kwiatkowskiego':[50.0060,22.0050],
  'Warszawska':[50.0470,21.9960],'Szpital Wojewódzki':[50.0275,22.0215],'Plac Kilińskiego':[50.0390,22.0030],'Strzelnica':[50.0320,22.0240],
  'Tyczyn Rynek':[49.9636,22.0340],'Łańcut Dworzec':[50.0687,22.2285],'Krasne':[50.0530,22.0830],'Głogów Małopolski Rynek':[50.1505,21.9622],'Trzebownisko':[50.0874,22.0370],'Boguchwała Rynek':[49.9852,21.9440],'Matysówka':[49.9880,22.0300],'Wólka Podleśna':[50.1020,21.9790]
};
const DEMO_LINES = [
  ['0A','#181818',['Dworzec Główny','Piłsudskiego','Lwowska','Strzelnica','Nowe Miasto','Pobitno','Sikorskiego','Lubelska','Warszawska','Rondo Dmowskiego','Dworzec Główny']],
  ['1','#DA291C',['Załęże','Lubelska','Warszawska','Rondo Dmowskiego','Piłsudskiego','Galeria Rzeszów','Hetmańska','Kwiatkowskiego','Budziwój']],
  ['3','#3c3c3c',['Baranówka','Krakowska','Rondo Dmowskiego','Plac Kilińskiego','Piłsudskiego','Lwowska','Szpital Wojewódzki','Zalesie']],
  ['6','#8a1a12',['Bzianka','Przybyszówka','Powstańców Warszawy','Politechnika','Rejtana','Uniwersytet Rzeszowski','Strzelnica','Pobitno','Słocina']],
  ['8','#5a5a5a',['Wilkowyja','Staroniwa','Warszawska','Dworzec Główny','Piłsudskiego','Lwowska','Nowe Miasto']],
  ['14','#b3231a',['Drabinianka','Powstańców Warszawy','Hetmańska','Galeria Rzeszów','Piłsudskiego','Dworzec Główny','Sikorskiego','Słocina']],
  ['18','#181818',['Budziwój','Podkarpacka','Politechnika','Powstańców Warszawy','Rondo Dmowskiego','Staroniwa','Wilkowyja']],
  ['21','#DA291C',['Kotuli','Kwiatkowskiego','Rejtana','Uniwersytet Rzeszowski','Lwowska','Piłsudskiego','Plac Kilińskiego','Krakowska','Baranówka']],
  ['27','#3c3c3c',['Zalesie','Szpital Wojewódzki','Strzelnica','Pobitno','Dworzec Główny','Warszawska','Lubelska','Załęże']],
  ['30','#8a1a12',['Przybyszówka','Krakowska','Rondo Dmowskiego','Dworzec Główny','Pobitno','Słocina']],
  ['37','#5a5a5a',['Bzianka','Baranówka','Krakowska','Galeria Rzeszów','Hetmańska','Kotuli','Zalesie']],
  ['48','#b3231a',['Staroniwa','Lubelska','Sikorskiego','Pobitno','Nowe Miasto','Zalesie']],
  ['50','#181818',['Załęże','Sikorskiego','Dworzec Główny','Piłsudskiego','Rejtana','Kwiatkowskiego','Drabinianka']],
  ['57','#DA291C',['Politechnika','Podkarpacka','Kwiatkowskiego','Kotuli','Zalesie','Nowe Miasto','Pobitno']],
  // PKS (linie podmiejskie) — czwarty element: przewoźnik
  ['225','#1F5E3B',['Dworzec Główny','Pobitno','Słocina','Krasne','Łańcut Dworzec'],'pks'],
  ['304','#2E6B4A',['Dworzec Główny','Piłsudskiego','Lwowska','Zalesie','Matysówka','Tyczyn Rynek'],'pks'],
  ['120','#24513A',['Dworzec Główny','Warszawska','Lubelska','Wólka Podleśna','Głogów Małopolski Rynek'],'pks'],
  ['412','#356F57',['Dworzec Główny','Sikorskiego','Załęże','Trzebownisko'],'pks'],
  ['508','#1F5E3B',['Dworzec Główny','Galeria Rzeszów','Powstańców Warszawy','Podkarpacka','Boguchwała Rynek'],'pks']
];
const DEMO = {buses:[], built:false};
function demoBuild(){
  let seed=20261102; const rnd=()=>((seed=(seed*1103515245+12345)>>>0)/4294967296);
  let vid=1100;
  for(const [short,color,names,ag] of DEMO_LINES){
    const agency=ag||'ztm', rid=(agency==='pks'?'pks:':'')+short;
    for(const dir of [0,1]){
      const nm = dir? [...names].reverse() : names;
      const pts = nm.map(n=>DEMO_STOPS[n]);
      const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+hav(pts[i-1],pts[i])*1.25);
      const speed = (agency==='pks'?34:21)/3.6; // m/s średnio
      const dur = cum[cum.length-1]/speed;
      const n = 2 + Math.floor(rnd()*2);
      for(let k=0;k<n;k++){
        const r=rnd(); let baseDelay;
        if(r<0.52) baseDelay = (rnd()*70)-20; else if(r<0.72) baseDelay = 60+rnd()*120; else if(r<0.93) baseDelay = 180+rnd()*560; else baseDelay = -60-rnd()*100;
        DEMO.buses.push({id:(agency==='pks'?'pks:':'')+String(vid++), agency, rid, plate:'RZ '+(10000+Math.floor(rnd()*89999)), short, color, names:nm, pts, cum, dur, phase:(k/n)+rnd()*0.15, baseDelay, wob:rnd()*6.28, dir, brigade:short+'/'+(k+1+dir*3), occ:Math.floor(rnd()*4)});
      }
    }
  }
  DEMO.built=true;
}
function demoRefresh(){
  if(!DEMO.built) demoBuild();
  if(!GT.loaded) demoBuildGT();
  const now=nowSec(); const next=new Map();
  for(const b of DEMO.buses){
    const period = b.dur + 360;
    const delay = Math.round(b.baseDelay + 50*Math.sin(now/240 + b.wob));
    const tripStart = Math.floor((now - delay - b.phase*period)/period)*period + b.phase*period; // planowy start bieżącego kursu
    let el = now - delay - tripStart;          // czas „wg rozkładu” od startu kursu
    el = Math.min(Math.max(el,0), b.dur);
    const dist = el/b.dur * b.cum[b.cum.length-1];
    let i=1; while(i<b.cum.length-1 && b.cum[i]<dist) i++;
    const segL=b.cum[i]-b.cum[i-1], f= segL>0 ? (dist-b.cum[i-1])/segL : 0;
    const a=b.pts[i-1], c=b.pts[i];
    const lat=a[0]+(c[0]-a[0])*f, lon=a[1]+(c[1]-a[1])*f;
    const sched = b.names.map((n,j)=>({seq:j+1, stopId:'demo:'+n, name:n, arr:tripStart + b.cum[j]/b.cum[b.cum.length-1]*b.dur, dep:tripStart + b.cum[j]/b.cum[b.cum.length-1]*b.dur + (j? 20:0)}));
    const atStop = f<0.05 || f>0.95;
    const curIdx = f>0.95 ? i : (f<0.05 ? i-1 : i);
    next.set(b.id, {
      id:b.id, agency:b.agency, label:String(b.id).replace(/^pks:/,''), plate:b.plate, lat, lon, bearing:bearingOf(a,c), speed: atStop?0:18+Math.round(14*Math.abs(Math.sin(now/37+b.wob))),
      ts: now - Math.floor(Math.random()*8), tripId:`DEMO_${b.rid}_${b.id}_${Math.round(tripStart)}`, routeId:b.rid, short:b.short, color:b.color,
      routeLong: b.names[0]+' – '+b.names[b.names.length-1], headsign:b.names[b.names.length-1], brigade:b.brigade,
      startTime: fmtClock(tripStart)+':00', stopSeq:curIdx+1, stopId:'demo:'+b.names[curIdx], stopName:b.names[curIdx], stopStatus: atStop?1:2,
      occupancy:b.occ, congestion: delay>300?3:(delay>120?2:1), delay, delaySrc:'demo', hasSchedule:true, demoSched:sched, demoPts:b.pts
    });
  }
  S.vehicles=next; S.feedTs=now;
  S.alerts=[{id:'d1', header:'Tryb demonstracyjny', desc:'Nie udało się połączyć z kanałem GTFS-Realtime, więc mapa pokazuje symulowane autobusy na uproszczonych trasach. Zmień źródła w Ustawieniach lub spróbuj później.', routes:[], stops:[]}];
}
function scheduleFor(v){
  if(v.demoSched){
    const cur=v.demoSched.findIndex(s=>s.seq===v.stopSeq);
    return v.demoSched.map((s,i)=>Object.assign({},s,{pred:s.arr+(i>=cur?v.delay:0), delay:i>=cur?v.delay:null, passed:i<cur, current:i===cur}));
  }
  return predictTimes(v, buildLiveSchedule(v));
}
function shapeFor(v){
  if(v.demoPts) return v.demoPts;
  const t = v.tripId && GT.trips.get(v.tripId);
  if(t && t.shape && GT.shapes.get(t.shape)) return GT.shapes.get(t.shape);
  const st = v.tripId && GT.stopTimes.get(v.tripId);
  if(st) return st.map(s=>GT.stops.get(s.stop)).filter(Boolean).map(s=>[s.lat,s.lon]);
  return null;
}

/* ============================================================
   Mapa
   ============================================================ */
const isDark = () => document.documentElement.getAttribute('data-theme')==='dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
const map = L.map('map', {zoomControl:true, preferCanvas:false}).setView(RZ_CENTER, 13);
let tiles=null;
/* Podkład mapy: najpierw zwykłe <img>, a gdy obrazki z zewnątrz są blokowane (np. podgląd w aplikacji),
   pobieramy kafelki przez fetch → blob:. Jeśli i to nie działa — rysujemy wektorowy podkład z tras GTFS. */
const TILE = {mode: store('rzbus.tileMode')==='blob' ? 'blob' : 'img', ok:0, err:0, bok:0, berr:0};
const SmartTiles = L.TileLayer.extend({
  createTile(coords, done){
    const img=document.createElement('img'); img.alt=''; img.setAttribute('role','presentation');
    const url=this.getTileUrl(coords);
    if(TILE.mode==='none'){ setTimeout(()=>done(null,img),0); return img; }
    if(TILE.mode==='blob'){
      withTimeout(fetch(url).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.blob(); }), 15000)
        .then(b=>{ TILE.bok++; img.onload=()=>done(null,img); img.onerror=e=>done(e,img); img.src=URL.createObjectURL(b); })
        .catch(e=>{ TILE.berr++; if(TILE.bok===0 && TILE.berr>=4) tilesUnavailable(); done(e,img); });
      return img;
    }
    img.onload=()=>{ TILE.ok++; done(null,img); };
    img.onerror=e=>{ TILE.err++; if(TILE.ok===0 && TILE.err>=4 && TILE.mode==='img'){ TILE.mode='blob'; setTimeout(()=>tileLayers.forEach(t=>t.redraw()),0); } done(e,img); };
    img.src=url; return img;
  }
});
const ESRI='https://server.arcgisonline.com/ArcGIS/rest/services/';
const TILE_PROVIDERS = {
  esri:  {name:'Esri — ulice (bez klucza)', light:[{url:ESRI+'World_Street_Map/MapServer/tile/{z}/{y}/{x}', maxNative:18}],
          dark:[{url:ESRI+'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxNative:16},{url:ESRI+'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', maxNative:16}],
          attr:'Podkład &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap'},
  osm:   {name:'OpenStreetMap', light:[{url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNative:19}], attr:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'},
  hot:   {name:'OpenStreetMap HOT', light:[{url:'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', maxNative:19, sub:'abc'}], attr:'&copy; OpenStreetMap, styl HOT, hosting OSM France'},
  sat:   {name:'Esri — satelita', light:[{url:ESRI+'World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNative:18},{url:ESRI+'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', maxNative:18}], attr:'Zdjęcia &copy; Esri, Maxar, Earthstar Geographics'},
  carto: {name:'CARTO Voyager (może wymagać klucza)', light:[{url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', maxNative:19, sub:'abcd'}],
          dark:[{url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', maxNative:19, sub:'abcd'}], attr:'&copy; OpenStreetMap &copy; CARTO'}
};
let tileLayers=[];
/* ---- Google Maps (własny klucz API) + warstwa natężenia ruchu ---- */
const GM_DARK=[{elementType:'geometry',stylers:[{color:'#1d1d1f'}]},{elementType:'labels.text.fill',stylers:[{color:'#9a9aa0'}]},{elementType:'labels.text.stroke',stylers:[{color:'#121212'}]},
  {featureType:'road',elementType:'geometry',stylers:[{color:'#2c2c30'}]},{featureType:'road.highway',elementType:'geometry',stylers:[{color:'#3d3d42'}]},
  {featureType:'water',elementType:'geometry',stylers:[{color:'#0e1626'}]},{featureType:'poi',stylers:[{visibility:'off'}]},{featureType:'transit',stylers:[{visibility:'off'}]}];
let gmPromise=null, tilesToken=0, gmLoadedKey=null;
function loadScript(src){ return new Promise((res,rej)=>{ const el=document.createElement('script'); el.src=src; el.async=true; el.onload=res; el.onerror=()=>rej(new Error('Nie wczytano '+src)); document.head.appendChild(el); }); }
function ensureGoogle(key){
  if(gmPromise) return gmPromise;
  gmLoadedKey=key;
  gmPromise = new Promise((res,rej)=>{
    window.__gmReady = ()=>res();
    loadScript('https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(key)+'&v=weekly&loading=async&callback=__gmReady').catch(rej);
    setTimeout(()=>rej(new Error('Google Maps nie odpowiada')), 20000);
  }).then(()=> (L.gridLayer && L.gridLayer.googleMutant) ? null : loadScript('https://unpkg.com/leaflet.gridlayer.googlemutant@0.16.0/dist/Leaflet.GoogleMutant.js'));
  gmPromise.catch(()=>{ gmPromise=null; });
  return gmPromise;
}
let gmFailed=false;
function googleFailed(msg){
  gmFailed=true;
  try{ if(PK.map && PK.base){ for(const l of PK.base) PK.map.removeLayer(l); PK.base=[]; PK.baseKey='failed'; const prov=TILE_PROVIDERS.esri; prov.light.forEach(d=>{ const layer=new SmartTiles(d.url,{maxZoom:19,maxNativeZoom:d.maxNative,attribution:prov.attr}); layer.addTo(PK.map); PK.base.push(layer); }); } }catch(e){}
  showTileNote(msg + ' Używam darmowego podkładu Esri.');
  CFG.tiles='esri'; setTiles(); CFG.tiles='google';   // ustawienie zostaje, by po poprawie klucza zadziałało
}
window.gm_authFailure = ()=>googleFailed('Google odrzucił klucz API (sprawdź klucz, ograniczenia domeny i włączone Maps JavaScript API).');
function showTileNote(t){ const n=document.getElementById('tileNote'); n.textContent=t; n.classList.remove('d-none'); clearTimeout(n._t); n._t=setTimeout(()=>{ if(TILE.mode!=='none') n.classList.add('d-none'); }, 9000); }
function setTiles(){
  const my=++tilesToken;
  for(const t of tileLayers) map.removeLayer(t); tileLayers=[];
  document.getElementById('trafficLegend').classList.toggle('d-none', !(CFG.tiles==='google' && CFG.gkey && CFG.traffic));
  if(CFG.tiles==='google'){
    if(!CFG.gkey){ showTileNote('Aby użyć Google Maps z natężeniem ruchu, wpisz klucz API Google w Ustawieniach.'); CFG.tiles='esri'; setTiles(); CFG.tiles='google'; return; }
    document.getElementById('map').classList.remove('dim-tiles');
    ensureGoogle(CFG.gkey).then(()=>{
      if(my!==tilesToken) return;
      const g = L.gridLayer.googleMutant({type:'roadmap', maxZoom:20, styles: isDark()?GM_DARK:[{featureType:'poi',stylers:[{visibility:'off'}]}]});
      g.addTo(map); tileLayers=[g]; tiles=g;
      if(CFG.traffic) g.addGoogleLayer('TrafficLayer');
    }).catch(e=>{ if(my===tilesToken) googleFailed('Nie udało się wczytać Google Maps.'); });
    return;
  }
  const prov = TILE_PROVIDERS[CFG.tiles] || TILE_PROVIDERS.esri;
  const defs = (isDark() && prov.dark) ? prov.dark : prov.light;
  TILE.ok=0; TILE.err=0; TILE.bok=0; TILE.berr=0;
  defs.forEach((d,i)=>{
    const layer = new SmartTiles(d.url, {maxZoom:19, maxNativeZoom:d.maxNative||19, subdomains:d.sub||'abc', attribution:i===0?prov.attr:'', zIndex:i+1});
    layer.on('tileunload', e=>{ if(e.tile && e.tile.src && e.tile.src.startsWith('blob:')) URL.revokeObjectURL(e.tile.src); });
    layer.on('tileload', ()=>{ if(TILE.mode==='blob' && TILE.bok===1) store('rzbus.tileMode','blob'); });
    layer.addTo(map); tileLayers.push(layer);
  });
  tiles = tileLayers[0];
  // ciemny motyw dla dostawców bez wersji ciemnej
  document.getElementById('map').classList.toggle('dim-tiles', isDark() && !prov.dark && CFG.tiles!=='sat');
}
let baseLayer=null;
function tilesUnavailable(){
  if(TILE.mode==='none') return;
  TILE.mode='none'; store('rzbus.tileMode', null);
  document.getElementById('map').classList.add('no-tiles');
  document.getElementById('tileNote').classList.remove('d-none');
  drawVectorBase();
}
function drawVectorBase(){
  if(TILE.mode!=='none') return;
  if(baseLayer) map.removeLayer(baseLayer);
  const layers=[];
  const lineStyle = c => ({color:c, weight:3, opacity:.35, interactive:false});
  if(S.mode==='demo'){
    for(const [,c,names] of DEMO_LINES) layers.push(L.polyline(names.map(n=>DEMO_STOPS[n]), lineStyle(c)));
    for(const [n,ll] of Object.entries(DEMO_STOPS)) layers.push(L.circleMarker(ll,{radius:3,color:'#7c3aed',weight:1,fillOpacity:.6}).bindTooltip(n,{className:'bus-tip'}));
  } else if(GT.loaded){
    const perRoute=new Map();
    for(const t of GT.trips.values()){ const k=t.route+'|'+t.dir; if(!perRoute.has(k)) perRoute.set(k,t); }
    for(const t of perRoute.values()){
      const r=GT.routes.get(t.route)||{}; let pts=t.shape&&GT.shapes.get(t.shape);
      if(!pts){ const st=GT.stopTimes.get(t.id); pts = st ? st.map(s=>GT.stops.get(s.stop)).filter(Boolean).map(s=>[s.lat,s.lon]) : null; }
      if(pts && pts.length>1) layers.push(L.polyline(pts, lineStyle(lineColor(r.short||t.route, r.color, r.agency))));
    }
    const shown=new Set();
    for(const s of GT.stops.values()){ const k=s.name; if(shown.has(k)) continue; shown.add(k);
      layers.push(L.circleMarker([s.lat,s.lon],{radius:2.5,color:'#7c3aed',weight:1,fillOpacity:.5}).bindTooltip(s.name,{className:'bus-tip'})); }
  }
  baseLayer=L.layerGroup(layers).addTo(map); baseLayer.eachLayer(l=>l.bringToBack && l.bringToBack());
}
setTiles();
{ const mEl=document.getElementById('map'); let sm; map.on('zoomstart movestart', ()=>{ clearTimeout(sm); mEl.classList.remove('smooth'); }); map.on('zoomend moveend', ()=>{ clearTimeout(sm); sm=setTimeout(()=>mEl.classList.add('smooth'), 80); }); setTimeout(()=>mEl.classList.add('smooth'), 500); }
const markers = new Map();
const BUS_ICON = '<i class="fa-solid fa-bus" aria-hidden="true"></i>';
function pinHtml(v, st, sel, fl){
  const lbl = String(v.short).length>4 ? String(v.short).slice(0,4) : v.short;
  const dir = v.bearing!=null ? `<span class="dir" style="transform:rotate(${Math.round(v.bearing)}deg)"></span>` : '';
  if(fl){ // widok trasy: kolor odcinka + plakietka punktualności
    const tag = v.delay==null ? '?' : (Math.abs(v.delay)<60 ? 'na czas' : fmtDelay(v.delay,true));
    return `<div class="bus-pin in-leg ${st==='late'?'late':''} ${sel?'sel':''} ${fl.mine?'mine':''}" style="--c:${fl.color};--t:#fff"><span class="bus-body">${BUS_ICON}${esc(lbl)}</span>${dir}<span class="st-tag ${st}">${fl.mine?'twój · ':''}${tag}</span></div>`;
  }
  return `<div class="bus-pin ${st==='late'?'late':''} ${sel?'sel':''} ${v.agency==='pks'?'is-pks':''}" style="--c:${STATUS_COLOR[st]}"><span class="bus-body">${v.agency==='pks'?'<i class="ag">PKS</i>':''}${BUS_ICON}${v.short==='—'?'':esc(lbl)}${isFavoriteLine(v)?'<i class="pin-star">★</i>':''}</span>${dir}</div>`;
}
function matchesFilter(v){
  if(S.focus) return !!focusLegOf(v);
  if(S.agency!=='all' && (v.agency||'ztm')!==S.agency) return false;
  const st=statusOf(v.delay);
  if(S.filter==='late' && st!=='late') return false;
  if(S.filter==='ontime' && !(st==='ok'||st==='minor'||st==='early')) return false;
  if(S.filter==='fav' && !isFavoriteLine(v)) return false;
  if(S.query){ const q=S.query.toLowerCase(); const hay=[v.short,v.headsign,v.label,v.id,v.plate,v.routeLong].join(' ').toLowerCase();
    if(/^\w{1,3}$/.test(q)){ // krótkie zapytanie to numer linii lub pojazdu — dokładne dopasowanie, inaczej „1” pasuje do prawie wszystkiego
      const exact=String(v.short).toLowerCase()===q || String(v.label).toLowerCase()===q;
      if(!exact && (/^\d+$/.test(q) || findRoutesByShort(q).length || !hay.includes(' '+q))) return false; }
    else if(!hay.includes(q)) return false; }
  return true;
}
function renderMarkers(){
  const live=new Set();
  for(const v of S.vehicles.values()){
    live.add(v.id);
    const st=statusOf(v.delay), show=matchesFilter(v), sel=S.selected===v.id;
    let m=markers.get(v.id);
    const fl = S.focus ? focusLegOf(v) : null;
    const key = [st, v.short, isFavoriteLine(v), v.bearing!=null?Math.round(v.bearing/10):'-', sel, show, fl?fl.color+fl.mine+Math.round((v.delay||0)/60):''].join('|');
    if(!m){
      m = L.marker([v.lat,v.lon], {icon:L.divIcon({className:'bus-pin-wrap', html:pinHtml(v,st,sel,fl), iconSize:[64,30], iconAnchor:[32,20]}), riseOnHover:true});
      m.on('click', ()=>openBus(v.id));
      m.bindTooltip('', {className:'bus-tip', direction:'top', offset:[0,-18]});
      markers.set(v.id, m); m._key=null;
    }
    m.setLatLng([v.lat,v.lon]);
    if(m._key!==key){ m.setIcon(L.divIcon({className:'bus-pin-wrap', html:pinHtml(v,st,sel,fl), iconSize:[64,30], iconAnchor:[32,20]})); m._key=key; }
    m.setZIndexOffset(st==='late'?1000:(sel?2000:0));
    m.setTooltipContent(`<b>${esc(v.short)}</b> → ${esc(v.headsign||'?')}<br>${STATUS_LABEL[st]}${v.delay!=null?' · '+fmtDelay(v.delay):''}`);
    if(show){ if(!map.hasLayer(m)) m.addTo(map); } else if(map.hasLayer(m)) map.removeLayer(m);
  }
  for(const [id,m] of markers) if(!live.has(id)){ map.removeLayer(m); markers.delete(id); }
}

/* ============================================================
   Panele: statystyki, lista spóźnionych
   ============================================================ */
function renderStats(){
  const delays = S.agency==='kolej'
    ? TR.trains.filter(t=>trainPosition(t)).map(t=>{ const d=trainDelayNow(t); return d==null?null:d*60; })
    : [...S.vehicles.values()].filter(v=>(v.agency||'ztm')===S.agency).map(v=>v.delay);
  let all=0, ok=0, late=0, max=null;
  for(const delay of delays){ all++; const st=statusOf(delay); if(st==='late') late++; if(st==='ok'||st==='minor'||st==='early') ok++; if(delay!=null && (max==null||delay>max)) max=delay; }
  document.getElementById('stAll').textContent=all;
  document.getElementById('stOk').textContent=ok;
  document.getElementById('stLate').textContent=late;
  document.getElementById('stMax').textContent= max!=null && max>=60 ? Math.round(max/60)+' min' : '0';
  document.getElementById('lateCountChip').textContent=late;
}
function renderLateTrains(){
  const list=TR.trains.filter(t=>trainPosition(t)&&trainMatches(t)).map(t=>({t,d:trainDelayNow(t)})).filter(x=>x.d!=null&&x.d>=1).sort((a,b)=>b.d-a.d).slice(0,12);
  const el=document.getElementById('lateList');
  if(!list.length){ el.innerHTML=`<div class="empty-note">${TR.trains.length? '🎉 Brak spóźnionych pociągów dla wybranego filtra.' : 'Czekam na dane…'}</div>`; return; }
  el.innerHTML = list.map(({t,d})=>`<button class="set-card" data-train="${esc(t.key)}">
      <span class="line-badge" style="--c1:#181818;--c2:#181818">${esc(t.cat||'POC')}</span>
      <span class="set-body"><strong>→ ${esc(t.to)}</strong><span class="meta">${esc(t.label)}${t.name?' „'+esc(t.name)+'”':''}</span></span>
      <span class="chip ${statusOf(d*60)}">+${d} min</span>${trainStar(t)}</button>`).join('');
}
function renderLateList(){
  if(S.agency==='kolej'){ renderLateTrains(); return; }
  const list=[...S.vehicles.values()].filter(v=>v.delay!=null && v.delay>=60 && matchesFilter(v)).sort((a,b)=>b.delay-a.delay).slice(0,12);
  const el=document.getElementById('lateList');
  if(!list.length){ const inView=[...S.vehicles.values()].some(v=>(v.agency||'ztm')===S.agency); el.innerHTML=`<div class="empty-note">${inView? '🎉 Brak spóźnionych autobusów dla wybranego filtra.' : S.vehicles.size? 'Brak pojazdów tej kategorii w danych na żywo.' : feedDown()? 'Brak danych na żywo od ZTM.' : 'Czekam na dane…'}</div>`; return; }
  el.innerHTML = list.map(v=>{ const st=statusOf(v.delay);
    return `<button class="set-card" data-id="${esc(v.id)}">
      <span class="line-badge" style="--c1:${v.color};--c2:${v.color}">${esc(v.short)}</span>
      <span class="set-body"><strong>${esc(v.headsign||(GT.loaded||GT.failed?'kierunek nieznany':'wczytywanie kierunku…'))}</strong>
      <span class="meta">Pojazd ${esc(v.label)}${v.stopName?` · ${STOP_STATUS[v.stopStatus]||''} ${esc(v.stopName)}`:''}</span></span>
      <span class="chip ${st}">${fmtDelay(v.delay,true)}</span>${lineStar(v.routeId)}</button>`; }).join('');
}
// Kanał potrafi odpowiadać poprawnie, ale pusto i ze starą datą — wtedy brak pojazdów nie znaczy, że linie nie kursują.
function feedDown(){ return S.mode==='live' && !S.vehicles.size && !!S.feedTs && nowSec()-S.feedTs>300; }
function renderFeedNotice(){
  const el=document.getElementById('feedNotice'), down=feedDown() && (S.agency==='ztm'||S.agency==='pks');
  el.classList.toggle('d-none', !down);
  if(down) el.innerHTML=`<div><span class="ln-badge off">!</span><b>ZTM nie przesyła teraz pozycji pojazdów</b> (ostatnie dane sprzed ${Math.round((nowSec()-S.feedTs)/60)} min). Mapa uzupełni się sama, gdy dane wrócą. Rozkład jazdy i planowanie podróży działają normalnie.</div>`;
}
function renderAlertsBtn(){
  const b=document.getElementById('alertsBtn');
  b.style.display = S.alerts.length ? '' : 'none';
  document.getElementById('alertsCount').textContent = S.alerts.length;
}
function renderAll(){
  S.byTrip=new Map(); for(const v of S.vehicles.values()) if(v.tripId) S.byTrip.set(v.tripId, v);
  const cf=document.getElementById('cdFoot'); if(cf && S.feedTs) cf.textContent=(S.mode==='demo'?'Symulacja · ':'Ostatni odczyt · ')+fmtClockS(S.feedTs);
  renderMarkers(); renderStats(); renderLateList(); renderAlertsBtn(); renderFeedNotice();
  if(S.focus) renderFocusBar();
  renderTrainsOnMap();
  if(GT.loaded){ renderLinesGrid(); renderLineNotice(); if(lineModalEl.classList.contains('show')) renderLine(true); if(S.plan) runPlan(false); }
  if(S.selected && bootstrap.Modal.getInstance(busModalEl) && busModalEl.classList.contains('show')) renderBus(S.selected, true);
  if(S.follow && S.selected && S.vehicles.get(S.selected)){ const v=S.vehicles.get(S.selected); map.panTo([v.lat,v.lon]); }
}

/* ============================================================
   Modal pojazdu
   ============================================================ */
const busModalEl=document.getElementById('busModal');
const busModal=new bootstrap.Modal(busModalEl);
function openBus(id){ S.selected=id; renderBus(id,false); busModal.show(); renderMarkers(); }
busModalEl.addEventListener('hidden.bs.modal', ()=>{ if(!S.follow && !S.routeLayer){ S.selected=null; renderMarkers(); } });
function renderBus(id, soft){
  const v=S.vehicles.get(id);
  const hero=document.getElementById('busHero'), body=document.getElementById('busBody');
  if(!v){ body.innerHTML='<div class="empty-note">Pojazd zniknął z kanału danych (zjazd do zajezdni lub utrata sygnału GPS).</div>'; return; }
  const st=statusOf(v.delay);
  hero.style.setProperty('--h1', v.color); hero.style.setProperty('--h2', STATUS_COLOR[st]);
  hero.innerHTML = `<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Zamknij"></button>
    <div class="d-flex align-items-center gap-3 pe-4">
      <div class="big-line">${esc(v.short)}</div>
      <div style="min-width:0"><span class="kicker mb-1">${S.mode==='demo'?'Symulacja · ':''}${v.agency==='pks'?'PKS Rzeszów · linia podmiejska':'ZTM Rzeszów · linia '+esc(v.short)}</span>
      <h4>→ ${esc(v.headsign||'kierunek nieznany')} ${lineStar(v.routeId)}</h4>
      <div class="sub">Pojazd nr ${esc(v.label)}${v.plate?` · ${esc(v.plate)}`:''}${v.routeLong?` · ${esc(v.routeLong)}`:''}</div></div>
    </div>`;
  const srcTxt = v.delaySrc==='rt' ? 'wg prognoz GTFS-RT (Trip Updates) ZTM' : v.delaySrc==='est' ? 'szacunek: pozycja GPS vs. rozkład jazdy' : v.delaySrc==='demo' ? 'dane symulowane' : (v.tripId ? 'brak kursu w rozkładzie (inna wersja GTFS?)' : 'pojazd poza kursem / zjazd');
  const icon = {late:'⏰', minor:'⏱', ok:'✅', early:'⚡', unknown:'❔'}[st];
  const sched = scheduleFor(v);
  const routeAlerts = S.alerts.filter(a=>a.routes.includes(v.routeId) || (sched && sched.some(s=>a.stops.includes(s.stopId))));
  const nextStop = sched ? sched.find(s=>!s.passed) : null;
  const tiles = [
    ['Następny przystanek', nextStop ? `${esc(nextStop.name)} · ${fmtClock(nextStop.pred)}` : (v.stopName?esc(v.stopName):'—')],
    ['Status', v.stopName ? `${STOP_STATUS[v.stopStatus]||''} ${esc(v.stopName)}` : '—'],
    ['Prędkość', v.speed!=null ? Math.round(v.speed)+' km/h' : '—'],
    ['Kierunek jazdy', compass(v.bearing)],
    ['Ostatni sygnał GPS', `${ago(v.ts)}${v.ts?` <span class="text-soft">(${fmtClockS(v.ts)})</span>`:''}`],
    ['Start kursu', v.startTime ? esc(String(v.startTime).slice(0,5)) : (sched?fmtClock(sched[0].dep):'—')],
    ['Brygada / blok', v.brigade ? esc(v.brigade) : '—'],
    ['Zapełnienie', v.occupancy!=null ? (OCCUPANCY[v.occupancy]||v.occupancy)+(v.occupancyPct!=null?` (${v.occupancyPct}%)`:'') : '—'],
    ['Ruch', v.congestion!=null ? (CONGESTION[v.congestion]||'—') : '—'],
    ['Pozycja', `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}`],
    ['ID kursu (trip_id)', `<span style="font-size:.78rem">${esc(v.tripId||'—')}</span>`],
    ['Przystanki', sched ? `${sched.filter(s=>s.passed).length} / ${sched.length} przejechane` : '—']
  ];
  let tl='';
  if(sched){
    tl = `<ul class="timeline" id="tl">` + sched.map(s=>{ const ps=statusOf(s.delay);
      return `<li class="${s.passed?'passed':''} ${s.current?'current':''}"><span class="node"></span>
        <span>${esc(s.name)}${s.current?` <span class="chip ${st} ms-1" style="padding:3px 8px;font-size:.66rem">${v.stopStatus===1?'tutaj':'następny'}</span>`:''}</span>
        <span class="times"><div class="plan">plan ${fmtClock(s.arr)}</div>${s.passed?'':`<div class="pred ${ps}">${fmtClock(s.pred)}${s.delay!=null&&Math.abs(s.delay)>=60?` <small>(${fmtDelay(s.delay,true)})</small>`:''}</div>`}</span></li>`; }).join('') + `</ul>`;
  } else tl = `<div class="empty-note">Brak rozkładu dla tego kursu${GT.loaded?'':' — rozkład GTFS nie został wczytany'}.</div>`;
  const scrollTop = soft && document.getElementById('tl') ? document.getElementById('tl').scrollTop : null;
  body.innerHTML = `
    <div class="delay-banner ${st}">
      <div><div class="big">${STATUS_LABEL[st]}${v.delay!=null && Math.abs(v.delay)>=60 ? ' · '+fmtDelay(v.delay) : ''}</div>
      <div class="src">${srcTxt}${v.delay!=null && Math.abs(v.delay)<60 && v.delay!==0 ? ` · odchyłka ${v.delay>0?'+':''}${v.delay} s`:''}</div></div></div>
    ${routeAlerts.map(a=>`<div class="alert-card"><b>⚠︎ ${esc(a.header||'Komunikat')}</b>${a.desc?`<div class="mt-1">${esc(a.desc)}</div>`:''}</div>`).join('')}
    <div class="info-grid">${tiles.map(([k,val])=>`<div class="info-tile"><div class="k">${k}</div><div class="v">${val}</div></div>`).join('')}</div>
    <div class="d-flex justify-content-between align-items-center mb-2"><h5 class="section-title">Przebieg kursu</h5><span class="small text-soft">plan → prognoza</span></div>
    ${tl}`;
  const tlEl=document.getElementById('tl');
  if(tlEl){ if(scrollTop!=null) tlEl.scrollTop=scrollTop; else { const cur=tlEl.querySelector('li.current'); if(cur) setTimeout(()=>{ tlEl.scrollTop = Math.max(0, cur.offsetTop - tlEl.offsetTop - 60); }, soft?0:250); } }
  document.getElementById('routeBtn').classList.toggle('on', !!S.routeLayer);
  document.getElementById('followBtn').classList.toggle('on', S.follow);
}
document.getElementById('routeBtn').addEventListener('click', ()=>{
  if(S.routeLayer){ map.removeLayer(S.routeLayer); S.routeLayer=null; renderBus(S.selected,true); return; }
  const v=S.vehicles.get(S.selected); if(!v) return;
  const pts=shapeFor(v); if(!pts||pts.length<2) return;
  S.routeLayer = L.layerGroup([
    L.polyline(pts,{color:'#fff',weight:9,opacity:.85}),
    L.polyline(pts,{color:v.color,weight:5,opacity:.95})
  ]).addTo(map);
  busModal.hide(); map.fitBounds(L.latLngBounds(pts), {padding:[30,30]});
});
document.getElementById('busLineBtn').addEventListener('click', ()=>{ const v=S.vehicles.get(S.selected); if(!v) return; const rid=GT.routes.has(v.routeId)?v.routeId:(findRoutesByShort(v.short)[0]||{}).id; if(rid) openLine(rid); });
document.getElementById('followBtn').addEventListener('click', ()=>{
  S.follow=!S.follow; const v=S.vehicles.get(S.selected);
  if(S.follow && v){ busModal.hide(); map.setView([v.lat,v.lon], 16); }
  renderBus(S.selected,true);
});
map.on('dragstart', ()=>{ if(S.follow){ S.follow=false; } });
map.on('click', ()=>{ if(S.focus){ S.selected=null; renderMarkers(); return; } if(S.routeLayer){ map.removeLayer(S.routeLayer); S.routeLayer=null; } S.follow=false; S.selected=null; renderMarkers(); });

/* ============================================================
   Modale: komunikaty, ustawienia
   ============================================================ */
const alertsModal=new bootstrap.Modal(document.getElementById('alertsModal'));
document.getElementById('alertsBtn').addEventListener('click', ()=>{
  document.getElementById('alertsBody').innerHTML = S.alerts.length ? S.alerts.map(a=>`<div class="alert-card"><b>${esc(a.header||'Komunikat')}</b>
    ${a.routes.length?`<div class="small mt-1">Linie: ${a.routes.map(r=>`<span class="chip unknown me-1" style="padding:3px 8px">${esc((GT.routes.get(r)||{}).short||r)}</span>`).join('')}</div>`:''}
    ${a.desc?`<div class="mt-1" style="white-space:pre-line">${esc(a.desc)}</div>`:''}${a.url?`<div class="mt-1"><a href="${esc(a.url)}" target="_blank" rel="noopener">Więcej</a></div>`:''}</div>`).join('') : '<div class="empty-note">Brak aktywnych komunikatów.</div>';
  alertsModal.show();
});
const settingsModal=new bootstrap.Modal(document.getElementById('settingsModal'));
function fillSettings(){
  sThr.value=CFG.threshold; sThrLbl.textContent=CFG.threshold; sRefresh.value=CFG.refresh; sRefreshLbl.textContent=CFG.refresh;
  sRt.value=CFG.rtUrls.join('\n'); sStatic.value=CFG.staticUrls.join('\n'); sProxy.value=CFG.proxy; sProxyCustom.value=CFG.proxyCustom; sDemo.checked=CFG.demo; sTiles.value=CFG.tiles; sGkey.value=CFG.gkey||''; sTraffic.checked=CFG.traffic!==false; gBox.style.display = CFG.tiles==='google'?'':'none';
  sPks.checked=CFG.pks!==false; sPksRt.value=(CFG.pksRtUrls||[]).join('\n'); sPksStatic.value=(CFG.pksStaticUrls||[]).join('\n'); sTrains.checked=CFG.trains!==false; sPlk.value=CFG.plkKey||''; sWeather.checked=CFG.weather!==false;
  sProxyCustom.style.display = CFG.proxy==='custom'?'':'none';
}
const [sThr,sThrLbl,sRefresh,sRefreshLbl,sRt,sStatic,sProxy,sProxyCustom,sDemo,sTiles,sGkey,sTraffic,gBox] = ['sThr','sThrLbl','sRefresh','sRefreshLbl','sRt','sStatic','sProxy','sProxyCustom','sDemo','sTiles','sGkey','sTraffic','gBox'].map(id=>document.getElementById(id));
const [sPks,sPksRt,sPksStatic,sTrains,sPlk,sWeather]=['sPks','sPksRt','sPksStatic','sTrains','sPlk','sWeather'].map(id=>document.getElementById(id));
sThr.addEventListener('input',()=>sThrLbl.textContent=sThr.value);
sRefresh.addEventListener('input',()=>sRefreshLbl.textContent=sRefresh.value);
sTiles.addEventListener('change',()=>gBox.style.display = sTiles.value==='google'?'':'none');
sProxy.addEventListener('change',()=>sProxyCustom.style.display = sProxy.value==='custom'?'':'none');
document.getElementById('settingsBtn').addEventListener('click', ()=>{ fillSettings(); settingsModal.show(); });
document.getElementById('resetSettings').addEventListener('click', ()=>{ CFG=Object.assign({},DEFAULTS); fillSettings(); });
document.getElementById('settingsForm').addEventListener('submit', e=>{
  e.preventDefault();
  const lines = t => t.split(/\s*\n\s*/).map(s=>s.trim()).filter(Boolean);
  const reloadData = lines(sRt.value).join()!==CFG.rtUrls.join() || lines(sStatic.value).join()!==CFG.staticUrls.join() || sProxy.value!==CFG.proxy || sProxyCustom.value!==CFG.proxyCustom || sDemo.checked!==CFG.demo || sPks.checked!==(CFG.pks!==false) || lines(sPksRt.value).join()!==(CFG.pksRtUrls||[]).join() || lines(sPksStatic.value).join()!==(CFG.pksStaticUrls||[]).join();
  const trainsChanged = sTrains.checked!==(CFG.trains!==false) || sPlk.value.trim()!==(CFG.plkKey||'');
  const weatherChanged = sWeather.checked!==(CFG.weather!==false);
  CFG = {threshold:+sThr.value, refresh:+sRefresh.value, rtUrls:lines(sRt.value), staticUrls:lines(sStatic.value), proxy:sProxy.value, proxyCustom:sProxyCustom.value.trim(), demo:sDemo.checked, tiles:sTiles.value, gkey:sGkey.value.trim(), traffic:sTraffic.checked, pks:sPks.checked, pksRtUrls:lines(sPksRt.value), pksStaticUrls:lines(sPksStatic.value), trains:sTrains.checked, plkKey:sPlk.value.trim(), weather:sWeather.checked};
  if(gmLoadedKey && CFG.gkey!==gmLoadedKey){ store('rzbus.cfg', CFG); location.reload(); return; }
  store('rzbus.cfg', CFG); settingsModal.hide(); setTiles();
  document.querySelectorAll('.thrLbl').forEach(x=>x.textContent=CFG.threshold);
  if(reloadData) boot(); else { restartTimer(); renderAll(); }
  if(trainsChanged && typeof trainsBoot==='function') trainsBoot();
  if(weatherChanged && typeof weatherBoot==='function') weatherBoot();
});

/* ============================================================
   Filtry, motyw, przyciski mapy
   ============================================================ */
/* ---------- Podstrony: autobusy, PKS, pociągi ---------- */
const VIEWS={
  ztm:{path:'/autobusy', tab:'Autobusy', title:'Autobusy w Rzeszowie', search:'Szukaj linii, kierunku lub nr pojazdu…'},
  pks:{path:'/pks', tab:'PKS', title:'PKS — linie podmiejskie', search:'Szukaj linii, kierunku lub nr pojazdu…'},
  kolej:{path:'/pociagi', tab:'Pociągi', title:'Pociągi w okolicy Rzeszowa', search:'Szukaj pociągu lub kierunku…'},
  podroz:{path:'/podroz', tab:'Zaplanuj podróż', title:'Zaplanuj podróż', map:'Trasa na mapie', search:''}
};
function viewFromPath(){ return Object.keys(VIEWS).find(k=>VIEWS[k].path===location.pathname)||'ztm'; }
function fitView(){
  if(S.agency==='podroz'){ const t=S.plan?[...S.plan.origin.points.slice(0,1), ...S.plan.dest.points.slice(0,1)]:[]; if(t.length) map.fitBounds(L.latLngBounds(t),{padding:[60,60],maxZoom:14}); else map.setView(RZ_CENTER,12); return; }
  const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]);
  if(pts.length) map.fitBounds(L.latLngBounds(pts),{padding:[30,30],maxZoom:14}); else map.setView(RZ_CENTER, S.agency==='kolej'?12:13);
}
function setView(view, push){
  const V=VIEWS[view];
  if(push) history.pushState(null,'',V.path);
  if(S.focus) resetFocus();
  clearRouteLayer(); S.selected=null; S.follow=false;
  S.agency=view; S.query=''; S.plan=null; S.placeChoice={}; planReq++;
  document.body.dataset.view=view; map.invalidateSize(); // strona podróży ma mapę na całą szerokość
  document.title=`${V.tab} · Rzeszów Live`;
  document.getElementById('heroTitle').textContent=V.title;
  document.getElementById('mapTitle').textContent=V.map||'Mapa na żywo';
  const search=document.getElementById('lineSearch'); search.value=''; search.placeholder=V.search;
  document.querySelectorAll('.view-tab').forEach(a=>{ const on=a.dataset.view===view; a.classList.toggle('active',on); if(on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  let n=0; document.querySelectorAll('.sec-num').forEach(e=>{ if(e.offsetParent) e.textContent=String(++n).padStart(2,'0'); });
  document.getElementById('planResults').innerHTML=''; document.getElementById('planErr').textContent='';
  const saved=store('rzbus.plan.podroz'); plFrom.value=saved?.from||''; plTo.value=saved?.to||'';
  refreshStopList();
  TT.stop=store('rzbus.tt.'+view)||''; TT.line=''; TT.page=null; TR.page=null;
  document.getElementById('ttStop').value=TT.stop; document.getElementById('ttErr').textContent='';
  renderTimetable(); renderFeedNotice(); renderFavorites();
  if(view==='podroz'){ syncReturn(); loadFlights().then(watchFlightRefresh); }
  renderMarkers(); renderStats(); renderLateList(); renderLineNotice(); renderLinesGrid(); renderTrainsOnMap(); renderBoard();
  fitView();
}
document.querySelectorAll('.view-tab').forEach(a=>a.addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault();
  if(a.dataset.view!==S.agency) setView(a.dataset.view, true);
  window.scrollTo({top:0, behavior:'instant'});
}));
window.addEventListener('popstate', ()=>setView(viewFromPath(), false));
function setFilter(f){ S.filter=f; document.querySelectorAll('.pill-btn[data-filter]').forEach(b=>{ b.classList.toggle('active', b.dataset.filter===f); b.classList.toggle('late', b.dataset.filter==='late'); }); renderMarkers(); renderLateList(); renderTrainsOnMap(); }
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click', ()=>setFilter(b.dataset.filter)));
let qTimer; document.getElementById('lineSearch').addEventListener('input', e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ S.query=e.target.value.trim(); renderMarkers(); renderLateList(); renderLineNotice(); renderTrainsOnMap(); fitQuery(); }, 250); });
function fitQuery(){ if(!S.query) return; const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]); if(pts.length===1) map.setView(pts[0],15); else if(pts.length>1 && pts.length<40) map.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:15}); }
document.getElementById('lateList').addEventListener('click', e=>{ const tr=e.target.closest('[data-train]'); if(tr){ openTrain(tr.dataset.train); return; } const b=e.target.closest('[data-id]'); if(!b) return; const v=S.vehicles.get(b.dataset.id); if(v){ map.setView([v.lat,v.lon], Math.max(map.getZoom(),15)); openBus(v.id); } });
document.getElementById('fitBtn').addEventListener('click', ()=>{ if(S.agency==='podroz'){ fitView(); return; } const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]); if(pts.length) map.fitBounds(L.latLngBounds(pts),{padding:[30,30]}); });
document.getElementById('centerBtn').addEventListener('click', ()=>map.setView(RZ_CENTER,13));
document.getElementById('resetViewBtn').addEventListener('click', ()=>resetFocus());
const savedTheme = store('rzbus.theme'); if(savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeBtn').addEventListener('click', ()=>{ const t=isDark()?'light':'dark'; document.documentElement.setAttribute('data-theme',t); store('rzbus.theme',t); setTiles(); });
document.getElementById('refreshBtn').addEventListener('click', ()=>tick(true));

/* ============================================================
   ROZKŁAD: kalendarz, indeksy, odjazdy
   ============================================================ */
GT.cal = new Map(); GT.calDates = new Map(); GT.byStop = new Map(); GT.groups = new Map(); GT.stopGroupOf = new Map(); GT.tripsByRoute = new Map();
const natSort = (a,b)=>String(a).localeCompare(String(b),'pl',{numeric:true, sensitivity:'base'});
function dayInfo(offset){ // offset dni względem dziś (Warszawa)
  const p=zparts(nowSec()); const base0=midnightEpoch(p.year,p.month,p.day);
  const q=zparts(base0 + 12*3600 + offset*86400);
  const base=midnightEpoch(q.year,q.month,q.day);
  const ymd=`${q.year}${String(q.month).padStart(2,'0')}${String(q.day).padStart(2,'0')}`;
  const wd=(new Date(Date.UTC(q.year,q.month-1,q.day)).getUTCDay()+6)%7;
  return {base, ymd, wd, offset};
}
const svcCache=new Map();
function serviceOn(sid, day){
  if(!GT.cal.size && !GT.calDates.size) return true;
  const k=sid+'|'+day.ymd; if(svcCache.has(k)) return svcCache.get(k);
  let r=false; const ex=GT.calDates.get(sid); const e=ex && ex.get(day.ymd);
  if(e===1) r=true; else if(e===2) r=false; else { const c=GT.cal.get(sid); r=!!(c && c.days[day.wd] && day.ymd>=c.start && day.ymd<=c.end); }
  svcCache.set(k,r); return r;
}
// Rozkład scala kilka wersji i poprzedza ID kursu datą („2026-10-01_223532”), a kanał na żywo podaje samo „223532”.
function rawTripId(id){ return String(id).replace(/^(pks:)?\d{4}-\d{2}-\d{2}_/,'$1'); }
function resolveTripId(id){
  if(!id || !GT.tripAlias || GT.trips.has(id)) return id;
  const ids=GT.tripAlias.get(id); if(!ids) return id;
  for(const off of [0,-1]){ const day=dayInfo(off); const hit=ids.findLast(t=>serviceOn(GT.trips.get(t).service,day)); if(hit) return hit; } // -1: kursy po północy
  return ids[ids.length-1];
}
function tripInView(t){ return S.agency==='podroz' || (routeById(t.route).agency||'ztm')===S.agency; }
function groupInView(name){ const a=GT.groupAgency?.get(name); return !!a && (S.agency==='podroz' || a.has(S.agency)); }
function refreshStopList(){
  const list=document.getElementById('stopNames'), hint=document.getElementById('planHint');
  const names=GT.groupAgency ? allStopNames().sort(natSort) : [];
  list.innerHTML=names.map(n=>`<option value="${esc(n)}">`).join('');
  hint.textContent=names.length ? `${names.length} przystanków i stacji w regionie · dalej wpisz miasto` : '';
}
function dirKey(t){ return (t.dir!=null && t.dir!=='') ? 'd'+t.dir : 'h'+(t.headsign||''); }
function onStaticReady(){
  GT.byStop=new Map(); GT.groups=new Map(); GT.stopGroupOf=new Map(); GT.tripsByRoute=new Map(); svcCache.clear();
  GT.tripAlias=new Map();
  for(const id of GT.trips.keys()){ const raw=rawTripId(id); if(raw===id) continue; let a=GT.tripAlias.get(raw); if(!a){a=[];GT.tripAlias.set(raw,a);} a.push(id); }
  for(const s of GT.stops.values()){
    const nm=(s.name||s.id).trim(); GT.stopGroupOf.set(s.id,nm);
    let g=GT.groups.get(nm); if(!g){ g={name:nm, ids:[], lat:0, lon:0}; GT.groups.set(nm,g); }
    g.ids.push(s.id); g.lat+=(s.lat-g.lat)/g.ids.length; g.lon+=(s.lon-g.lon)/g.ids.length;
  }
  for(const [tid,st] of GT.stopTimes){ st.forEach((x,i)=>{ let a=GT.byStop.get(x.stop); if(!a){a=[];GT.byStop.set(x.stop,a);} a.push([tid,i]); }); }
  for(const t of GT.trips.values()){ let a=GT.tripsByRoute.get(t.route); if(!a){a=[];GT.tripsByRoute.set(t.route,a);} a.push(t); }
  // przystanki bez kursów nie trafiają do podpowiedzi
  GT.groupAgency=new Map();
  for(const [tid,st] of GT.stopTimes){ const t=GT.trips.get(tid); if(!t) continue; const ag=routeById(t.route).agency||'ztm';
    for(const x of st){ const g=GT.stopGroupOf.get(x.stop); let a=GT.groupAgency.get(g); if(!a){a=new Set();GT.groupAgency.set(g,a);} a.add(ag); } }
  refreshStopList();
  renderLinesGrid(); renderLineNotice(); if(S.plan) runPlan(false); renderTimetable();
}
function departuresFrom(groupName, fromTs, toTs, filterFn, offsets=[-1,0,1]){
  const out=[]; const g=GT.groups.get(groupName); if(!g) return out;
  for(const off of offsets){ const day=dayInfo(off);
    if(day.base + 30*3600 < fromTs || day.base > toTs) continue;
    for(const sid of g.ids){ const list=GT.byStop.get(sid); if(!list) continue;
      for(const [tid,idx] of list){
        const st=GT.stopTimes.get(tid); if(idx>=st.length-1) continue;          // przyjazd na pętlę — to nie odjazd
        const dep=day.base+st[idx].dep; if(dep<fromTs||dep>toTs) continue;
        const t=GT.trips.get(tid); if(!t || !serviceOn(t.service, day)) continue;
        if(filterFn && !filterFn(t,st,idx)) continue;
        out.push({tid, t, st, idx, dep, base:day.base});
      } } }
  return out.sort((a,b)=>a.dep-b.dep);
}
/* Stan „na żywo” konkretnego kursu na danym przystanku */
function liveFor(tid, st, idx, base){
  const sched = base + st[idx].dep, seq = st[idx].seq;
  const v = S.byTrip && S.byTrip.get(tid);
  if(v){
    const passed = v.stopSeq!=null && v.stopSeq > seq;
    const here = v.stopSeq===seq && v.stopStatus===1;
    return {state: passed?'passed':(here?'here':'enroute'), delay:v.delay, pred: sched + (v.delay||0), v};
  }
  const tu = S.tripUpdates.get(tid);
  if(tu){
    let d=null, best=null;
    for(const u of tu.stu){ if(u.seq!=null && u.seq<=seq) best=u; }
    if(!best) best = tu.stu.find(u=>u.seq!=null && u.seq>=seq) || tu.stu.find(u=>u.stopId===st[idx].stop) || null;
    if(best){ const ev=best.dep||best.arr; if(ev){ if(ev.delay!=null) d=ev.delay; else if(ev.time!=null){ const s2=st.find(x=>x.seq===best.seq || x.stop===best.stopId); if(s2) d=ev.time-(base+(best.dep?s2.dep:s2.arr)); } } }
    if(d==null) d=tu.delay;
    if(d!=null) return {state:'forecast', delay:d, pred:sched+d};
  }
  return {state:'sched', delay:null, pred:sched};
}
function liveChip(L){
  const st = statusOf(L.delay);
  if(L.state==='enroute'||L.state==='here'){
    const what = L.delay==null ? 'w trasie' : (st==='late'?`w trasie · spóźniony ${fmtDelay(L.delay,true)}`:st==='minor'?`w trasie · ${fmtDelay(L.delay,true)}`:st==='early'?`w trasie · przed czasem ${fmtDelay(L.delay,true)}`:'w trasie · na czas');
    return `<span class="chip ${L.delay==null?'unknown':st}">${L.state==='here'?'na przystanku':what}</span>`;
  }
  if(L.state==='forecast') return `<span class="chip ${st}">prognoza ${Math.abs(L.delay)<60?'· na czas':fmtDelay(L.delay,true)}</span>`;
  if(L.state==='passed') return `<span class="chip unknown">odjechał</span>`;
  return `<span class="chip unknown">wg rozkładu</span>`;
}
function inMin(ts){ const m=Math.round((ts-nowSec())/60); if(m<=0) return 'teraz'; if(m<60) return `za ${m} min`; return `za ${Math.floor(m/60)} h ${m%60} min`; }
function routeById(id){ return GT.routes.get(id) || {id, short:String(id).replace(/^pks:/,''), long:'', color:null, agency:String(id).startsWith('pks:')?'pks':'ztm'}; }
function findRoutesByShort(q){ q=String(q).trim().toLowerCase(); return [...GT.routes.values()].filter(r=>String(r.short).toLowerCase()===q && (S.agency==='all'||S.agency==='kolej'||r.agency===S.agency)).sort((a,b)=>(a.agency==='pks')-(b.agency==='pks')); }

/* ---------- Pierwszy / najbliższy kurs linii ---------- */
function nextRouteStart(routeId){
  const trips=GT.tripsByRoute.get(routeId)||[]; const now=nowSec();
  for(const off of [0,1,2]){ const day=dayInfo(off); let best=null;
    for(const t of trips){ if(!serviceOn(t.service,day)) continue; const st=GT.stopTimes.get(t.id); if(!st||!st.length) continue;
      const dep=day.base+st[0].dep; if(dep>=now && (!best||dep<best.dep)) best={dep, t, st, off}; }
    if(best) return best; }
  return null;
}
function runsTodayAtAll(routeId){ const day=dayInfo(0); return (GT.tripsByRoute.get(routeId)||[]).some(t=>serviceOn(t.service,day)); }
function activeOfRoute(routeId, short){ return [...S.vehicles.values()].filter(v=>v.routeId===routeId || (!GT.routes.has(v.routeId) && String(v.short)===String(short))); }

/* ---------- Komunikat przy filtrowaniu linii ---------- */
function renderLineNotice(){
  const el=document.getElementById('lineNotice'); const q=(S.query||'').trim();
  if(!q || S.focus || S.agency==='kolej'){ el.classList.add('d-none'); return; }
  const routes = GT.loaded ? findRoutesByShort(q) : [];
  const matchingVeh=[...S.vehicles.values()].filter(matchesFilter);
  let html='';
  if(routes.length){
    const r=routes[0]; const act=activeOfRoute(r.id, r.short); const late=act.filter(v=>statusOf(v.delay)==='late').length;
    if(act.length){
      html=`<div><span class="ln-badge" style="background:${lineColor(r.short,r.color,r.agency)}">${esc(r.short)}</span><b>Linia ${esc(r.short)}</b> · ${act.length} ${act.length===1?'pojazd':'pojazdy'} na trasie${late?` · <span class="txt-red">${late} spóźnion${late===1?'y':'e'}</span>`:''}</div>`;
    } else {
      const nx=nextRouteStart(r.id);
      const when = nx ? (nx.off===0 ? `Najbliższy kurs o <b>${fmtClock(nx.dep)}</b> (${inMin(nx.dep)}) z przystanku ${esc(GT.stopGroupOf.get(nx.st[0].stop)||'')} → ${esc(nx.t.headsign||'')}.` : `Dziś nie ma już kursów. Pierwszy kurs ${nx.off===1?'jutro':'pojutrze'} o <b>${fmtClock(nx.dep)}</b>.`) : 'Brak kursów w obowiązującym rozkładzie.';
      html=`<div><span class="ln-badge off">${esc(r.short)}</span><b>Linia ${esc(r.short)} obecnie nie kursuje</b> — żaden pojazd tej linii nie jest teraz na trasie. ${when}</div>`;
    }
    html+=`<span>${lineStar(r.id)} <button class="ln-link" data-route="${esc(r.id)}">Rozkład i przystanki →</button></span>`;
  } else if(!matchingVeh.length){
    html = GT.loaded && /^[0-9a-zA-Z]{1,4}$/.test(q)
      ? `<div><span class="ln-badge off">?</span><b>Nie ma linii „${esc(q)}”</b> w rozkładzie ZTM Rzeszów.</div>`
      : `<div><span class="ln-badge off">?</span>Brak pojazdów pasujących do „${esc(q)}”${GT.loaded?'':' (rozkład jeszcze się wczytuje)'}.</div>`;
  } else { el.classList.add('d-none'); return; }
  el.innerHTML=html; el.classList.remove('d-none');
}
document.getElementById('lineNotice').addEventListener('click', e=>{ const b=e.target.closest('[data-route]'); if(b) openLine(b.dataset.route); });

/* ---------- Siatka linii ---------- */
function renderLinesGrid(){
  const el=document.getElementById('linesGrid');
  if(!GT.loaded){ el.innerHTML='<div class="empty-note" style="grid-column:1/-1">Rozkład jazdy wczytuje się w tle…</div>'; return; }
  const counts=new Map(); for(const v of S.vehicles.values()){ const k=GT.routes.has(v.routeId)?v.routeId:v.short; counts.set(k,(counts.get(k)||0)+1); }
  const lateC=new Map(); for(const v of S.vehicles.values()) if(statusOf(v.delay)==='late'){ const k=GT.routes.has(v.routeId)?v.routeId:v.short; lateC.set(k,(lateC.get(k)||0)+1); }
  const tile = r=>{ const n=counts.get(r.id)||0, l=lateC.get(r.id)||0;
    return `<button class="line-tile ${n?'':'off'} ${r.agency==='pks'?'is-pks':''}" data-route="${esc(r.id)}"><span class="lt-num" style="${n?`background:${lineColor(r.short,r.color,r.agency)}`:''}">${esc(r.short)}</span>
      <span class="lt-meta">${n?`${n} w trasie`:(feedDown()?'brak danych':'nie kursuje')}${l?` · <span class="txt-red">${l} spóźn.</span>`:''}</span>${lineStar(r.id)}</button>`; };
  const groups=[['ztm','ZTM Rzeszów — komunikacja miejska'],['pks','PKS Rzeszów — linie podmiejskie']].filter(([ag])=>S.agency==='all'||S.agency==='kolej'||S.agency===ag);
  el.innerHTML = groups.map(([ag,title])=>{ const rs=[...GT.routes.values()].filter(r=>(r.agency||'ztm')===ag).sort((a,b)=>natSort(a.short,b.short)); if(!rs.length) return ag==='pks'?`<div class="lg-head">${title}</div><div class="empty-note" style="grid-column:1/-1">Rozkład PKS nie jest wczytany — sprawdź adres w Ustawieniach.</div>`:''; return `<div class="lg-head">${title} <span>${rs.length} linii</span></div>`+rs.map(tile).join(''); }).join('');
}
document.getElementById('linesGrid').addEventListener('click', e=>{ const b=e.target.closest('[data-route]'); if(b) openLine(b.dataset.route); });

/* ============================================================
   OKIENKO LINII — wszystkie przystanki, odjazdy, pojazdy
   ============================================================ */
const lineModalEl=document.getElementById('lineModal'); const lineModal=new bootstrap.Modal(lineModalEl);
const LS={route:null, dir:null};
function lineDirections(routeId){
  const trips=GT.tripsByRoute.get(routeId)||[]; const day=dayInfo(0);
  const groups=new Map();
  for(const t of trips){ const k=dirKey(t); let g=groups.get(k); if(!g){ g={key:k, trips:[], heads:new Map()}; groups.set(k,g);} g.trips.push(t); g.heads.set(t.headsign,(g.heads.get(t.headsign)||0)+1); }
  const res=[...groups.values()].map(g=>{
    let rep=null, repLen=-1, repToday=false;
    for(const t of g.trips){ const st=GT.stopTimes.get(t.id)||[]; const today=serviceOn(t.service,day);
      if((today && !repToday) || (today===repToday && st.length>repLen)){ rep=t; repLen=st.length; repToday=today; } }
    const head=[...g.heads.entries()].sort((a,b)=>b[1]-a[1])[0][0];
    return {key:g.key, rep, head, n:g.trips.length};
  }).filter(d=>d.rep).sort((a,b)=>b.n-a.n).slice(0,4);
  return res.sort((a,b)=>a.key.localeCompare(b.key));
}
function openLine(routeId){ LS.route=routeId; LS.dir=null; renderLine(false); bootstrap.Modal.getInstance(busModalEl)?.hide(); lineModal.show(); }
function renderLine(soft){
  const r=routeById(LS.route); const color=lineColor(r.short,r.color,r.agency);
  const dirs=lineDirections(r.id); if(!LS.dir && dirs.length) LS.dir=dirs[0].key;
  const d=dirs.find(x=>x.key===LS.dir) || dirs[0];
  const act=activeOfRoute(r.id, r.short); const late=act.filter(v=>statusOf(v.delay)==='late').length;
  const hero=document.getElementById('lineHero');
  hero.style.setProperty('--h1', color); hero.style.setProperty('--h2', late?STATUS_COLOR.late:color);
  let status;
  if(act.length) status=`${act.length} ${act.length===1?'pojazd':'pojazdy'} na trasie${late?` · ${late} spóźnion${late===1?'y':'e'}`:' · wszystkie punktualnie'}`;
  else { const nx=nextRouteStart(r.id); status = 'Obecnie nie kursuje' + (nx ? (nx.off===0?` · najbliższy kurs ${fmtClock(nx.dep)}`:` · kolejny kurs ${nx.off===1?'jutro':'pojutrze'} ${fmtClock(nx.dep)}`) : ''); }
  hero.innerHTML=`<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Zamknij"></button>
    <div class="d-flex align-items-center gap-3 pe-4"><div class="big-line">${esc(r.short)}</div>
    <div style="min-width:0"><span class="kicker mb-1"><span class="dot" style="${act.length?'':'background:#8F8F8F;animation:none'}"></span><span>${esc(status)}</span></span>
    <h4>${r.agency==='pks'?'PKS · ':''}Linia ${esc(r.short)} ${lineStar(r.id)}</h4><div class="sub">${esc(r.long||'')}</div></div></div>`;
  const body=document.getElementById('lineBody');
  if(!d){ body.innerHTML='<div class="empty-note">Brak kursów tej linii w rozkładzie.</div>'; return; }
  const st=GT.stopTimes.get(d.rep.id)||[]; const now=nowSec();
  // pojazdy tego kierunku przypisane do przystanków
  const vehAt=new Map();
  for(const v of act){ const t=GT.trips.get(v.tripId); if(t && dirKey(t)!==d.key) continue; const g=v.stopId?GT.stopGroupOf.get(v.stopId):null; if(!g) continue; let a=vehAt.get(g); if(!a){a=[];vehAt.set(g,a);} a.push(v); }
  const rows = st.map((s,i)=>{
    const g=GT.stopGroupOf.get(s.stop)||s.stop; const last=i===st.length-1;
    const deps = last ? [] : departuresFrom(g, now-45*60, now+4*3600, (t)=>t.route===r.id && dirKey(t)===d.key, [-1,0]).map(x=>Object.assign(x,{L:liveFor(x.tid,x.st,x.idx,x.base)})).filter(x=>x.L.state!=='passed' && x.L.pred>=now-30 && (x.L.state!=='sched' || x.dep>=now-60)).sort((a,b)=>a.L.pred-b.L.pred).slice(0,3);
    const vs=vehAt.get(g)||[];
    return `<li class="${vs.length?'current':''}"><span class="node"></span>
      <span><button class="stop-link" data-stop="${esc(g)}" title="Zaplanuj podróż z tego przystanku">${esc(g)}</button>
        ${vs.map(v=>`<button class="veh-chip ${statusOf(v.delay)}" data-bus="${esc(v.id)}">${BUS_ICON}${esc(v.label)} ${v.delay!=null&&Math.abs(v.delay)>=60?fmtDelay(v.delay,true):''}${v.stopStatus===1?' · tutaj':' · dojeżdża'}</button>`).join('')}</span>
      <span class="times">${last?'<div class="plan">pętla</div>':deps.length?deps.map((x,j)=>`<div class="${j?'plan':'pred '+(x.L.delay!=null?statusOf(x.L.delay):'')}">${fmtClock(x.L.pred)}${x.L.delay!=null&&Math.abs(x.L.delay)>=60?` <small>(${fmtDelay(x.L.delay,true)})</small>`:''}</div>`).join(''):'<div class="plan">brak odjazdów</div>'}</span></li>`; }).join('');
  const tabs = dirs.map(x=>`<button class="pill-btn ${x.key===d.key?'active':''}" data-dir="${esc(x.key)}">→ ${esc(x.head||'kierunek')}</button>`).join('');
  const scroll = soft && document.getElementById('lineTl') ? document.getElementById('lineTl').scrollTop : 0;
  body.innerHTML = `<div class="d-flex flex-wrap mb-3">${tabs}</div>
    <div class="d-flex justify-content-between align-items-center mb-2"><h5 class="section-title m-0">${st.length} przystanków</h5><span class="small text-soft">najbliższe odjazdy (z opóźnieniem)</span></div>
    <ul class="timeline line-tl" id="lineTl" style="max-height:52vh">${rows}</ul>`;
  document.getElementById('lineTl').scrollTop=scroll;
}
document.getElementById('lineBody').addEventListener('click', e=>{
  const t=e.target.closest('[data-dir]'); if(t){ LS.dir=t.dataset.dir; renderLine(false); return; }
  const b=e.target.closest('[data-bus]'); if(b){ lineModal.hide(); const v=S.vehicles.get(b.dataset.bus); if(v){ map.setView([v.lat,v.lon],16); setTimeout(()=>openBus(v.id),300);} return; }
  const s=e.target.closest('[data-stop]'); if(s){ const stop=s.dataset.stop; lineModal.hide(); if(S.agency!=='podroz') setView('podroz',true); plFrom.value=stop; document.getElementById('plan-sec').scrollIntoView({behavior:'smooth'}); setTimeout(()=>document.getElementById('plTo').focus(),400); }
});
document.getElementById('lineMapBtn').addEventListener('click', ()=>{
  const r=routeById(LS.route); const d=lineDirections(r.id).find(x=>x.key===LS.dir); if(!d) return;
  const st=GT.stopTimes.get(d.rep.id)||[]; const color=lineColor(r.short,r.color,r.agency);
  let pts=d.rep.shape && GT.shapes.get(d.rep.shape); const stopPts=st.map(s=>GT.stops.get(s.stop)).filter(Boolean).map(s=>[s.lat,s.lon]);
  if(!pts) pts=stopPts;
  clearRouteLayer();
  S.routeLayer=L.layerGroup([L.polyline(pts,{color:'#fff',weight:9,opacity:.85}), L.polyline(pts,{color,weight:5}),
    ...st.map(s=>{ const p=GT.stops.get(s.stop); return p?L.circleMarker([p.lat,p.lon],{radius:4,color:'#000',weight:1.5,fillColor:'#fff',fillOpacity:1}).bindTooltip(p.name,{className:'bus-tip'}):null; }).filter(Boolean)]).addTo(map);
  S.query=r.short; document.getElementById('lineSearch').value=r.short; renderMarkers(); renderLateList(); renderLineNotice();
  lineModal.hide(); if(pts.length>1) map.fitBounds(L.latLngBounds(pts),{padding:[30,30]});
  document.getElementById('map-sec').scrollIntoView({behavior:'smooth'});
});
function clearRouteLayer(){ if(S.routeLayer){ map.removeLayer(S.routeLayer); S.routeLayer=null; } }

/* ============================================================
   ZAPLANUJ PODRÓŻ — połączenia bezpośrednie i z 1 przesiadką
   ============================================================ */
function resolveStop(txt){
  const q=(txt||'').trim().toLowerCase(); if(!q) return null;
  const names=[...GT.groups.keys()].filter(groupInView);
  return names.find(n=>n.toLowerCase()===q) || names.filter(n=>n.toLowerCase().startsWith(q)).sort((a,b)=>a.length-b.length)[0] || names.filter(n=>n.toLowerCase().includes(q)).sort((a,b)=>a.length-b.length)[0] || null;
}
function mkLeg(d, j, L){
  const r=routeById(d.t.route); const delay=(L&&L.delay)||0;
  return {tid:d.tid, t:d.t, st:d.st, i:d.idx, j, base:d.base, short:r.short, agency:r.agency||'ztm', color:lineColor(r.short,r.color,r.agency), head:d.t.headsign||GT.stopGroupOf.get(d.st[d.st.length-1].stop)||'',
    from:GT.stopGroupOf.get(d.st[d.idx].stop), to:GT.stopGroupOf.get(d.st[j].stop), dep:d.dep, arr:d.base+d.st[j].arr, L, predDep:L?L.pred:d.dep, predArr:d.base+d.st[j].arr+(L&&L.delay!=null?delay:0)};
}
function planTrips(origin, dest, atTs){
  const t0=performance.now();
  const day=Math.round((atTs-todayMidnight())/86400), days=[day-1,day,day+1];
  const fromNames=new Set(origin.names);
  const destIds=new Set(dest.names.flatMap(n=>GT.groups.get(n)?.ids||[]));
  const walkTo=sid=>dest.walk.get(GT.stopGroupOf.get(sid))||0;
  const walkFrom=d=>origin.walk.get(GT.stopGroupOf.get(d.st[d.idx].stop))||0;
  const destIdx=new Map(); for(const sid of destIds) for(const [tid,idx] of GT.byStop.get(sid)||[]){ let a=destIdx.get(tid); if(!a){a=[];destIdx.set(tid,a);} a.push(idx); }
  const firstDestAfter=(tid,i)=>{ const a=destIdx.get(tid); if(!a) return null; const st=GT.stopTimes.get(tid); let m=null, best=Infinity; for(const j of a) if(j>i){ const door=st[j].arr+walkTo(st[j].stop); if(door<best || (door===best && j<m)){ best=door; m=j; } } return m; };
  const deps=origin.names.flatMap(n=>departuresFrom(n, atTs-45*60, atTs+3*3600, tripInView, days)).map(d=>Object.assign(d,{L:liveFor(d.tid,d.st,d.idx,d.base)})).filter(d=>{ const w=walkFrom(d); return d.L.state!=='passed' && d.L.pred>=atTs+w-30 && (d.L.state!=='sched' || d.dep>=atTs+w-60); }).sort((a,b)=>a.L.pred-b.L.pred);
  const out=[]; const seen=new Set();
  const byTrip=new Map(); // ten sam kurs z kilku przystanków: wsiadamy tam, gdzie najbliżej
  for(const d of deps){ const j=firstDestAfter(d.tid,d.idx); if(j==null) continue; const cur=byTrip.get(d.tid); if(!cur || walkFrom(d)<walkFrom(cur.d)) byTrip.set(d.tid,{d,j}); }
  for(const {d,j} of byTrip.values()) out.push({legs:[mkLeg(d,j,d.L)]});
  if(out.length<4){
    for(const d of deps.slice(0,40)){
      if(performance.now()-t0>700) break;
      if(firstDestAfter(d.tid,d.idx)!=null) continue;
      const delay1 = d.L.delay||0; let best=null;
      for(let k=d.idx+1;k<d.st.length && k<=d.idx+40;k++){
        const X=GT.stopGroupOf.get(d.st[k].stop); if(!X||fromNames.has(X)) continue;
        const arr1=d.base+d.st[k].arr+Math.max(0,delay1);
        const sec=departuresFrom(X, arr1+60, arr1+45*60, (t,st2,i2)=> tripInView(t) && t.route!==d.t.route && firstDestAfter(t.id,i2)!=null, days);
        for(const s2 of sec){ const L2=liveFor(s2.tid,s2.st,s2.idx,s2.base); if(L2.state==='passed' || L2.pred < arr1+60) continue;
          const j2=firstDestAfter(s2.tid,s2.idx); const arrive=s2.base+s2.st[j2].arr+(L2.delay||0);
          if(!best || arrive<best.arrive) best={arrive, legs:[mkLeg(d,k,d.L), mkLeg(s2,j2,L2)]}; break; }
      }
      if(best){ const key=best.legs.map(l=>l.tid).join('>'); if(!seen.has(key)){ seen.add(key); out.push({legs:best.legs}); } }
    }
  }
  for(const o of out){ const last=o.legs[o.legs.length-1]; o.dep=o.legs[0].predDep; o.arr=last.predArr; o.walkFrom=origin.walk.get(o.legs[0].from)||0; o.walkTo=dest.walk.get(last.to)||0; }
  // usuń połączenia z przesiadką gorsze od bezpośredniego, które wyjeżdża później a przyjeżdża wcześniej
  const res=out.filter(o=>!out.some(p=>p!==o && p.dep>=o.dep && p.arr<=o.arr && p.legs.length<o.legs.length));
  for(const o of res) o.legs.forEach((l,k)=>{ l.lineColor=l.color; l.color=LEG_COLORS[k%LEG_COLORS.length]; });
  return res.sort((a,b)=>(a.arr+a.walkTo)-(b.arr+b.walkTo) || a.legs.length-b.legs.length).slice(0,7).sort((a,b)=>a.dep-b.dep);
}
function walkText(m){ if(m<20) return 'na miejscu'; return `${m>=1000?(m/1000).toFixed(1).replace('.',',')+' km':m+' m'} · ok. ${Math.max(1,Math.round(m/60))} min pieszo`; }
function walkStep(m, text){ return m ? `<div class="walk-step"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${text} <span class="text-soft">(${walkText(m)})</span></div>` : ''; }
function placeSummary(P){
  const row=(title,p)=>p.isStop?'':`<div><b>${title}:</b> ${esc(p.label)}${p.nearest?` → najbliżej <b>${esc(p.nearest.name)}</b> <span class="text-soft">(${walkText(p.nearest.dist)})</span>`:''}${p.approximate?' <span class="txt-red">nie znaleziono tego numeru, użyto całej ulicy</span>':''}</div>`;
  const rows=row('Skąd',P.origin)+row('Dokąd',P.dest);
  return rows?`<div class="place-summary">${rows}<div class="small text-soft">Czas dojścia jest szacunkowy. Wyniki uwzględniają też inne przystanki w pobliżu.</div></div>`:'';
}
/* ---------- Zaplanuj podróż: wybór środka transportu ---------- */
const WALK_MAX_KM=3, RAIL_MIN_KM=5, FLIGHT_MIN_KM=350, WALK_ONLY_KM=1.2, WALK_KMH=5, WALK_FACTOR=1.3, ROAD_FACTOR=1.25, CAR_KMH=70, RAIL_WALK_M=1500;
const AGENCY_NAMES={ztm:'Autobus', pks:'PKS'}, MODE_NAMES={walk:'Pieszo', rail:'Pociąg', flight:'Samolot', car:'Samochód'};
function transitName(o){ return [...new Set(o.legs.map(l=>AGENCY_NAMES[l.agency]||'Autobus'))].join(' + '); }
// Samochód proponujemy dopiero wtedy, gdy nie ma żadnej innej możliwości.
function tripModes(km, found){
  const modes=[];
  if(km!=null && km<=WALK_MAX_KM) modes.push('walk');
  if(found.transit) modes.push('transit');
  if(found.rail) modes.push('rail');
  if(found.flights) modes.push('flight');
  if(!modes.length && !found.pending) modes.push('car');
  return modes;
}
function bestMode(km, modes, arrival){
  if(modes.includes('flight')) return 'flight';
  if(modes.includes('walk') && km<=WALK_ONLY_KM) return 'walk';
  return modes.filter(m=>arrival[m]!=null).sort((a,b)=>arrival[a]-arrival[b])[0] || modes[0];
}
function fmtKm(km){ return km<1 ? Math.round(km*1000)+' m' : (km<10?km.toFixed(1).replace('.',','):Math.round(km))+' km'; }
function fmtDuration(min){ const m=Math.max(1,Math.round(min)); return m<60 ? m+' min' : `${Math.floor(m/60)} godz. ${m%60} min`; }
function fmtDay(day){ return `${day.slice(8,10)}.${day.slice(5,7)}`; }
function walkMinutes(km){ return km*WALK_FACTOR/WALK_KMH*60; }
function saveTrip(P, id, name, detail){ return favButton({type:'trip', view:'podroz', id, from:P.from, to:P.to, name, detail}, 'Zapisz podróż'); }
function transitCard(o, ix, P){
  const l0=o.legs[0], dur=Math.round((o.arr-o.dep)/60);
  const legsH=o.legs.map((l,k)=>`<div class="leg">
      <span class="leg-line" style="background:${l.color}">${esc(l.short)}</span>${lineStar(l.t.route)}
      <div class="leg-body"><div><b>${fmtClock(l.predDep)}</b> ${esc(l.from)} <span class="text-soft">→</span> <b>${fmtClock(l.predArr)}</b> ${esc(l.to)}</div>
      <div class="leg-meta">${esc(AGENCY_NAMES[l.agency]||'Autobus')} · kierunek ${esc(l.head)} · ${l.j-l.i} przyst.${l.predDep!==l.dep?` · rozkł. ${fmtClock(l.dep)}`:''} ${liveChip(l.L)}</div></div></div>${k<o.legs.length-1?`<div class="transfer">↳ przesiadka: ${esc(l.to)} · ${Math.max(0,Math.round((o.legs[k+1].predDep-l.predArr)/60))} min na przesiadkę</div>`:''}`).join('');
  return `<div class="plan-card" data-ix="${ix}">
    <div class="pc-time"><div class="pc-dep ${l0.L&&l0.L.delay!=null&&statusOf(l0.L.delay)==='late'?'txt-red':''}">${fmtClock(o.dep)}</div><div class="pc-in">${o.walkFrom?'wyjdź '+fmtClock(o.dep-o.walkFrom):inMin(o.dep)}</div></div>
    <div class="pc-main">
      <div class="pc-lines">${o.legs.map(l=>`<span class="leg-line" style="background:${l.color}">${esc(l.short)}</span>`).join('<span class="pc-arrow">›</span>')}
        <span class="pc-sum">przyjazd ${fmtClock(o.arr)} · ${dur} min · ${o.legs.length===1?'bez przesiadek':'1 przesiadka'}</span></div>
      <div class="pc-status">${liveChip(l0.L)}${l0.L&&l0.L.v?` <span class="text-soft small">pojazd ${esc(l0.L.v.label)}${l0.L.v.stopName?' · teraz: '+esc(l0.L.v.stopName):''}</span>`:''}</div>
      <div class="pc-legs">${walkStep(o.walkFrom,`Idź na przystanek ${esc(l0.from)}`)}${legsH}${walkStep(o.walkTo,`Z przystanku ${esc(o.legs[o.legs.length-1].to)} dojdź do celu`)}</div>
    </div>
    <div class="pc-actions"><button class="btn-ghost" data-show="${ix}">Na mapie</button>${l0.L&&l0.L.v?`<button class="btn-ghost" data-bus="${esc(l0.L.v.id)}">Autobus</button>`:''}${saveTrip(P,'t:'+o.legs.map(l=>l.tid).join('>'),`${transitName(o)} ${o.legs.map(l=>l.short).join(' › ')}`,`${fmtClock(o.dep)} → ${fmtClock(o.arr)} · ${dur} min`)}</div>
  </div>`;
}
function trainCard({t,a,dep,arr,from,to,walkFrom,walkTo,access}, P){
  const label=access?`${transitName(access)} + pociąg`:'Pociąg', start=access?access.dep:dep;
  const far=walkTo>RAIL_WALK_M;
  return `<div class="plan-card">
    <div class="pc-time"><div class="pc-dep ${a.delay!=null&&statusOf(a.delay*60)==='late'?'txt-red':''}">${fmtClock(start)}</div><div class="pc-in">${!access&&walkFrom?'wyjdź '+fmtClock(dep-walkFrom):inMin(start)}</div></div>
    <div class="pc-main">
      <div class="pc-lines">${access?access.legs.map(l=>`<span class="leg-line" style="background:${l.color}">${esc(l.short)}</span><span class="pc-arrow">›</span>`).join(''):''}<span class="leg-line" style="background:#181818">${esc(t.cat||'POC')}</span>${trainStar(t)}<span class="pc-sum">przyjazd ${fmtClock(arr)} · ${Math.round((arr-start)/60)} min</span></div>
      <div class="pc-status">${trainDelayChip(a.delay,false)}${a.pl?` <span class="text-soft small">peron ${esc(a.pl)}${a.tr?' · tor '+esc(a.tr):''}</span>`:''}</div>
      <div class="pc-legs">${access?`<div class="leg-meta">${esc(transitName(access))} do stacji ${esc(from)}: odjazd ${fmtClock(access.dep)}, przyjazd ${fmtClock(access.arr)}</div>`:walkStep(walkFrom,`Idź na stację ${esc(from)}`)}<div class="leg-meta">${fmtClock(dep)} ${esc(from)} → ${fmtClock(arr)} ${esc(to)} · ${esc(t.label)}${t.name?' „'+esc(t.name)+'”':''}${TR.carriers.get(t.carrier)?' · '+esc(TR.carriers.get(t.carrier)):''}</div>${far?`<div class="leg-meta">Ze stacji ${esc(to)} do celu zostaje ${fmtKm(walkTo/1000)}</div>`:walkStep(walkTo,`Ze stacji ${esc(to)} dojdź do celu`)}</div>
    </div>
    <div class="pc-actions"><button class="btn-ghost" data-train="${esc(t.key)}">Szczegóły</button>${saveTrip(P,'r:'+t.label+':'+from+':'+to,label+' '+t.label,`${fmtClock(start)} → ${fmtClock(arr)} · ${esc(from)} → ${esc(to)}`)}</div>
  </div>`;
}
function walkCard(P){
  const min=walkMinutes(P.km), km=P.km*WALK_FACTOR;
  return `<div class="plan-card">
    <div class="pc-time"><div class="pc-dep">${fmtDuration(min)}</div><div class="pc-in">pieszo</div></div>
    <div class="pc-main"><div class="pc-lines"><span class="leg-line" style="background:#1F7A4D"><i class="fa-solid fa-person-walking" aria-hidden="true"></i></span><span class="pc-sum">ok. ${fmtKm(km)} · czas szacunkowy</span></div></div>
    <div class="pc-actions">${saveTrip(P,'walk','Pieszo',`ok. ${fmtKm(km)} · ${fmtDuration(min)}`)}</div>
  </div>`;
}
function carCard(P){
  const d=P.driving, km=d?d.km:(P.km==null?null:P.km*ROAD_FACTOR), min=d?d.minutes:(km==null?null:km/CAR_KMH*60);
  if(km==null) return '<div class="empty-note">Nie udało się ustalić odległości między tymi miejscami.</div>';
  return `<div class="plan-card">
    <div class="pc-time"><div class="pc-dep">${fmtKm(km)}</div><div class="pc-in">samochodem</div></div>
    <div class="pc-main"><div class="pc-lines"><span class="leg-line" style="background:#5C5C5C"><i class="fa-solid fa-car" aria-hidden="true"></i></span><span class="pc-sum">ok. ${fmtDuration(min)}${d?'':' · odległość szacunkowa'}</span></div>
      <div class="pc-legs"><div class="leg-meta">Tej trasy nie da się przejechać komunikacją, którą znamy, dlatego proponujemy samochód.</div></div></div>
    <div class="pc-actions">${saveTrip(P,'car','Samochód',`${fmtKm(km)} · ${fmtDuration(min)}`)}</div>
  </div>`;
}
/* ---------- Dojazd na lotnisko krok po kroku ---------- */
const CHECKIN_MIN=120, RAIL_KMH=80, TRIP_FLIGHT_PAGE=10;
// Dworzec, z którego najłatwiej dotrzeć na dane lotnisko.
const RAIL_HUBS={RZE:['Jasionka Lotnisko',50.11555,22.02219], KRK:['Kraków Główny',50.0675,19.9476], KTW:['Katowice',50.2576,19.0172], LUZ:['Lublin Główny',51.2317,22.5685], WAW:['Warszawa Centralna',52.2288,21.0033], WMI:['Warszawa Centralna',52.2288,21.0033]};
const step=(icon,text,sub='')=>({icon,text,sub});
function fareStart(f){
  const base=dayInfo(Math.round((Date.parse(f.day)-Date.parse(ymdOf(0)))/86400000)).base;
  if(!f.departure) return {base, at:null};
  const [h,m]=f.departure.slice(11).split(':').map(Number);
  return {base, at:base+h*3600+m*60};
}
function arrivingBy(origin, stops, deadline){
  const dest={names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist]))};
  for(const hours of [3,5.5]){ const fit=planTrips(origin,dest,deadline-hours*3600).filter(o=>o.arr+o.walkTo<=deadline); if(fit.length) return fit[fit.length-1]; }
  return null;
}
function transitSteps(o){
  const steps=[], last=o.legs[o.legs.length-1];
  if(o.walkFrom) steps.push(step('person-walking',`Idź na przystanek ${o.legs[0].from}`,walkText(o.walkFrom)));
  for(const l of o.legs) steps.push(step('bus',`${AGENCY_NAMES[l.agency]||'Autobus'} ${l.short}: ${l.from} → ${l.to}`,`${fmtClock(l.predDep)} – ${fmtClock(l.predArr)} · kierunek ${l.head}`));
  if(o.walkTo) steps.push(step('person-walking',`Z przystanku ${last.to} dojdź na miejsce`,walkText(o.walkTo)));
  return steps;
}
function railAccess(P, f, deadline){
  const hub=RAIL_HUBS[f.from], a=P.origin.points[0]; if(!hub||!a) return null;
  const main=stopPoint('Rzeszów Główny'), near=stationsNear(P.origin)[0];
  const station=main && hav(a,main)<=30000 ? {name:'Rzeszów Główny', dist:Math.round(hav(a,main))} : near; if(!station) return null;
  const hubPoint=[hub[1],hub[2]], railKm=hav(stopPoint(station.name),hubPoint)/1000*ROAD_FACTOR, railMin=railKm/RAIL_KMH*60;
  const lastKm=hav(hubPoint,[f.airport.lat,f.airport.lon])/1000*ROAD_FACTOR;
  const steps=[];
  if(station.dist<=RAIL_WALK_M) steps.push(step('person-walking',`Idź na stację ${station.name}`,walkText(station.dist)));
  else {
    const stops=nearbyStops({points:[stopPoint(station.name)]}).filter(x=>x.dist<=800);
    const o=stops.length && P.origin.names.length ? arrivingBy(P.origin,stops,deadline-(railMin+45)*60-lastKm*120) : null;
    if(o) steps.push(...transitSteps(o)); else steps.push(step('bus',`Dojedź na stację ${station.name}`,`ok. ${fmtKm(station.dist/1000)}`));
  }
  steps.push(step('train',`Pociąg ${station.name} → ${hub[0]}`,`ok. ${fmtDuration(railMin)} · czas szacunkowy, sprawdź rozkład PKP`));
  if(lastKm>=1.5) steps.push(step('bus',`Z dworca ${hub[0]} na lotnisko`,`ok. ${fmtKm(lastKm)}`));
  return {id:'rail', title:'Pociąg + samolot', steps};
}
async function carToAirport(P, f){
  const a=P.origin.points[0], b=[f.airport.lat,f.airport.lon]; if(!a) return null;
  if(!P.carTo.has(f.from)){
    let route=null;
    try{ const r=await fetch(`/api/driving?from=${pointParam(a)}&to=${pointParam(b)}`); if(r.ok) route=(await r.json()).route; }
    catch(e){ console.warn('Trasa na lotnisko', e); }
    P.carTo.set(f.from,route);
  }
  const d=P.carTo.get(f.from), km=d?d.km:hav(a,b)/1000*ROAD_FACTOR, min=d?d.minutes:km/CAR_KMH*60;
  return {id:'car', title:'Samochód + samolot', steps:[step('car',`Jedź samochodem na lotnisko ${f.fromLabel}`,`${fmtKm(km)} · ok. ${fmtDuration(min)}${d?'':' · szacunkowo'}`)]};
}
function flightSteps(P, f){
  const {at}=fareStart(f), times=f.departure?`${f.departure.slice(11)}${f.arrival?' – '+f.arrival.slice(11):''}`:'godzinę sprawdź u przewoźnika';
  return [
    step('passport',at?`Bądź na lotnisku do ${fmtClock(at-CHECKIN_MIN*60)}`:'Bądź na lotnisku 2 godz. przed wylotem',at?'2 godz. przed wylotem':'Linia podała tylko cenę dnia, więc dojazd to przykładowy kurs.'),
    step('plane-departure',`Lot ${airlineOf(f).name}${f.flightNumber?' '+f.flightNumber:''}: ${f.fromLabel} → ${f.toLabel}`,`${fmtDay(f.day)} · ${times} · ${Math.round(f.pricePln)} zł`),
    step('flag-checkered',`Z lotniska do celu: ${P.to}`,`ok. ${fmtKm(f.fromAirportKm)}`),
  ];
}
async function buildAccess(P, f){
  const {base,at}=fareStart(f), deadline=at!=null?at-CHECKIN_MIN*60:base+10*3600, point=[f.airport.lat,f.airport.lon], options=[];
  const stops=nearbyStops({points:[point]}).filter(x=>x.dist<=800);
  const o=stops.length && P.origin.names.length ? arrivingBy(P.origin,stops,deadline) : null;
  if(o) options.push({id:'bus', title:`${transitName(o)} + samolot`, steps:transitSteps(o)});
  const rail=railAccess(P,f,deadline); if(rail) options.push(rail);
  const car=await carToAirport(P,f); if(car) options.push(car);
  return options;
}
function returnSteps(P, f){
  const r=f.ret; if(!r) return [];
  const days=Math.round((Date.parse(r.day)-Date.parse(f.day))/86400000)+1, times=r.departure?`${r.departure.slice(11)}${r.arrival?' – '+r.arrival.slice(11):''}`:'godzinę sprawdź u przewoźnika';
  return [
    step('bed',`Na miejscu: ${days} ${days===1?'dzień':'dni'}`,`${fmtDay(f.day)} – ${fmtDay(r.day)}`),
    step('plane-arrival',`Lot powrotny ${airlineOf(r).name}${r.flightNumber?' '+r.flightNumber:''}: ${r.fromLabel} → ${r.toLabel}`,`${fmtDay(r.day)} · ${times} · ${Math.round(r.pricePln)} zł`),
    step('house',`Z lotniska do domu: ${P.from}`,`ok. ${fmtKm(r.homeKm)}`),
  ];
}
function otherReturns(f){
  const list=(f.returns||[]).slice(1); if(!list.length) return '';
  return `<div class="trip-others"><b>Inne terminy powrotu</b>${list.map(r=>{ FL.byKey.set(fareKey(r),r); return `<button class="btn-ghost" type="button" data-flight="${esc(fareKey(r))}">${esc(flightDetail(r))}</button>`; }).join('')}</div>`;
}
function ensureAccess(P, f){
  const key=fareKey(f); if(P.access.has(key)) return;
  P.access.set(key,null);
  buildAccess(P,f).catch(e=>{ console.warn('Dojazd na lotnisko', e); return []; }).then(options=>{ P.access.set(key,options); if(S.plan===P) runPlan(false); });
}
function accessHtml(P, f){
  const options=P.access.get(fareKey(f));
  if(!options) return '<div class="empty-note">Liczę dojazd na lotnisko…</div>';
  const route=o=>`<div class="trip-route"><div class="tr-head"><b>${esc(o.title)}</b>${saveTrip(P,`f:${fareKey(f)}:${o.id}`,`${o.title} · ${airlineOf(f).name}`,f.ret?`${flightDetail(f)} · powrót ${fmtDay(f.ret.day)}`:flightDetail(f))}</div>
    <ol class="trip-steps">${[...o.steps,...flightSteps(P,f),...returnSteps(P,f)].map(s=>`<li><i class="fa-solid fa-${s.icon}" aria-hidden="true"></i><div><b>${esc(s.text)}</b>${s.sub?`<small>${esc(s.sub)}</small>`:''}</div></li>`).join('')}</ol></div>`;
  return `<div class="trip-routes">${options.length?options.map(route).join(''):route({id:'x',title:'Samolot',steps:[]})}</div>${otherReturns(f)}<button class="btn-ghost" type="button" data-flight="${esc(fareKey(f))}">Szczegóły lotu</button>`;
}
function tripFlightRow(f, P, best){
  const key=fareKey(f), open=P.openFlight===key; FL.byKey.set(key,f);
  return `<div class="trip-flight ${best?'best':''}">
    <button class="flight-row" type="button" data-open-flight="${esc(key)}" aria-expanded="${open}">
      <span class="fl-price">${Math.round(f.pricePln+(f.ret?.pricePln||0))} zł</span>
      <span class="leg-line" style="background:${airlineOf(f).color}">${esc(airlineOf(f).name)}</span>
      <span class="fl-route"><b>${esc(f.fromLabel)} → ${esc(f.toLabel)}</b><small>${fmtDay(f.day)}${f.departure?` · ${f.departure.slice(11)}${f.arrival?'–'+f.arrival.slice(11):''}`:''}${f.ret?` · powrót ${fmtDay(f.ret.day)} (${esc(airlineOf(f.ret).name)})`:''} · z dojazdem ok. ${f.totalPln} zł</small></span>
      <span class="fl-more">${best?'<span class="fl-best">Najtaniej</span> ':''}${open?'Zwiń ▲':'Jak dojechać ▼'}</span></button>
    ${open?`<div class="trip-open">${accessHtml(P,f)}</div>`:''}</div>`;
}
function tripFlights(P){
  const all=P.flights.options, p=paginate(all,P.flightPage,TRIP_FLIGHT_PAGE), bestKey=fareKey(all[0]);
  const open=all.find(f=>fareKey(f)===P.openFlight); if(open) ensureAccess(P,open);
  return `<div class="small text-soft mb-2">${all.length} lotów, od najtańszego razem z dojazdem. Kliknij lot, aby zobaczyć trasę krok po kroku.</div>`+
    p.rows.map(f=>tripFlightRow(f,P,fareKey(f)===bestKey)).join('')+pagerHtml(p,false);
}
function flightNote(P){
  if(P.flights===undefined) return '<div class="empty-note">Szukam lotów…</div>';
  if(P.flights===null) return '<div class="empty-note">Dane o lotach są chwilowo niedostępne.</div>';
  const near=list=>list.map(a=>`${esc(a.city)} (${esc(a.code)}, ${a.km} km)`).join(', ')||'brak w pobliżu';
  return `<div class="empty-note">Brak lotów tanich linii na tej trasie w najbliższych dwóch tygodniach.<br>Lotniska przy starcie: ${near(P.flights.originAirports)}. Lotniska przy celu: ${near(P.flights.destAirports)}.</div>`;
}
function bestText(best, P, transit, rail){
  if(best==='walk') return `Najlepiej pieszo: ok. ${fmtDuration(walkMinutes(P.km))}.`;
  if(best==='transit'){ const o=[...transit].sort((a,b)=>(a.arr+a.walkTo)-(b.arr+b.walkTo))[0]; return `Najszybciej: ${transitName(o)} ${o.legs.map(l=>l.short).join(' › ')}, przyjazd ${fmtClock(o.arr)}.`; }
  if(best==='rail'){ const r=[...rail].sort((a,b)=>a.arr-b.arr)[0]; return `Najszybciej: ${r.access?transitName(r.access)+' + pociąg':'pociąg'} ${r.t.label}, przyjazd ${fmtClock(r.arr)}.`; }
  if(best==='flight'){ const f=P.flights.options[0]; return `Najtaniej z dojazdem: ${airlineOf(f).name} z ${f.fromLabel}, ${fmtDay(f.day)}, ok. ${f.totalPln} zł${f.ret?' w obie strony':''}.`; }
  return 'Brak połączeń komunikacją. Najlepiej dojechać samochodem.';
}
function tripSection(title, html, icon){ return `<div class="trip-sec"><h3 class="trip-title"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${esc(title)}</h3>${html}</div>`; }
function renderJourney(P, transit, rail, back){
  const flightsNeeded=P.km!=null && P.km>=FLIGHT_MIN_KM, flights=P.flights?.options||[];
  const modes=tripModes(P.km, {transit:transit.length>0, rail:rail.length>0, flights:flights.length>0, pending:flightsNeeded && P.flights===undefined});
  const at=P.at||nowSec();
  const arrival={walk:P.km==null?null:at+walkMinutes(P.km)*60, transit:transit.length?Math.min(...transit.map(o=>o.arr+o.walkTo)):null, rail:rail.length?Math.min(...rail.map(r=>r.arr)):null};
  const best=modes.length?bestMode(P.km,modes,arrival):null;
  if(modes.includes('car') && P.driving===undefined) loadDriving(P);
  const names=[...new Set(transit.map(transitName))].join(' / ');
  const sections=[];
  if(modes.includes('walk')) sections.push(tripSection('Pieszo', walkCard(P), 'person-walking'));
  if(transit.length) sections.push(tripSection(names, transit.map((o,ix)=>transitCard(o,ix,P)).join('')+planPager(transit), 'bus'));
  else if(P.history.length) sections.push(planPager(transit));
  if(rail.length) sections.push(tripSection('Pociąg', (TR.mode==='demo'?'<div class="small text-soft mb-2">Przykładowe dane — prawdziwe połączenia pojawią się po dodaniu klucza PKP PLK w Ustawieniach.</div>':'')+rail.map(r=>trainCard(r,P)).join(''), 'train'));
  if(flightsNeeded) sections.push(tripSection('Samolot', flights.length?tripFlights(P):flightNote(P), 'plane'));
  if(modes.includes('car')) sections.push(tripSection('Samochód', carCard(P), 'car'));
  if(P.round && !flightsNeeded) sections.push(tripSection(`Powrót ${fmtDay(P.round.back)}`, back.length?back.map((o,ix)=>transitCard(o,transit.length+ix,P)).join(''):'<div class="empty-note">Brak połączeń komunikacją w dniu powrotu. Wróć tą samą trasą.</div>', 'rotate-left'));
  S.planResults=[...transit, ...back];
  document.getElementById('planResults').innerHTML=placeSummary(P)+
    `<div class="plan-head"><span>${esc(P.from)} <span class="txt-red">→</span> ${esc(P.to)} ${favButton({type:'route',view:'podroz',from:P.from,to:P.to})}</span><span class="text-soft">${P.km==null?'':'w linii prostej '+fmtKm(P.km)+' · '}${P.date?fmtDay(P.date)+' · ':''}${P.at?'odjazd od '+fmtClock(P.at):'odjazdy od teraz'}${P.round?` · powrót od ${fmtDay(P.round.back)}`:''}</span></div>`+
    (best?`<div class="trip-best">${esc(bestText(best,P,transit,rail))}</div>`:'')+sections.join('');
}
function stationsNear(place){ return place.points.length ? nearbyStops({points:place.points},'kolej') : []; }
function busToStation(origin, station, at){
  const point=stopPoint(station); if(!point || !origin.names.length) return null;
  const stops=nearbyStops({points:[point]}).filter(x=>x.dist<=800); if(!stops.length) return null;
  return planTrips(origin, {names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist]))}, at)[0]||null;
}
// Do dalekiej stacji dowozi autobus, a dopiero stąd liczy się odjazd pociągu.
function planRail(P, at){
  if(P.km==null || P.km<RAIL_MIN_KM) return [];
  const to=stationsNear(P.dest); if(!to.length) return [];
  const dest={names:to.map(x=>x.name), walk:new Map(to.map(x=>[x.name,x.dist]))}, found=new Map();
  for(const s of stationsNear(P.origin)){
    const access=s.dist>RAIL_WALK_M ? busToStation(P.origin,s.name,at) : null;
    if(s.dist>RAIL_WALK_M && !access) continue;
    const start=access ? access.arr+300 : at;
    for(const r of planTrainRoutes({names:[s.name], walk:new Map([[s.name,access?0:s.dist]])}, dest, start)) if(!found.has(r.t.key)) found.set(r.t.key, Object.assign(r,{access}));
  }
  return [...found.values()].sort((a,b)=>a.dep-b.dep).slice(0,5);
}
function runPlan(scroll){
  const P=S.plan; if(!P) return;
  const at=P.at||nowSec();
  const transit=GT.loaded && P.origin.names.length && P.dest.names.length ? planTrips(P.origin, P.dest, at) : [];
  const back=P.round && GT.loaded && P.origin.names.length && P.dest.names.length && !(P.km>=FLIGHT_MIN_KM) ? planTrips(P.dest, P.origin, P.round.at) : [];
  renderJourney(P, transit, GT.loaded?planRail(P,at):[], back);
  if(scroll) document.getElementById('planResults').scrollIntoView({behavior:'smooth', block:'nearest'});
}
const pointParam=p=>p[0].toFixed(4)+','+p[1].toFixed(4);
async function loadDriving(P){
  P.driving=null;
  const a=P.origin.points[0], b=P.dest.points[0]; if(!a||!b) return;
  try{ const r=await fetch(`/api/driving?from=${pointParam(a)}&to=${pointParam(b)}`); if(r.ok) P.driving=(await r.json()).route; }
  catch(e){ console.warn('Trasa samochodowa', e); }
  if(S.plan===P && P.driving) runPlan(false);
}
async function loadTripFlights(P){
  const a=P.origin.points[0], b=P.dest.points[0];
  try{
    const r=await fetch(`/api/flights/options?origin=${pointParam(a)}&dest=${pointParam(b)}${P.date?'&date='+P.date:''}${P.round?`&stay=${P.round.stay}&back=${P.round.back}`:''}`);
    P.flights=r.ok ? await r.json() : null;
    if(P.flights?.options.length) P.openFlight=fareKey(P.flights.options[0]);
  }catch(e){ console.warn('Loty', e); P.flights=null; }
  if(S.plan===P) runPlan(false);
}
function drawTripLine(P){
  clearRouteLayer();
  const a=P.origin.points[0], b=P.dest.points[0]; if(!a||!b) return;
  const dot=(p,color,name)=>L.circleMarker(p,{radius:8,color:'#fff',weight:3,fillColor:color,fillOpacity:1}).bindTooltip(esc(name),{className:'bus-tip',direction:'top',permanent:true});
  S.routeLayer=L.layerGroup([L.polyline([a,b],{color:'#181818',weight:3,dashArray:'6 8',interactive:false}), dot(a,LEG_COLORS[0],P.from), dot(b,'#181818',P.to)]).addTo(map);
  fitView();
}

/* ---------- Tanie linie lotnicze ---------- */
const FL={from:'', to:'', date:'', page:1, data:null, network:[], byKey:new Map()}, FLIGHT_PAGE=10;
const AIRLINES={RYANAIR:{name:'Ryanair', color:'#073590'}, WIZZ:{name:'Wizz Air', color:'#C6007E'}};
function airlineOf(f){ return AIRLINES[f.airline]||{name:f.airline, color:'#5C5C5C'}; }
function fareKey(f){ return [f.airline,f.flightNumber||'',f.from,f.to,f.day,f.departure||''].join('|'); }
function flightDetail(f){ return `${f.from} → ${f.to} · ${fmtDay(f.day)}${f.departure?' '+f.departure.slice(11):''} · ${Math.round(f.pricePln)} zł`; }
function isSampleFare(f){ return f.source.startsWith('sample'); }
function foreignPlaces(){ return (FL.data?.destinations||[]).filter(a=>a.country && a.country!=='Polska').map(a=>({label:`${a.city}, ${a.country}`, points:[[a.lat,a.lon]]})); }
async function loadFlights(){
  if(!FL.network.length){ try{ const r=await fetch('/api/flights/network'); if(r.ok) FL.network=(await r.json()).routes; }catch(e){ console.warn('Sieć połączeń', e); } }
  const q=new URLSearchParams(Object.entries({from:FL.from,to:FL.to,date:FL.date}).filter(([,v])=>v));
  try{
    const r=await fetch('/api/flights?'+q); if(!r.ok) throw new Error('HTTP '+r.status);
    FL.data=await r.json();
  }catch(e){ console.warn('Loty', e); FL.data=null; }
  FL.page=1; renderFlights();
}
// Kraj → lotniska. Trasa jest możliwa, gdy lata nią któraś linia, nawet jeśli jeszcze jej nie sprawdzaliśmy.
function airportGroups(airports, stored, network, kind, other){
  const near=kind==='from'?'to':'from', hit=list=>new Set(list.filter(r=>!other||r[near]===other).map(r=>r[kind]));
  const withFlights=hit(stored), possible=hit(network), used=new Set([...network,...stored].flatMap(r=>[r.from,r.to]));
  const groups=new Map();
  for(const a of airports){
    if(network.length && !used.has(a.code)) continue;
    const c=a.country||'Inne'; if(!groups.has(c)) groups.set(c,[]);
    groups.get(c).push({...a, stored:withFlights.has(a.code), served:withFlights.has(a.code)||possible.has(a.code)});
  }
  return [...groups.entries()].sort(([a],[b])=>(b==='Polska')-(a==='Polska') || natSort(a,b))
    .map(([country,items])=>({country, items:items.sort((a,b)=>b.stored-a.stored || b.served-a.served || natSort(a.label,b.label))}));
}
function airportSelect(id, kind){
  const D=FL.data, value=kind==='from'?FL.from:FL.to, other=kind==='from'?FL.to:FL.from, known=FL.network.length>0;
  const note=a=>a.stored?'':a.served?' — do sprawdzenia':' — brak połączenia';
  document.getElementById(id).innerHTML='<option value="">Wszystkie</option>'+airportGroups(D.airports,D.routes,FL.network,kind,other).map(g=>`<optgroup label="${esc(g.country)}">${g.items.map(a=>`<option value="${esc(a.code)}" class="${a.served?'':'off'}" ${!a.served&&known?'disabled':''} ${a.code===value?'selected':''}>${esc(a.label)}${note(a)}</option>`).join('')}</optgroup>`).join('');
}
function matchingRoutes(list){ return list.filter(r=>(!FL.from||r.from===FL.from)&&(!FL.to||r.to===FL.to)); }
function renderRouteInfo(){
  const el=document.getElementById('flightRoute'), D=FL.data, {from,to,date}=FL;
  if(!D || (!from&&!to)){ el.innerHTML=''; return; }
  const routes=matchingRoutes(D.routes), possible=matchingRoutes(FL.network), known=FL.network.length>0;
  const name=code=>D.airports.find(a=>a.code===code)?.label||code;
  const canScan=possible.length>0 || (!known && from && to);
  const scan=canScan?`<button class="btn-ghost" type="button" data-scan>${from&&to?'Odśwież ten kierunek':`Sprawdź kierunki (${possible.length})`}</button>`:'';
  const lines=[...new Set(possible.flatMap(r=>r.airlines))].map(c=>AIRLINES[c]?.name||c).join(', ');
  if(!routes.length){ el.innerHTML=`<div class="route-info"><span>${canScan?`Tą trasą latają: <b>${esc(lines||'Ryanair, Wizz Air')}</b>. Nie ma jeszcze cen w bazie.`:`Ani Ryanair, ani Wizz Air nie łączą ${esc(name(from))} z ${esc(name(to))}.`}</span>${scan}</div>`; return; }
  const first=routes.map(r=>r.firstDay).sort()[0], cheapest=Math.min(...routes.map(r=>r.cheapest));
  el.innerHTML=`<div class="route-info"><span>${date&&!D.total?'<b>Brak lotów w tym dniu.</b> ':''}Pierwszy dostępny lot: <b>${fmtDay(first)}</b> · od ${Math.round(cheapest)} zł</span>${date&&!D.total?`<button class="btn-ghost" type="button" data-first-day="${esc(first)}">Pokaż ${fmtDay(first)}</button>`:''}${scan}</div>`;
}
/* ---------- Okno skanowania trasy ---------- */
const scanModalEl=document.getElementById('scanModal'); const scanModal=new bootstrap.Modal(scanModalEl);
const [scanStart,scanEnd]=['scanStart','scanEnd'].map(id=>document.getElementById(id));
function scanPairs(){ const known=matchingRoutes(FL.network); return known.length ? known : [{from:FL.from, to:FL.to, airlines:['RYANAIR','WIZZ']}]; }
function scanAirlines(){ return [...document.querySelectorAll('#scanAirlines input:checked')].map(e=>e.value); }
function scanMinutes(pairs, airlines, days){
  const seconds=pairs.reduce((sum,p)=>sum+p.airlines.filter(a=>airlines.includes(a)).reduce((s,a)=>s+(a==='RYANAIR'?Math.ceil(days/7)*6:Math.ceil(days/14)*15+15),0),0);
  return Math.max(1,Math.ceil(seconds/60)+1);
}
function renderScanInfo(){
  const pairs=scanPairs(), airlines=scanAirlines(), days=(Date.parse(scanEnd.value)-Date.parse(scanStart.value))/86400000+1;
  const ok=airlines.length>0 && days>=1 && days<=91;
  document.getElementById('scanInfo').textContent=!airlines.length?'Wybierz co najmniej jedną linię.':days<1?'Data końcowa nie może być wcześniejsza niż początkowa.':days>91?'Okres może mieć najwyżej 90 dni.':`Kierunki: ${pairs.length} · sprawdzamy oba kierunki lotu · około ${scanMinutes(pairs,airlines,days)} min`;
  document.getElementById('scanGo').disabled=!ok;
}
function openScan(){
  const pairs=scanPairs(), airlines=[...new Set(pairs.flatMap(p=>p.airlines))], today=ymdOf(0);
  const name=code=>FL.data.airports.find(a=>a.code===code)?.label||'wszystkie';
  document.getElementById('scanRoute').textContent=`${name(FL.from)} → ${name(FL.to)}`;
  document.getElementById('scanAirlines').innerHTML=airlines.map(a=>`<label class="trip-check"><input type="checkbox" value="${esc(a)}" checked> ${esc(AIRLINES[a]?.name||a)}</label>`).join('');
  scanStart.min=scanEnd.min=today; scanStart.value=FL.date||today; scanEnd.value=earliestReturnDay(scanStart.value,15);
  renderScanInfo(); scanModal.show();
}
document.getElementById('scanModal').addEventListener('change', renderScanInfo);
document.getElementById('scanGo').addEventListener('click', ()=>{ scanModal.hide(); refreshFlights({from:FL.from,to:FL.to,start:scanStart.value,end:scanEnd.value,airlines:scanAirlines()}); });
function setFlightStatus(text){ document.getElementById('flightStatus').textContent=text; }
async function refreshFlights(target={}){
  setFlightStatus('Uruchamiam pobieranie lotów…');
  try{
    const r=await fetch('/api/flights/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(target)});
    if(r.status===401){ setFlightStatus('Zaloguj się jako administrator, aby odświeżyć loty.'); return; }
    if(!r.ok && r.status!==409){ setFlightStatus((await r.json()).error); return; }
    watchFlightRefresh();
  }catch(e){ console.warn('Odświeżanie lotów', e); setFlightStatus('Nie udało się uruchomić pobierania lotów.'); }
}
let flightWatch=null;
async function watchFlightRefresh(){
  clearTimeout(flightWatch);
  try{
    const st=await (await fetch('/api/flights/status')).json();
    const t=st.target;
    if(st.running){ setFlightStatus(`Pobieram loty${t?` ${t.from||'*'} → ${t.to||'*'}`:''}… To może potrwać kilka minut.`); flightWatch=setTimeout(watchFlightRefresh,5000); return; }
    await loadFlights();
    if(st.error) setFlightStatus('Pobieranie lotów nie powiodło się. Spróbuj później.');
    else if(t?.from && t.to && !FL.data?.routes.some(r=>r.from===t.from&&r.to===t.to)) setFlightStatus(`Brak lotów ${t.from} → ${t.to} w okresie ${fmtDay(t.start)} – ${fmtDay(t.end)}.`);
    else if(st.finishedAt) setFlightStatus('Loty zaktualizowane.');
  }catch(e){ console.warn('Stan pobierania lotów', e); }
}
function renderFlights(){
  const list=document.getElementById('flightList'), meta=document.getElementById('flightMeta'), cards=document.getElementById('flightAirlines'), D=FL.data;
  if(!D){ renderRouteInfo(); meta.textContent=''; cards.innerHTML=''; list.innerHTML='<div class="empty-note">Dane o lotach są chwilowo niedostępne.</div>'; return; }
  airportSelect('flFrom','from'); airportSelect('flTo','to'); renderRouteInfo();
  meta.textContent=D.collectedAt ? `Ceny pobrane ${new Date(D.collectedAt).toLocaleDateString('pl-PL')} · 1 osoba, bez bagażu` : '';
  cards.innerHTML=D.airlines.map(a=>{ const x=airlineOf(a); return `<div class="airline-card" style="--a:${x.color}"><b>${esc(x.name)}</b><span>${a.flights} lotów</span><span>od ${Math.round(a.cheapest)} zł</span></div>`; }).join('');
  if(!D.total){ list.innerHTML=`<div class="empty-note">${D.airlines.length?'Brak lotów dla tych filtrów.':'Nie ma jeszcze danych o lotach. Pojawią się po imporcie cen tanich linii.'}</div>`; return; }
  const p=paginate(D.flights, FL.page, FLIGHT_PAGE);
  list.innerHTML=p.rows.map(f=>{ FL.byKey.set(fareKey(f),f); return `<button class="flight-row" type="button" data-flight="${esc(fareKey(f))}">
      <span class="fl-price">${Math.round(f.pricePln)} zł</span>
      <span class="leg-line" style="background:${airlineOf(f).color}">${esc(airlineOf(f).name)}</span>
      <span class="fl-route"><b>${esc(f.fromLabel)} → ${esc(f.toLabel)}</b><small>${fmtDay(f.day)}${f.departure?` · ${f.departure.slice(11)}${f.arrival?'–'+f.arrival.slice(11):''}`:''}${f.flightNumber?' · '+esc(f.flightNumber):''}${isSampleFare(f)?' · próbka':''}</small></span>
      <span class="fl-more">Szczegóły →</span></button>`; }).join('')+pagerHtml(p,false);
}
const flightModalEl=document.getElementById('flightModal'); const flightModal=new bootstrap.Modal(flightModalEl);
function openFlight(key){
  const f=FL.byKey.get(key); if(!f) return;
  const x=airlineOf(f), P=S.plan;
  const hero=document.getElementById('flightHero'); hero.style.setProperty('--h1',x.color); hero.style.setProperty('--h2',x.color);
  hero.innerHTML=`<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Zamknij"></button>
    <span class="kicker mb-1">${esc(x.name)}${f.flightNumber?' · '+esc(f.flightNumber):''}</span><h4>${esc(f.fromLabel)} → ${esc(f.toLabel)}</h4><div class="sub">${fmtDay(f.day)}</div>`;
  const row=(k,v)=>v?`<div class="fl-detail"><span>${k}</span><b>${esc(v)}</b></div>`:'';
  document.getElementById('flightBody').innerHTML=
    row('Wylot (czas lokalny)',f.departure?f.departure.slice(11):'brak godziny w tej cenie')+row('Przylot (czas lokalny)',f.arrival?.slice(11))+
    row('Cena',`${Math.round(f.pricePln)} zł`+(f.currency&&f.currency!=='PLN'?` (${f.price} ${f.currency})`:''))+
    row('Rodzaj ceny',f.priceType==='list'?'Cena katalogowa, przed promocjami':'Cena konkretnego lotu')+
    row('Zostało miejsc',f.seatsLeft!=null?String(f.seatsLeft):'')+
    row('Cena z dnia',new Date(f.collectedAt).toLocaleDateString('pl-PL'))+
    (isSampleFare(f)?'<div class="small text-soft mt-2">Próbka z zapisanych odpowiedzi linii. Cena może być nieaktualna.</div>':'')+
    `<div class="small text-soft mt-2">1 osoba, bez bagażu i wyboru miejsca. Aktualną cenę potwierdzisz u przewoźnika.</div>
    <div class="d-flex gap-2 flex-wrap mt-3">${f.bookingUrl?`<a class="btn-grad" href="${esc(f.bookingUrl)}" target="_blank" rel="noopener">Sprawdź u przewoźnika</a>`:''}${favButton({type:'trip',view:'podroz',id:'f:'+key,from:P?.from||f.fromLabel,to:P?.to||f.toLabel,name:`${x.name} ${f.flightNumber||''}`.trim(),detail:flightDetail(f)},'Zapisz podróż')}</div>`;
  flightModal.show();
}
function applyFlightFilters(){ FL.from=document.getElementById('flFrom').value; FL.to=document.getElementById('flTo').value; FL.date=document.getElementById('flDate').value; return loadFlights(); }
document.getElementById('flightForm').addEventListener('submit', e=>{ e.preventDefault(); applyFlightFilters(); });
['flFrom','flTo','flDate'].forEach(id=>document.getElementById(id).addEventListener('change', applyFlightFilters));
document.getElementById('flightRoute').addEventListener('click', e=>{
  if(e.target.closest('[data-scan]')){ openScan(); return; }
  const d=e.target.closest('[data-first-day]'); if(d){ document.getElementById('flDate').value=d.dataset.firstDay; applyFlightFilters(); }
});
document.getElementById('refreshFlightsBtn').addEventListener('click', ()=>{
  if(S.agency!=='podroz') setView('podroz',true);
  document.getElementById('flights-sec').scrollIntoView({behavior:'instant'});
  refreshFlights();
});
document.getElementById('flightList').addEventListener('click', e=>{
  const pg=e.target.closest('[data-page]'); if(pg){ FL.page=+pg.dataset.page; renderFlights(); return; }
  const b=e.target.closest('[data-flight]'); if(b) openFlight(b.dataset.flight);
});

/* ---------- Zapisane podróże ---------- */
function renderSavedTrips(){
  const trips=FAV.items.filter(f=>f.type==='trip');
  document.getElementById('savedTrips').innerHTML=trips.length ? trips.map(f=>`<div class="saved-trip">
      <div><b>${esc(f.from)} → ${esc(f.to)}</b><div class="small text-soft">${esc(f.name)}${f.detail?' · '+esc(f.detail):''}</div></div>
      <div class="d-flex gap-2"><button class="btn-ghost" type="button" data-fav-open="${esc(favKey(f))}">Otwórz</button><button class="btn-ghost" type="button" data-fav-remove="${esc(favKey(f))}">Usuń</button></div></div>`).join('')
    : '<div class="empty-note">Nie masz jeszcze zapisanych podróży. Wyszukaj trasę i kliknij „Zapisz podróż”.</div>';
}
/* ---------- Ulubione ---------- */
const FAV={items:store('rzbus.favs')||[], user:null};
const FAV_KINDS={ztm:'Autobusy', pks:'PKS', kolej:'Pociągi', podroz:'Podróż'};
// Trasy zapisane przed wspólnym planerem miały widok kategorii, a oznaczają to samo co nowe.
const favKey=f=>[f.type,f.type==='route'?'podroz':f.view,f.id||'',f.name||'',f.from||'',f.to||''].join('|');
function isFavorite(item){ return FAV.items.some(f=>favKey(f)===favKey(item)); }
function starText(on,label){ return (on?'★':'☆')+(label?' '+(on?'Zapisano':label):''); }
function favButton(item,label=''){
  const on=isFavorite(item);
  return `<span class="fav-star ${on?'on':''} ${label?'fav-save':''}" role="button" tabindex="0" data-fav="${esc(JSON.stringify(item))}" data-label="${esc(label)}" aria-pressed="${on}" title="${on?'Usuń z ulubionych':'Dodaj do ulubionych'}">${starText(on,label)}</span>`;
}
function lineFav(r){ return {type:'line', view:r.agency||'ztm', id:r.id, name:r.short}; }
function lineStar(routeId){ return GT.routes.has(routeId) ? favButton(lineFav(GT.routes.get(routeId))) : ''; }
function trainFav(t){ return {type:'line', view:'kolej', id:t.label, name:t.label}; }
function trainStar(t){ return t.label==='Pociąg' ? '' : favButton(trainFav(t)); }
function isFavoriteLine(v){ return FAV.items.some(f=>f.type==='line' && f.id===v.routeId); }
function isFavoriteTrain(t){ return FAV.items.some(f=>f.type==='line' && f.view==='kolej' && f.id===t.label); }
function syncStars(){
  document.querySelectorAll('[data-fav]').forEach(star=>{
    const on=isFavorite(JSON.parse(star.dataset.fav));
    star.classList.toggle('on',on); star.textContent=starText(on,star.dataset.label); star.setAttribute('aria-pressed',String(on)); star.title=on?'Usuń z ulubionych':'Dodaj do ulubionych';
  });
  renderMarkers(); renderTrainsOnMap();
  if(S.filter==='fav') renderLateList();
}
async function saveFavorites(){
  store('rzbus.favs', FAV.items);
  if(!FAV.user) return;
  const r=await fetch('/api/favorites',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({favorites:FAV.items})});
  if(!r.ok) console.warn('Nie zapisano ulubionych', r.status);
}
function toggleFavorite(item){
  const key=favKey(item);
  FAV.items=isFavorite(item) ? FAV.items.filter(f=>favKey(f)!==key) : [...FAV.items, item].slice(-50);
  saveFavorites().catch(e=>console.warn('Nie zapisano ulubionych', e));
  renderFavorites(); syncStars();
}
function renderFavorites(){
  const el=document.getElementById('favBar'), items=FAV.items;
  el.innerHTML=`<span class="fav-title">★ Ulubione</span>`+(items.length
    ? items.map(f=>`<span class="fav-chip"><span class="fav-kind ${f.view}">${FAV_KINDS[f.view]}</span><button class="fav-open" type="button" data-fav-open="${esc(favKey(f))}">${esc(f.type==='route'||f.type==='trip'?f.from+' → '+f.to:f.type==='line'&&f.view!=='kolej'?'Linia '+f.name:f.name)}</button><button class="fav-remove" type="button" data-fav-remove="${esc(favKey(f))}" aria-label="Usuń z ulubionych">×</button></span>`).join('')
    : '<span class="fav-hint">Kliknij ☆ przy linii, przystanku lub trasie, aby zapisać je tutaj.</span>');
  renderSavedTrips();
}
function openFavorite(f){
  const planned=f.type==='route'||f.type==='trip', view=planned?'podroz':f.view;
  if(view!==S.agency) setView(view,true);
  if(f.type==='line'){
    if(f.view!=='kolej'){ if(GT.routes.has(f.id)) openLine(f.id); return; }
    const today=ymdOf(0), train=TR.trains.find(t=>t.label===f.id && t.date===today);
    if(train) openTrain(train.key); else document.getElementById('trains-sec').scrollIntoView({behavior:'instant'});
    return;
  }
  if(planned){
    S.placeChoice={}; plFrom.value=f.from; plTo.value=f.to;
    document.getElementById('planForm').requestSubmit();
    document.getElementById('plan-sec').scrollIntoView({behavior:'instant'});
  } else if(f.view==='kolej'){
    const id=RAIL_IDS.find(i=>RAIL_ST[i][0]===f.name); if(id==null) return;
    TR.station=id; TR.page=null; document.getElementById('trStation').value=String(id); renderBoard();
    document.getElementById('trains-sec').scrollIntoView({behavior:'instant'});
  } else {
    setTimetableStop(f.name);
    document.getElementById('timetable-sec').scrollIntoView({behavior:'instant'});
  }
}
document.addEventListener('click', e=>{
  const star=e.target.closest('[data-fav]'); if(!star) return;
  e.preventDefault(); e.stopPropagation(); // gwiazdka leży w klikalnych wierszach i nie może ich otwierać
  toggleFavorite(JSON.parse(star.dataset.fav));
}, true);
document.addEventListener('keydown', e=>{
  const star=e.target.closest?.('[data-fav]');
  if(star && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); e.stopPropagation(); star.click(); }
}, true);
document.addEventListener('click', e=>{
  const rm=e.target.closest('[data-fav-remove]');
  if(rm){ const f=FAV.items.find(x=>favKey(x)===rm.dataset.favRemove); if(f) toggleFavorite(f); return; }
  const open=e.target.closest('[data-fav-open]');
  if(open){ const f=FAV.items.find(x=>favKey(x)===open.dataset.favOpen); if(f) openFavorite(f); }
});
// Po zalogowaniu ulubione z tej przeglądarki dołączają do tych z konta.
sessionUser.then(async user=>{
  if(!user) return;
  FAV.user=user;
  const r=await fetch('/api/favorites'); if(!r.ok) return;
  const {favorites}=await r.json(), known=new Set(favorites.map(favKey)), local=FAV.items.filter(f=>!known.has(favKey(f)));
  FAV.items=[...favorites, ...local].slice(0,50);
  if(local.length) await saveFavorites(); else store('rzbus.favs', FAV.items);
  renderFavorites();
}).catch(e=>console.warn('Nie wczytano ulubionych', e));

function allStopNames(){ return [...new Set([...[...GT.groups.keys()].filter(n=>GT.groupAgency?.get(n)), ...railStationNames()])]; }

/* ---------- Stronicowanie ---------- */
const TT_PAGE=20, BOARD_PAGE=15;
function paginate(rows, page, size){
  const pages=Math.max(1,Math.ceil(rows.length/size)), current=Math.min(Math.max(page,1),pages);
  return {rows:rows.slice((current-1)*size,current*size), page:current, pages, total:rows.length};
}
function pageOfNow(rows, size, timeOf, now){
  const i=rows.findIndex(r=>timeOf(r)>=now);
  return i<0 ? Math.max(1,Math.ceil(rows.length/size)) : Math.floor(i/size)+1;
}
function pagerHtml(p, withNow){
  if(p.pages<2) return '';
  return `<div class="pager"><button class="btn-ghost" type="button" data-page="${p.page-1}" ${p.page<=1?'disabled':''}>← Poprzednia</button>
    <span class="pager-info">Strona ${p.page} z ${p.pages}</span>
    <button class="btn-ghost" type="button" data-page="${p.page+1}" ${p.page>=p.pages?'disabled':''}>Następna →</button>
    ${withNow?'<button class="btn-ghost" type="button" data-page-now>Teraz</button>':''}</div>`;
}
function planPager(results){
  const P=S.plan, last=results[results.length-1]; P.lastDep=last?last.dep:null;
  if(!last && !P.history.length) return '';
  return `<div class="pager">${P.history.length?'<button class="btn-ghost" type="button" data-plan-page="prev">← Wcześniejsze</button>':''}${last?'<button class="btn-ghost" type="button" data-plan-page="next">Późniejsze →</button>':''}</div>`;
}

/* ---------- Pełny rozkład z przystanku ---------- */
const TT={stop:'', day:0, line:'', page:null};
function timetableRows(){
  const day=dayInfo(TT.day);
  return departuresFrom(TT.stop, day.base, day.base+30*3600, tripInView, [TT.day]);
}
function dayLabel(off){
  const d=dayInfo(off), date=`${d.ymd.slice(6,8)}.${d.ymd.slice(4,6)}`;
  return off===0?`Dziś · ${date}`:off===1?`Jutro · ${date}`:`${['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'][d.wd]} · ${date}`;
}
function renderTimetable(){
  const el=document.getElementById('ttResults'), lineSel=document.getElementById('ttLine');
  if(S.agency==='kolej') return;
  if(!GT.loaded){ el.innerHTML='<div class="empty-note">Rozkład jazdy wczytuje się w tle…</div>'; return; }
  if(!TT.stop){ lineSel.innerHTML='<option value="">Wszystkie linie</option>'; el.innerHTML='<div class="empty-note">Wpisz przystanek, aby zobaczyć wszystkie odjazdy w wybranym dniu.</div>'; return; }
  const all=timetableRows();
  const routes=[...new Set(all.map(d=>d.t.route))].map(routeById).sort((a,b)=>natSort(a.short,b.short));
  if(TT.line && !routes.some(r=>r.id===TT.line)) TT.line='';
  lineSel.innerHTML='<option value="">Wszystkie linie</option>'+routes.map(r=>`<option value="${esc(r.id)}">Linia ${esc(r.short)}</option>`).join('');
  lineSel.value=TT.line;
  const rows=TT.line ? all.filter(d=>d.t.route===TT.line) : all, now=nowSec();
  const head=`<div class="plan-head"><span>${esc(TT.stop)} ${favButton({type:'stop',view:S.agency,name:TT.stop})}</span><span class="text-soft">${esc(dayLabel(TT.day))} · ${rows.length} odjazdów · rozkład planowy</span></div>`;
  if(!rows.length){ el.innerHTML=head+'<div class="empty-note">Brak odjazdów w tym dniu.</div>'; return; }
  const p=paginate(rows, TT.page??(TT.day===0?pageOfNow(rows,TT_PAGE,d=>d.dep,now):1), TT_PAGE);
  el.innerHTML=head+'<div class="board">'+p.rows.map(d=>{ const r=routeById(d.t.route), last=GT.stopGroupOf.get(d.st[d.st.length-1].stop)||'';
    return `<button class="tt-row ${d.dep<now?'tt-past':''}" type="button" data-route="${esc(r.id)}"><b class="tt-time">${fmtClock(d.dep)}</b>
      <span class="leg-line" style="background:${lineColor(r.short,r.color,r.agency)}">${esc(r.short)}</span>
      <span class="tt-dir">→ ${esc(d.t.headsign||last)}</span><small class="text-soft">${TT.day===0&&d.dep>=now?inMin(d.dep):''}</small>${lineStar(d.t.route)}</button>`; }).join('')+'</div>'+pagerHtml(p, TT.day===0);
}
function setTimetableStop(name){ TT.stop=name; TT.page=null; TT.line=''; document.getElementById('ttStop').value=name; store('rzbus.tt.'+S.agency, name); renderTimetable(); }
document.getElementById('ttDay').innerHTML=[0,1,2,3,4,5,6].map(i=>`<option value="${i}">${esc(dayLabel(i))}</option>`).join('');
document.getElementById('ttDay').addEventListener('change', e=>{ TT.day=+e.target.value; TT.page=null; renderTimetable(); });
document.getElementById('ttLine').addEventListener('change', e=>{ TT.line=e.target.value; TT.page=null; renderTimetable(); });
document.getElementById('ttForm').addEventListener('submit', e=>{
  e.preventDefault();
  const err=document.getElementById('ttErr'); err.textContent='';
  if(!GT.loaded) return;
  const n=resolveStop(document.getElementById('ttStop').value);
  if(n) setTimetableStop(n); else err.textContent='Nie znaleziono takiego przystanku.';
});
document.getElementById('ttResults').addEventListener('click', e=>{
  const pg=e.target.closest('[data-page]'); if(pg){ TT.page=+pg.dataset.page; renderTimetable(); return; }
  if(e.target.closest('[data-page-now]')){ TT.page=null; renderTimetable(); return; }
  const b=e.target.closest('[data-route]'); if(b) openLine(b.dataset.route);
});

/* ---------- Podpowiedzi podczas pisania ---------- */
function stopMatches(q){
  const needle=q.toLowerCase(), names=S.agency==='podroz' ? allStopNames() : [...GT.groups.keys()].filter(groupInView);
  return names.filter(n=>n.toLowerCase().includes(needle)).sort((a,b)=>b.toLowerCase().startsWith(needle)-a.toLowerCase().startsWith(needle) || natSort(a,b)).slice(0,5);
}
function setBusy(input, on){
  const box=input.closest('.pl-inp'); let spin=box.querySelector('.pl-spin');
  if(on && !spin){ spin=document.createElement('span'); spin.className='mini-spin pl-spin'; spin.setAttribute('role','status'); spin.setAttribute('aria-label','Szukam adresu…'); spin.title='Szukam adresu…'; input.after(spin); }
  if(!on && spin) spin.remove();
}
function attachSuggest(input, {streets, onPick}){
  const box=document.createElement('ul'); box.className='suggest-list'; box.id=input.id+'List'; box.setAttribute('role','listbox'); box.hidden=true;
  input.closest('.pl-field').appendChild(box);
  input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-controls',box.id); input.setAttribute('aria-expanded','false'); input.autocomplete='off';
  let items=[], active=-1, timer=null, req=0;
  const close=()=>{ clearTimeout(timer); req++; setBusy(input,false); box.hidden=true; active=-1; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); };
  const draw=()=>{
    box.innerHTML=items.map((it,i)=>`<li id="${box.id}-${i}" role="option" aria-selected="${i===active}" class="${i===active?'active':''}" data-i="${i}"><span class="sg-kind">${it.kind}</span>${esc(it.label)}</li>`).join('');
    box.hidden=!items.length; input.setAttribute('aria-expanded', String(!box.hidden));
    if(active>=0) input.setAttribute('aria-activedescendant', box.id+'-'+active); else input.removeAttribute('aria-activedescendant');
  };
  const pick=it=>{ input.value=it.label; close(); if(onPick) onPick(it); };
  const abroad=q=>input.id==='ttStop' ? [] : foreignPlaces().filter(p=>p.label.toLowerCase().includes(q.toLowerCase())).slice(0,4).map(p=>({label:p.label, kind:'lot'}));
  input.addEventListener('input', ()=>{
    clearTimeout(timer); const q=input.value.trim(), my=++req;
    if(q.length<2){ items=[]; close(); return; }
    const local=[...abroad(q), ...stopMatches(q).map(label=>({label, kind:'przystanek'}))];
    items=local; active=-1; draw();
    if(!streets) return;
    setBusy(input,true);
    timer=setTimeout(async()=>{
      try{
        const r=await fetch('/api/streets?q='+encodeURIComponent(q)); if(!r.ok) return;
        const {suggestions}=await r.json();
        if(my!==req) return;
        items=[...suggestions.map(label=>({label, kind:'miejsce'})), ...local.slice(0,3)]; active=-1; draw();
      }catch(e){ console.warn('Podpowiedzi ulic', e); }
      finally{ if(my===req) setBusy(input,false); }
    }, 250);
  });
  input.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ close(); return; }
    if(box.hidden) return;
    if(e.key==='ArrowDown' || e.key==='ArrowUp'){ e.preventDefault(); const n=items.length; active=e.key==='ArrowDown' ? (active+1)%n : (active+n-1+(active<0?1:0))%n; draw(); }
    else if(e.key==='Enter'){ if(active>=0){ e.preventDefault(); pick(items[active]); } else close(); }
  });
  box.addEventListener('mousedown', e=>{ const li=e.target.closest('[data-i]'); if(li){ e.preventDefault(); pick(items[+li.dataset.i]); } });
  input.addEventListener('blur', close);
}

/* ---------- Ulica → najbliższe przystanki ---------- */
function nearbyStops(place, kind){
  const train=kind==='kolej';
  const all=train ? Object.values(RAIL_ST).map(s=>({name:s[0],lat:s[1],lon:s[2]})) : [...GT.groups.values()].filter(g=>groupInView(g.name));
  const near=all.map(g=>({name:g.name, dist:Math.round(Math.min(...place.points.map(p=>hav(p,[g.lat,g.lon]))))})).filter(x=>x.dist<=(train?30000:3000)).sort((a,b)=>a.dist-b.dist);
  if(train) return near.slice(0,3);
  const close=near.filter(x=>x.dist<=800); // przystanki są parami w obu kierunkach, więc najbliższy nie zawsze jedzie tam, gdzie trzeba
  return (close.length>=3 ? close : near.slice(0,3)).slice(0,8);
}
function stopPoint(name){
  const g=GT.groups.get(name); if(g) return [g.lat,g.lon];
  const s=Object.values(RAIL_ST).find(x=>x[0]===name); return s?[s[1],s[2]]:null;
}
function stopPlace(name){ const p=stopPoint(name); return {label:name, names:[name], walk:new Map(), isStop:true, points:p?[p]:[]}; }
function streetPlace(place, approximate){
  const stops=nearbyStops(place);
  return {label:place.label, place, approximate:!!approximate, points:place.points, names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist])), nearest:stops[0]};
}
async function geocodeStreet(q, world){
  const r=await fetch('/api/geocode?q='+encodeURIComponent(q)+(world?'&scope=world':''));
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
// Najpierw Polska, potem reszta świata. „Gdańsk” nie może trafić na przystanek „Gdańska”, stąd sprawdzenie nazwy miasta przed przystankiem.
async function resolvePlace(text, field){
  const q=(text||'').trim(), title=field==='from'?'Skąd':'Dokąd';
  if(!q) return {error:`Wpisz adres, przystanek lub miasto w polu „${title}”.`};
  const exact=allStopNames().find(n=>n.toLowerCase()===q.toLowerCase());
  if(exact) return GT.groups.has(exact) ? stopPlace(exact) : streetPlace({label:exact, points:stopPlace(exact).points});
  const abroad=foreignPlaces().find(p=>p.label.toLowerCase()===q.toLowerCase());
  if(abroad) return streetPlace(abroad);
  const chosen=S.placeChoice[field];
  if(chosen && chosen.q===q) return streetPlace(chosen.place, chosen.approximate);
  const partialStop=()=>{ const n=resolveStop(q)||resolveStation(q); return n?stopPlace(n):null; };
  try{
    const near=await geocodeStreet(q);
    const same=near.places.find(p=>p.label.toLowerCase()===q.toLowerCase()); // sama nazwa miasta: ulica o tej nazwie w innej wsi nie jest wątpliwością
    if(same) return streetPlace(same, near.approximate);
    if(near.places.length===1) return streetPlace(near.places[0], near.approximate);
    if(near.places.length>1) return {choose:near.places, approximate:near.approximate, field, q};
    const top=(await geocodeStreet(q,true)).places[0];
    if(top && top.label.toLowerCase().startsWith(q.toLowerCase())) return streetPlace(top);
    return partialStop() || (top ? streetPlace(top) : {error:`Nie znaleziono miejsca „${q}” (pole „${title}”). Sprawdź pisownię.`});
  }catch(e){
    console.warn('Wyszukiwanie miejsc', e);
    return partialStop() || {error:`Wyszukiwarka adresów jest chwilowo niedostępna. W polu „${title}” wpisz nazwę przystanku.`};
  }
}
function renderPlaceChoice(r){
  S.placeOptions=r;
  document.getElementById('planResults').innerHTML=`<div class="place-choice"><div class="plan-head"><span>„${esc(r.q)}”: której lokalizacji szukasz? (${r.field==='from'?'Skąd':'Dokąd'})</span></div>
    ${r.choose.map((p,i)=>`<button type="button" class="btn-ghost" data-place="${i}">${esc(p.label)}</button>`).join('')}</div>`;
}
let planReq=0;
function tripStart(){
  const today=ymdOf(0), date=plDate.value && plDate.value>today ? plDate.value : '';
  if(!date && !plTime.value) return {at:null, date:''};
  const [h,m]=(plTime.value||'08:00').split(':').map(Number);
  const off=date ? Math.round((Date.parse(date)-Date.parse(today))/86400000) : 0;
  let at=dayInfo(off).base+h*3600+m*60;
  if(!date && at<nowSec()-3600) at+=86400;
  return {at, date};
}
document.getElementById('planForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const err=document.getElementById('planErr'); err.textContent='';
  if(!GT.loaded){ err.textContent='Rozkład jazdy jeszcze się wczytuje — spróbuj za chwilę.'; return; }
  const req=++planReq, go=e.currentTarget.querySelector('.pl-go'), view=S.agency;
  go.disabled=true; document.getElementById('planHint').textContent='Sprawdzam adresy…';
  const round=readReturn(); if(round?.error){ err.textContent=round.error; go.disabled=false; document.getElementById('planHint').textContent=''; return; }
  S.plan=null; document.getElementById('planResults').innerHTML='<div class="empty-note">Szukam połączeń…</div>';
  try{
    setBusy(plFrom,true);
    const origin=await resolvePlace(plFrom.value,'from').finally(()=>setBusy(plFrom,false));
    if(!origin.error && !origin.choose) setBusy(plTo,true);
    const dest=origin.error||origin.choose ? null : await resolvePlace(plTo.value,'to').finally(()=>setBusy(plTo,false));
    if(req!==planReq || view!==S.agency) return;
    const stopped=[origin,dest].find(x=>x && (x.error||x.choose));
    if(stopped){ S.plan=null; document.getElementById('planResults').innerHTML=''; if(stopped.error) err.textContent=stopped.error; else renderPlaceChoice(stopped); return; }
    if(origin.label===dest.label){ err.textContent='Miejsce początkowe i docelowe są takie same.'; return; }
    plFrom.value=origin.label; plTo.value=dest.label;
    for(const [field,p] of [['from',origin],['to',dest]]) if(p.place) S.placeChoice[field]={q:p.label, place:p.place, approximate:p.approximate};
    const a=origin.points[0], b=dest.points[0], km=a&&b?hav(a,b)/1000:null;
    S.plan={from:origin.label, to:dest.label, origin, dest, ...tripStart(), round, km, history:[], flightPage:1, openFlight:null, access:new Map(), carTo:new Map()}; store('rzbus.plan.podroz', {from:origin.label,to:dest.label});
    const P=S.plan;
    if(km!=null && km>=FLIGHT_MIN_KM) loadTripFlights(P);
    drawTripLine(P); runPlan(true);
  }finally{ if(req===planReq){ go.disabled=false; refreshStopList(); } }
});
const [plFrom,plTo,plTime,plDate,plRound,plStay,plBack]=['plFrom','plTo','plTime','plDate','plRound','plStay','plBack'].map(id=>document.getElementById(id));
function earliestReturnDay(start, stay){ return new Date(Date.parse(start+'T12:00:00Z')+(Math.max(stay,1)-1)*86400000).toISOString().slice(0,10); }
function syncReturn(){
  document.querySelectorAll('.trip-return-fields').forEach(e=>{ e.hidden=!plRound.checked; });
  plDate.min=ymdOf(0);
  const first=earliestReturnDay(plDate.value||ymdOf(0), +plStay.value||1);
  plBack.min=first; if(!plBack.value || plBack.value<first) plBack.value=first;
}
function readReturn(){
  if(!plRound.checked) return null;
  const stay=+plStay.value, first=earliestReturnDay(plDate.value||ymdOf(0), stay||1);
  if(!Number.isInteger(stay) || stay<1) return {error:'Podaj liczbę dni na miejscu, co najmniej 1.'};
  if(!plBack.value || plBack.value<first) return {error:`Powrót najwcześniej ${fmtDay(first)}: dzień wyjazdu plus ${stay} dni na miejscu, licząc dzień wyjazdu.`};
  const off=Math.round((Date.parse(plBack.value)-Date.parse(ymdOf(0)))/86400000);
  return {stay, back:plBack.value, at:dayInfo(off).base+8*3600};
}
[plRound,plStay,plDate].forEach(e=>e.addEventListener('change', syncReturn));
plStay.addEventListener('input', syncReturn);
attachSuggest(plFrom, {streets:true});
attachSuggest(plTo, {streets:true});
attachSuggest(document.getElementById('ttStop'), {streets:false, onPick:it=>setTimetableStop(it.label)});
document.getElementById('plSwap').addEventListener('click', ()=>{ const a=plFrom.value; plFrom.value=plTo.value; plTo.value=a; S.placeChoice={from:S.placeChoice.to, to:S.placeChoice.from}; });
document.getElementById('plGeo').addEventListener('click', ()=>{
  const err=document.getElementById('planErr'); err.textContent='';
  if(!GT.loaded){ err.textContent='Rozkład jeszcze się wczytuje.'; return; }
  const places=[...GT.groups.values()].filter(g=>groupInView(g.name));
  const pick=(lat,lon)=>{ let best=null,bd=1e12; for(const g of places){ const d=hav([lat,lon],[g.lat,g.lon]); if(d<bd){bd=d;best=g;} } if(best){ plFrom.value=best.name; err.textContent=`Najbliższy przystanek: ${best.name} (${Math.round(bd)} m)`; } };
  try{ navigator.geolocation.getCurrentPosition(p=>pick(p.coords.latitude,p.coords.longitude), ()=>{ const c=map.getCenter(); pick(c.lat,c.lng); err.textContent+= ' — brak dostępu do lokalizacji, użyto środka mapy.'; }, {timeout:8000}); }
  catch(e){ const c=map.getCenter(); pick(c.lat,c.lng); }
});
document.getElementById('planResults').addEventListener('click', e=>{
  const fl=e.target.closest('[data-flight]'); if(fl){ openFlight(fl.dataset.flight); return; }
  const of=e.target.closest('[data-open-flight]'); if(of){ const P=S.plan; P.openFlight=P.openFlight===of.dataset.openFlight?null:of.dataset.openFlight; runPlan(false); return; }
  const fp=e.target.closest('[data-page]'); if(fp){ S.plan.flightPage=+fp.dataset.page; runPlan(false); return; }
  const tr=e.target.closest('[data-train]'); if(tr){ openTrain(tr.dataset.train); return; }
  const pp=e.target.closest('[data-plan-page]');
  if(pp){ const P=S.plan; if(pp.dataset.planPage==='next'){ P.history.push(P.at); P.at=P.lastDep+60; } else P.at=P.history.pop(); runPlan(false); return; }
  const pl=e.target.closest('[data-place]'); if(pl){ const r=S.placeOptions; S.placeChoice[r.field]={q:r.q, place:r.choose[+pl.dataset.place], approximate:r.approximate}; document.getElementById('planForm').requestSubmit(); return; }
  const b=e.target.closest('[data-bus]'); if(b){ const v=S.vehicles.get(b.dataset.bus); if(v){ document.getElementById('map-sec').scrollIntoView({behavior:'smooth'}); map.setView([v.lat,v.lon],16); openBus(v.id);} return; }
  const s=e.target.closest('[data-show]'); if(!s) return;
  const o=S.planResults[+s.dataset.show]; if(o) showPlanFocus(o);
});


/* ============================================================
   WIDOK TRASY (focus): osobna warstwa z wybranym połączeniem
   ============================================================ */
const LEG_COLORS=['#DA291C','#1E5AA8','#1F7A4D'];
S.focus=null; S.focusLayer=null;
function shapeSlice(tid, i, j){
  const t=GT.trips.get(tid); const st=GT.stopTimes.get(tid);
  const stopPts=st.slice(i,j+1).map(x=>GT.stops.get(x.stop)).filter(Boolean).map(p=>[p.lat,p.lon]);
  const sh=t && t.shape && GT.shapes.get(t.shape);
  if(!sh || sh.length<2 || stopPts.length<2) return stopPts;
  const near=(pt,from)=>{ let bi=from, bd=1e12; for(let k=from;k<sh.length;k++){ const d=hav(pt,sh[k]); if(d<bd){bd=d;bi=k;} } return bi; };
  const a=near(stopPts[0],0), b=near(stopPts[stopPts.length-1],a);
  return b>a ? [stopPts[0], ...sh.slice(a,b+1), stopPts[stopPts.length-1]] : stopPts;
}
function focusLegOf(v){
  if(!S.focus) return null;
  const t=GT.trips.get(v.tripId);
  for(const leg of S.focus.legs){
    if(v.tripId===leg.tid) return {color:leg.color, mine:true, leg};
    if(!t || t.route!==leg.route || dirKey(t)!==leg.dir) continue;
    // tylko autobusy, które jeszcze nie minęły przystanku, na którym wsiadasz
    const st=GT.stopTimes.get(v.tripId)||[]; const k=st.findIndex(x=>GT.stopGroupOf.get(x.stop)===leg.from);
    if(k<0) continue;
    if(v.stopSeq!=null && v.stopSeq>st[k].seq) continue;
    return {color:leg.color, mine:false, leg};
  }
  return null;
}
function showPlanFocus(o){
  clearRouteLayer(); if(S.focusLayer) map.removeLayer(S.focusLayer);
  const layers=[], all=[];
  const legs=o.legs.map((l,k)=>({tid:l.tid, route:l.t.route, dir:dirKey(l.t), from:l.from, to:l.to, short:l.short, head:l.head, color:LEG_COLORS[k%LEG_COLORS.length], l}));
  legs.forEach((g,k)=>{
    const l=g.l; const pts=shapeSlice(l.tid,l.i,l.j); all.push(...pts);
    layers.push(L.polyline(pts,{color:'#fff',weight:11,opacity:.95,interactive:false}), L.polyline(pts,{color:g.color,weight:6,opacity:1,interactive:false}));
    const d=(l.L&&l.L.delay)||0;
    l.st.slice(l.i+1,l.j).forEach(x=>{ const p=GT.stops.get(x.stop); if(!p) return;
      layers.push(L.circleMarker([p.lat,p.lon],{radius:4.5,color:g.color,weight:2.5,fillColor:'#fff',fillOpacity:1}).bindTooltip(`${esc(p.name)} · ${fmtClock(l.base+x.dep+d)}`,{className:'bus-tip',direction:'top'})); });
  });
  // przystanki kluczowe: start (kolor 1. odcinka), przesiadki (kolor kolejnego odcinka), cel
  const keyStop=(p,color,html,cls)=>L.marker([p.lat,p.lon],{icon:L.divIcon({className:'bus-pin-wrap',html:`<div class="key-stop ${cls}" style="--k:${color}"><span class="ks-dot"></span><span class="ks-lbl">${html}</span></div>`,iconSize:[16,16],iconAnchor:[8,8]}), zIndexOffset:3000, interactive:false});
  const l0=legs[0].l, p0=GT.stops.get(l0.st[l0.i].stop);
  if(p0) layers.push(keyStop(p0, legs[0].color, `<b>Start</b> ${esc(l0.from)} · ${fmtClock(l0.predDep)} · linia ${esc(l0.short)}`, 'start'));
  for(let k=1;k<legs.length;k++){ const a=legs[k-1].l, b=legs[k].l; const p=GT.stops.get(b.st[b.i].stop)||GT.stops.get(a.st[a.j].stop);
    if(p) layers.push(keyStop(p, legs[k].color, `<b>Przesiadka</b> ${esc(b.from)} · ${fmtClock(a.predArr)} → ${fmtClock(b.predDep)} · linia ${esc(b.short)}`, 'transfer')); }
  const lz=legs[legs.length-1].l, pz=GT.stops.get(lz.st[lz.j].stop);
  if(pz) layers.push(keyStop(pz, '#181818', `<b>Cel</b> ${esc(lz.to)} · ${fmtClock(lz.predArr)}`, 'end'));
  S.focusLayer=L.layerGroup(layers).addTo(map);
  S.focus={legs, from:l0.from, to:lz.to};
  S.selected=null; S.follow=false;
  renderFocusBar(); renderMarkers(); renderLateList(); renderLineNotice(); renderTrainsOnMap();
  document.getElementById('map-sec').scrollIntoView({behavior:'smooth'});
  for(const v of S.vehicles.values()) if(focusLegOf(v)) all.push([v.lat,v.lon]);
  const padB = Math.min(260, document.getElementById('focusBar').offsetHeight+50);
  if(all.length>1) setTimeout(()=>map.fitBounds(L.latLngBounds(all),{paddingTopLeft:[50,60], paddingBottomRight:[70,padB]}),350);
}
function renderFocusBar(){
  const el=document.getElementById('focusBar');
  if(!S.focus){ el.classList.add('d-none'); document.getElementById('mapWrap').classList.remove('focus-on'); return; }
  const cnt=new Map(); for(const v of S.vehicles.values()){ const f=focusLegOf(v); if(f) cnt.set(f.leg.tid,(cnt.get(f.leg.tid)||0)+1); }
  el.innerHTML = `<div class="fb-title">Twoja trasa: ${esc(S.focus.from)} → ${esc(S.focus.to)}</div>
    <div class="fb-legs">${S.focus.legs.map((g,k)=>`<span class="fb-leg"><i style="background:${g.color}"></i><b>${esc(g.short)}</b> ${esc(g.from)} → ${esc(g.to)} <span class="fb-n">${cnt.get(g.tid)||0} bus.</span></span>`).join('')}</div>
    <button class="fb-reset" id="focusReset">↺ Wszystkie linie</button>`;
  el.classList.remove('d-none'); document.getElementById('mapWrap').classList.add('focus-on');
  document.getElementById('focusReset').onclick=resetFocus;
}
function resetFocus(){
  S.focus=null; setTimeout(renderTrainsOnMap,0); if(S.focusLayer){ map.removeLayer(S.focusLayer); S.focusLayer=null; }
  clearRouteLayer(); S.query=''; document.getElementById('lineSearch').value='';
  renderFocusBar(); renderMarkers(); renderLateList(); renderLineNotice();
  fitView();
}


/* ============================================================
   WYBÓR PRZYSTANKU NA MAPIE (wspólne dla „Skąd” i „Dokąd”)
   ============================================================ */
const pickModalEl=document.getElementById('pickModal'); const pickModal=new bootstrap.Modal(pickModalEl);
const PK={mode:'from', map:null, stops:null, me:null, sel:null, markers:new Map(), routesAt:new Map()};
function routesAtGroup(name){
  const key=S.agency+'|'+name; if(PK.routesAt.has(key)) return PK.routesAt.get(key);
  const g=GT.groups.get(name); const set=new Set();
  if(g) for(const id of g.ids) for(const [tid] of GT.byStop.get(id)||[]){ const t=GT.trips.get(tid); if(t && tripInView(t)) set.add(t.route); }
  const res=[...set].map(routeById).sort((a,b)=>natSort(a.short,b.short)); PK.routesAt.set(key,res); return res;
}
function openPicker(mode){
  const err=document.getElementById('planErr'); err.textContent='';
  if(!GT.loaded){ err.textContent='Rozkład jazdy jeszcze się wczytuje — mapa przystanków będzie dostępna za chwilę.'; return; }
  PK.mode=mode;
  document.getElementById('pickTitle').textContent = mode==='from' ? 'Skąd jedziesz?' : 'Dokąd jedziesz?';
  document.getElementById('pickKicker').textContent = mode==='from' ? 'Przystanek początkowy' : 'Przystanek docelowy';
  document.getElementById('pickHero').style.setProperty('--h2', mode==='from' ? LEG_COLORS[0] : '#181818');
  document.getElementById('pickSearch').value='';
  pickModal.show();
}
document.querySelectorAll('.pl-map').forEach(b=>b.addEventListener('click', ()=>openPicker(b.dataset.pick)));
/* Ten sam podkład co na głównej mapie — także Google Maps (z natężeniem ruchu), jeśli jest wybrany */
PK.base=[]; PK.baseKey=null;
function pickBaseKey(){ return [CFG.tiles, CFG.tiles==='google'?CFG.gkey:'', CFG.traffic, isDark()].join('|'); }
function pickBaseLayer(m){
  const key=pickBaseKey(); if(PK.baseKey===key && PK.base.length) return;
  PK.baseKey=key; for(const l of PK.base) m.removeLayer(l); PK.base=[];
  const addProvider=(provKey)=>{ const prov=TILE_PROVIDERS[provKey]||TILE_PROVIDERS.esri; const defs=(isDark()&&prov.dark)?prov.dark:prov.light;
    defs.forEach((d,i)=>{ const layer=new SmartTiles(d.url,{maxZoom:19, maxNativeZoom:d.maxNative||19, subdomains:d.sub||'abc', attribution:i===0?prov.attr:''}); layer.addTo(m); layer.bringToBack(); PK.base.push(layer); }); };
  if(CFG.tiles==='google' && CFG.gkey && !gmFailed){
    ensureGoogle(CFG.gkey).then(()=>{
      if(PK.baseKey!==key) return;
      const g=L.gridLayer.googleMutant({type:'roadmap', maxZoom:20, styles: isDark()?GM_DARK:[{featureType:'poi',stylers:[{visibility:'off'}]}]});
      g.addTo(m); if(CFG.traffic) g.addGoogleLayer('TrafficLayer'); PK.base.push(g);
    }).catch(()=>{ if(PK.baseKey===key) addProvider('esri'); });
  } else addProvider(CFG.tiles==='google' ? 'esri' : CFG.tiles);
}
function pickStyle(name){
  const isFrom = plFrom.value===name, isTo = plTo.value===name, isSel = PK.sel===name;
  if(isSel) return {radius:10, color:'#fff', weight:3, fillColor: PK.mode==='from'?LEG_COLORS[0]:'#181818', fillOpacity:1};
  if(isFrom) return {radius:8, color:'#fff', weight:2.5, fillColor:LEG_COLORS[0], fillOpacity:1};
  if(isTo) return {radius:8, color:'#fff', weight:2.5, fillColor:'#181818', fillOpacity:1};
  return {radius:5.5, color:'#DA291C', weight:2, fillColor:'#fff', fillOpacity:1};
}
function drawPickStops(){
  if(PK.stops) PK.map.removeLayer(PK.stops); PK.markers.clear();
  const renderer=L.canvas({padding:.3}); const layers=[];
  for(const g of GT.groups.values()){
    if(!groupInView(g.name)) continue;
    const m=L.circleMarker([g.lat,g.lon], Object.assign({renderer}, pickStyle(g.name))).bindTooltip(esc(g.name),{className:'bus-tip',direction:'top',offset:[0,-6]});
    m.on('click', ()=>selectPick(g.name, false)); PK.markers.set(g.name,m); layers.push(m);
  }
  PK.stops=L.layerGroup(layers).addTo(PK.map);
}
function restylePick(){ for(const [n,m] of PK.markers) m.setStyle(pickStyle(n)); const s=PK.sel&&PK.markers.get(PK.sel); if(s) s.bringToFront(); }
function selectPick(name, pan){
  PK.sel=name; restylePick();
  const g=GT.groups.get(name); if(!g) return;
  if(pan) PK.map.setView([g.lat,g.lon], Math.max(PK.map.getZoom(),16));
  const routes=routesAtGroup(name);
  const dist = PK.me ? ` · ${Math.round(hav(PK.me,[g.lat,g.lon]))} m od Ciebie` : '';
  const now=nowSec(); const next=departuresFrom(name, now-60, now+2*3600, tripInView).map(d=>Object.assign(d,{L:liveFor(d.tid,d.st,d.idx,d.base)})).filter(d=>d.L.state!=='passed' && d.L.pred>=now-30).sort((a,b)=>a.L.pred-b.L.pred).slice(0,4);
  document.getElementById('pickInfo').innerHTML = `
    <div class="pi-name">${esc(name)}</div><div class="pi-meta">${routes.length} ${routes.length===1?'linia':'linii'}${dist}</div>
    <div class="pi-lines">${routes.map(r=>`<span class="leg-line" style="background:${lineColor(r.short,r.color,r.agency)}">${esc(r.short)}</span>`).join('')}</div>
    ${next.length?`<div class="pi-next">${next.map(d=>{ const r=routeById(d.t.route); return `<div><b>${fmtClock(d.L.pred)}</b> <span class="leg-line sm" style="background:${lineColor(r.short,r.color,r.agency)}">${esc(r.short)}</span> → ${esc(d.t.headsign||'')} ${d.L.delay!=null&&Math.abs(d.L.delay)>=60?`<span class="txt-red">${fmtDelay(d.L.delay,true)}</span>`:''}</div>`; }).join('')}</div>`:''}
    <div class="pi-actions">
      <button class="btn-grad" data-set="${PK.mode}">${PK.mode==='from'?'Wybierz jako Skąd':'Wybierz jako Dokąd'}</button>
      <button class="btn-ghost" data-set="${PK.mode==='from'?'to':'from'}">${PK.mode==='from'?'Ustaw jako Dokąd':'Ustaw jako Skąd'}</button>
    </div>`;
}
function pickIdle(msg){
  document.getElementById('pickInfo').innerHTML = `<div class="pi-name">Kliknij przystanek na mapie</div><div class="pi-meta">${msg||'Albo wpisz nazwę powyżej lub użyj „Zlokalizuj mnie”.'}</div>
    <div class="pi-legend"><span><i style="background:#fff;border:2px solid #DA291C"></i>przystanek</span><span><i style="background:${LEG_COLORS[0]}"></i>skąd</span><span><i style="background:#181818"></i>dokąd</span><span><i style="background:#1E88E5"></i>Ty</span></div>`;
}
document.getElementById('pickInfo').addEventListener('click', e=>{
  const b=e.target.closest('[data-set]'); if(!b||!PK.sel) return;
  (b.dataset.set==='from'?plFrom:plTo).value=PK.sel; pickModal.hide();
  if(plFrom.value && plTo.value && plFrom.value!==plTo.value) document.getElementById('planForm').requestSubmit();
});
pickModalEl.addEventListener('shown.bs.modal', ()=>{
  if(!PK.map){ PK.map=L.map('pickMap',{zoomControl:true, maxZoom:20}).setView(RZ_CENTER,13); }
  PK.map.invalidateSize(); pickBaseLayer(PK.map); drawPickStops();
  const cur = resolveStop((PK.mode==='from'?plFrom:plTo).value);
  if(cur){ selectPick(cur, true); }
  else { PK.sel=null; restylePick(); pickIdle(); const pts=[...PK.markers.values()].map(m=>m.getLatLng()); if(pts.length) PK.map.fitBounds(L.latLngBounds(pts),{padding:[20,20]}); }
});
document.getElementById('pickSearch').addEventListener('change', e=>{ const n=resolveStop(e.target.value); if(n){ e.target.value=n; selectPick(n,true); } });
document.getElementById('pickSearch').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const n=resolveStop(e.target.value); if(n){ e.target.value=n; selectPick(n,true); } } });
document.getElementById('pickLocate').addEventListener('click', ()=>{
  const btn=document.getElementById('pickLocate'); btn.disabled=true; btn.textContent='◎ Szukam…';
  const done=()=>{ btn.disabled=false; btn.textContent='◎ Zlokalizuj mnie'; };
  const ok=pos=>{ done();
    const me=[pos.coords.latitude,pos.coords.longitude]; PK.me=me;
    if(PK.meLayer) PK.map.removeLayer(PK.meLayer);
    PK.meLayer=L.layerGroup([L.circle(me,{radius:Math.min(pos.coords.accuracy||50,500),color:'#1E88E5',weight:1,fillOpacity:.12}), L.circleMarker(me,{radius:8,color:'#fff',weight:3,fillColor:'#1E88E5',fillOpacity:1}).bindTooltip('Tu jesteś',{className:'bus-tip',permanent:true,direction:'top',offset:[0,-8]})]).addTo(PK.map);
    let best=null,bd=1e12; for(const [n,m] of PK.markers){ const d=hav(me,[m.getLatLng().lat,m.getLatLng().lng]); if(d<bd){bd=d;best=n;} }
    if(best && bd<30000){ selectPick(best,false); const g=GT.groups.get(best); PK.map.fitBounds(L.latLngBounds([me,[g.lat,g.lon]]),{padding:[70,70],maxZoom:17}); }
    else { PK.map.setView(me,15); pickIdle('Jesteś daleko od sieci ZTM Rzeszów — wybierz przystanek ręcznie.'); }
  };
  const fail=err=>{ done(); pickIdle(`Nie udało się ustalić lokalizacji${err&&err.code===1?' (brak zgody przeglądarki)':''}. W podglądzie w aplikacji lokalizacja bywa zablokowana — otwórz plik w przeglądarce albo wybierz przystanek ręcznie.`); };
  try{ if(!navigator.geolocation) return fail(); navigator.geolocation.getCurrentPosition(ok, fail, {enableHighAccuracy:true, timeout:10000, maximumAge:60000}); }catch(e){ fail(e); }
});

/* ---------- Syntetyczny rozkład dla trybu demo ---------- */
function demoBuildGT(){
  if(GT.loaded) return;
  for(const [n,ll] of Object.entries(DEMO_STOPS)) GT.stops.set('demo:'+n,{id:'demo:'+n,name:n,code:'',lat:ll[0],lon:ll[1]});
  for(const [short,color,names,ag] of DEMO_LINES){ const agency=ag||'ztm', rid=(agency==='pks'?'pks:':'')+short; GT.routes.set(rid,{id:rid,short,long:names[0]+' – '+names[names.length-1],color,type:3,agency}); }
  GT.routes.set('8N',{id:'8N',short:'8N',long:'Linia nocna (demo) — kursuje 23:00–4:00',color:'#3c3c3c',type:3,agency:'ztm'});
  const mid=todayMidnight();
  for(const b of DEMO.buses){
    const period=b.dur+360, tot=b.cum[b.cum.length-1];
    const n0=Math.ceil((mid+4.5*3600 - b.phase*period)/period), n1=Math.floor((mid+23.5*3600 - b.phase*period)/period);
    for(let n=n0;n<=n1;n++){ const ts=n*period+b.phase*period; const tid=`DEMO_${b.rid}_${b.id}_${Math.round(ts)}`;
      GT.trips.set(tid,{id:tid,route:b.rid,service:'ALL',headsign:b.names[b.names.length-1],dir:String(b.dir),shape:null,block:b.brigade});
      GT.stopTimes.set(tid, b.names.map((nm,j)=>{ const t=ts-mid + b.cum[j]/tot*b.dur; return {seq:j+1, stop:'demo:'+nm, arr:t, dep:t+(j?20:0)}; })); }
  }
  // linia nocna 8N: tylko w nocy → w dzień „nie kursuje”
  const nn=['Dworzec Główny','Piłsudskiego','Lwowska','Nowe Miasto','Zalesie'];
  for(const [k,startH] of [[0,23.25],[1,24.25],[2,25.25]]){ const tid='DEMO_8N_'+k; GT.trips.set(tid,{id:tid,route:'8N',service:'ALL',headsign:'Zalesie',dir:'0'});
    GT.stopTimes.set(tid, nn.map((n,j)=>({seq:j+1, stop:'demo:'+n, arr:startH*3600+j*240, dep:startH*3600+j*240+20}))); }
  GT.loaded=true; GT.source='demo'; onStaticReady();
}

/* ============================================================
   POCIĄGI — Otwarte Dane Kolejowe PKP PLK (pdp-api.plk-sa.pl)
   ============================================================ */
// ID stacji PLK i współrzędne: PolishTrainsGTFS / OpenStreetMap (CC0). [nazwa, lat, lon, czy w filtrze API]
const RAIL_ST = {
  82669:['Rzeszów Główny',50.04307,22.00595,1], 280247:['Rzeszów Centrum',50.04314,21.99851,1], 82602:['Rzeszów Staroniwa',50.03857,21.98971,1],
  280246:['Rzeszów Politechnika',50.02757,21.98396,1], 82677:['Rzeszów Osiedle',50.02261,21.97775,1], 82735:['Rzeszów Zwięczyca',50.00592,21.95723,1],
  261251:['Rzeszów Zachodni',50.05271,21.99420,1], 280254:['Rzeszów Staromieście',50.06260,21.99238,1], 280257:['Rzeszów Baranówka',50.06438,21.98907,1],
  241561:['Rzeszów Miłocin',50.07556,21.98721,1], 280258:['Rzeszów Dworzysko',50.07792,21.96839,1], 280256:['Rzeszów Pobitno',50.05245,22.03184,1],
  82644:['Rzeszów Załęże',50.05860,22.06966,1], 280420:['Jasionka Lotnisko',50.11555,22.02219,1],
  241560:['Rogoźnica koło Rzeszowa',50.11691,21.96893,0], 280424:['Głogów Małopolski Południowy',50.11349,21.98591,0], 280255:['Głogów Małopolski Niwa',50.13665,21.96475,0],
  82941:['Głogów Małopolski',50.14751,21.95933,0], 82727:['Boguchwała',49.98429,21.93456,0], 280245:['Boguchwała Dolna',49.99442,21.94362,0], 83022:['Łańcut',50.08175,22.22795,0]
};
const RAIL_IDS = Object.keys(RAIL_ST).filter(k=>RAIL_ST[k][3]).map(Number);
const PLK_BASE = 'https://pdp-api.plk-sa.pl';
const TRAIN_ICON = '<i class="fa-solid fa-train" aria-hidden="true"></i>';
const TR = {mode:'off', trains:[], names:new Map(), carriers:new Map(), err:null, ts:null, timer:null, station:82669, tab:'dep', markers:new Map(), stMarkers:[], sel:null, busy:false};
const TRAIN_STATUS = {S:'jeszcze nie wyruszył', P:'w trasie', C:'zakończył bieg', X:'odwołany', Q:'częściowo odwołany'};
function railName(id){ return TR.names.get(+id) || (RAIL_ST[id]&&RAIL_ST[id][0]) || ('stacja '+id); }
function ymdOf(off){ const d=dayInfo(off); return d.ymd.slice(0,4)+'-'+d.ymd.slice(4,6)+'-'+d.ymd.slice(6,8); }
function dateMid(dstr){ const x=String(dstr).slice(0,10).split('-').map(Number); return midnightEpoch(x[0],x[1],x[2]); }
function parseLocalDT(v){
  if(!v) return null; const s=String(v);
  if(/(Z|[+-]\d\d:?\d\d)$/.test(s)) { const t=Date.parse(s); return isNaN(t)?null:t/1000; }
  const m=s.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/); if(!m) return null;
  return midnightEpoch(+m[1],+m[2],+m[3]) + (+m[4])*3600 + (+m[5])*60 + (+(m[6]||0));
}
function dictVal(v){ return v==null ? null : (typeof v==='string' ? v : (v.name||v.nm||v.description||null)); }
async function plkGet(path, params){
  const qs=new URLSearchParams(params||{}).toString();
  const url=PLK_BASE+path+(qs?'?'+qs:'');
  const opts={headers:{'X-API-Key':CFG.plkKey, 'Accept':'application/json'}};
  const tryOne = async u => { const r=await withTimeout(fetch(u, opts), 25000);
    if(r.status===401||r.status===403) { const e=new Error('Klucz API PKP PLK został odrzucony (401/403).'); e.fatal=true; throw e; }
    if(r.status===429) { const e=new Error('Przekroczony limit zapytań PKP PLK — spróbuję ponownie później.'); e.fatal=true; throw e; }
    if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); };
  try{ return await tryOne(url); }
  catch(e){ if(e.fatal) throw e;
    try{ return await tryOne(CFG.proxy==='custom'&&CFG.proxyCustom ? CFG.proxyCustom+encodeURIComponent(url) : '/api/plk'+path.replace('/api/v1','')+(qs?'?'+qs:'')); }
    catch(e2){ if(e2.fatal) throw e2; const er=new Error('Brak połączenia z API PKP PLK (serwer lub sieć blokuje zapytania z przeglądarki).'); throw er; } }
}
async function plkSchedules(){
  const ymd=ymdOf(0), key='rail-'+ymd;
  const cached=await idbGet(key); if(cached && cached.data) return cached.data;
  const data=await plkGet('/api/v1/schedules', {dateFrom:ymdOf(-1), dateTo:ymd, stations:RAIL_IDS.join(','), fullRoute:'true', dictionaries:'true'});
  idbSet(key, {t:Date.now(), data}); return data;
}
function buildTrains(sched, ops){
  const out=[]; const opsBy=new Map();
  if(sched && sched.dictionaries){
    const st=sched.dictionaries.stations||{}; for(const k in st) TR.names.set(+k, dictVal(st[k]) || ('stacja '+k));
    const ca=sched.dictionaries.carriers||{}; for(const k in ca) TR.carriers.set(k, dictVal(ca[k])||k);
  }
  if(ops && ops.stations) for(const k in ops.stations) TR.names.set(+k, dictVal(ops.stations[k]) || railName(k));
  for(const o of (ops&&ops.trains)||[]) opsBy.set(`${o.scheduleId}/${o.orderId}|${String(o.operatingDate).slice(0,10)}`, o);
  const used=new Set();
  const today=ymdOf(0), yest=ymdOf(-1);
  for(const r of (sched&&sched.routes)||[]){
    const dates=(r.operatingDates||[]).map(d=>String(d).slice(0,10));
    for(const date of [yest,today]){
      if(dates.length && !dates.includes(date)) continue;
      const k=`${r.scheduleId}/${r.orderId}|${date}`; const o=opsBy.get(k); used.add(k);
      if(!dates.length && !o) continue;
      const base=dateMid(date);
      const opSt=new Map(); for(const x of (o&&o.stations)||[]) if(!opSt.has(x.stationId)) opSt.set(x.stationId,x);
      const stops=(r.stations||[]).slice().sort((a,b)=>a.orderNumber-b.orderNumber).map(x=>{
        const q=opSt.get(x.stationId)||{};
        return {id:x.stationId, pArr: x.arrivalTime? base+(x.arrivalDay||0)*86400+parseHMS(x.arrivalTime) : parseLocalDT(q.plannedArrival),
          pDep: x.departureTime? base+(x.departureDay||0)*86400+parseHMS(x.departureTime) : parseLocalDT(q.plannedDeparture),
          aArr:parseLocalDT(q.actualArrival), aDep:parseLocalDT(q.actualDeparture), dArr:q.arrivalDelayMinutes??null, dDep:q.departureDelayMinutes??null,
          cf:!!q.isConfirmed, cn:!!q.isCancelled, pl:x.departurePlatform||x.arrivalPlatform||'', tr:x.departureTrack||x.arrivalTrack||''}; });
      out.push(finishTrain({key:k, date, cat:r.commercialCategorySymbol||'', num:r.nationalNumber||'', name:r.name||'', carrier:r.carrierCode||'', status:o?o.trainStatus:null, stops}));
    }
  }
  for(const [k,o] of opsBy){ if(used.has(k)) continue;
    const stops=(o.stations||[]).slice().sort((a,b)=>(a.plannedSequenceNumber||0)-(b.plannedSequenceNumber||0)).map(q=>({id:q.stationId, pArr:parseLocalDT(q.plannedArrival), pDep:parseLocalDT(q.plannedDeparture), aArr:parseLocalDT(q.actualArrival), aDep:parseLocalDT(q.actualDeparture), dArr:q.arrivalDelayMinutes??null, dDep:q.departureDelayMinutes??null, cf:!!q.isConfirmed, cn:!!q.isCancelled, pl:'', tr:''}));
    out.push(finishTrain({key:k, date:String(o.operatingDate).slice(0,10), cat:'', num:String(o.orderId||''), name:'', carrier:'', status:o.trainStatus, stops}));
  }
  return out;
}
function finishTrain(t){
  // propagacja opóźnienia: brak pola przy zerze → 0, gdy pociąg jest w trasie / potwierdzony
  let last=null; const running = t.status==='P'||t.status==='C';
  for(const x of t.stops){
    let own = x.dDep!=null ? x.dDep : x.dArr;
    if(own==null && x.aDep && x.pDep) own=Math.round((x.aDep-x.pDep)/60);
    if(own==null && x.aArr && x.pArr) own=Math.round((x.aArr-x.pArr)/60);
    if(own==null && x.cf) own=0;
    if(own!=null) last=own;
    x.delay = own!=null ? own : (running ? (last??0) : null);
    x.predDep = x.pDep!=null ? (x.aDep || x.pDep + (x.delay||0)*60) : null;
    x.predArr = x.pArr!=null ? (x.aArr || x.pArr + (x.delay||0)*60) : null;
  }
  t.from=t.stops.length?railName(t.stops[0].id):''; t.to=t.stops.length?railName(t.stops[t.stops.length-1].id):'';
  t.label=[t.cat, t.num].filter(Boolean).join(' ') || 'Pociąg';
  t.cancelled = t.status==='X';
  return t;
}
/* ---------- pozycje pociągów na mapie (interpolacja między stacjami) ---------- */
function trainPosition(t){
  if(t.cancelled || t.status==='C') return null;
  const now=nowSec(); const st=t.stops;
  let i=-1; for(let k=0;k<st.length;k++){ const x=st[k]; const left = x.aDep || (x.cf && x.predDep) || (x.predDep && x.predDep<=now ? x.predDep : null); if(left && left<=now) i=k; else if((x.predArr||x.predDep) > now) break; }
  if(i<0){ const a=st[0]; if(a && RAIL_ST[a.id] && a.predDep && a.predDep-now<600 && a.predDep>now-60) return {lat:RAIL_ST[a.id][1], lon:RAIL_ST[a.id][2], at:a.id, next:st[1]&&st[1].id, bearing:null, waiting:true}; return null; }
  const A=st[i], B=st[i+1];
  if(!B) return null;
  const ca=RAIL_ST[A.id], cb=RAIL_ST[B.id];
  const t0=A.aDep || A.predDep, t1=B.aArr || B.predArr || B.predDep;
  if(ca && cb && t0 && t1){ const f=Math.min(1,Math.max(0,(now-t0)/Math.max(60,t1-t0))); return {lat:ca[1]+(cb[1]-ca[1])*f, lon:ca[2]+(cb[2]-ca[2])*f, at:null, next:B.id, bearing:bearingOf([ca[1],ca[2]],[cb[1],cb[2]])}; }
  if(ca && !cb && now-t0<120) return {lat:ca[1], lon:ca[2], at:A.id, next:B.id, bearing:null};
  if(!ca && cb && t1-now<240 && t1-now>-60) return {lat:cb[1], lon:cb[2], at:null, next:B.id, bearing:null, approaching:true};
  return null;
}
function trainDelayNow(t){ let d=null; for(const x of t.stops){ if(x.cf || x.aDep || x.aArr) d=x.delay; } if(d==null){ const n=t.stops.find(x=>x.delay!=null); d=n?n.delay:null; } return d; }
function trainMatches(t){
  const d=trainDelayNow(t), st=statusOf(d==null?null:d*60);
  if(S.filter==='late' && st!=='late') return false;
  if(S.filter==='ontime' && !(st==='ok'||st==='minor'||st==='early')) return false;
  if(S.filter==='fav' && !isFavoriteTrain(t)) return false;
  return !S.query || [t.label,t.name,t.from,t.to].join(' ').toLowerCase().includes(S.query.toLowerCase());
}
function trainsVisible(){ return CFG.trains!==false && !S.focus && (S.agency==='all'||S.agency==='kolej'); }
function renderTrainsOnMap(){
  const show=trainsVisible(); const live=new Set();
  if(show){
    for(const t of TR.trains){
      const pos=trainPosition(t); if(!pos || !trainMatches(t)) continue; live.add(t.key);
      const dmin=trainDelayNow(t); const st=statusOf(dmin==null?null:dmin*60);
      let m=TR.markers.get(t.key);
      const html=`<div class="bus-pin is-train ${st==='late'?'late':''} ${TR.sel===t.key?'sel':''}" style="--c:${STATUS_COLOR[st]};--t:${STATUS_TEXT[st]||'#fff'}"><span class="bus-body">${TRAIN_ICON}${esc(t.cat||'POC')}${isFavoriteTrain(t)?'<i class="pin-star">★</i>':''}</span>${pos.bearing!=null?`<span class="dir" style="transform:rotate(${Math.round(pos.bearing)}deg)"></span>`:''}</div>`;
      if(!m){ m=L.marker([pos.lat,pos.lon],{riseOnHover:true, zIndexOffset:1500}); m.on('click',()=>openTrain(m._tkey)); m.bindTooltip('',{className:'bus-tip',direction:'top',offset:[0,-18]}); TR.markers.set(t.key,m); }
      m._tkey=t.key;
      if(m._html!==html){ m.setIcon(L.divIcon({className:'bus-pin-wrap', html, iconSize:[64,30], iconAnchor:[32,20]})); m._html=html; }
      m.setLatLng([pos.lat,pos.lon]);
      m.setTooltipContent(`<b>${esc(t.label)}</b>${t.name?' „'+esc(t.name)+'”':''} → ${esc(t.to)}<br>${pos.waiting?'czeka na odjazd · ':''}${dmin==null?'brak danych':(Math.abs(dmin)<1?'na czas':(dmin>0?'+':'')+dmin+' min')}${pos.next?' · dalej: '+esc(railName(pos.next)):''}`);
      if(!map.hasLayer(m)) m.addTo(map);
    }
  }
  for(const [k,m] of TR.markers) if(!live.has(k)){ map.removeLayer(m); TR.markers.delete(k); }
  // stacje
  if(!TR.stMarkers.length){
    for(const id of RAIL_IDS){ const [n,lat,lon]=RAIL_ST[id];
      const mk=L.marker([lat,lon],{icon:L.divIcon({className:'bus-pin-wrap',html:`<div class="rail-st" title="${esc(n)}">${TRAIN_ICON}</div>`,iconSize:[20,20],iconAnchor:[10,10]}), zIndexOffset:-500});
      mk.bindTooltip(`<b>${esc(n)}</b><br>stacja kolejowa · kliknij, by zobaczyć odjazdy`,{className:'bus-tip',direction:'top',offset:[0,-10]});
      mk.on('click',()=>{ TR.station=id; TR.page=null; document.getElementById('trStation').value=String(id); renderBoard(); document.getElementById('trains-sec').scrollIntoView({behavior:'smooth'}); });
      TR.stMarkers.push(mk); }
  }
  for(const mk of TR.stMarkers){ if(show){ if(!map.hasLayer(mk)) mk.addTo(map); } else if(map.hasLayer(mk)) map.removeLayer(mk); }
  const lc=document.getElementById('stTrains'); if(lc) lc.textContent = CFG.trains===false ? '—' : String(live.size);
}
/* ---------- tablica odjazdów / przyjazdów ---------- */
function boardRows(stationId, kind){
  const rows=[], mid=todayMidnight();
  for(const t of TR.trains){
    const idx=t.stops.findIndex(x=>x.id===stationId); if(idx<0) continue;
    const x=t.stops[idx];
    if(kind==='dep'){ if(idx===t.stops.length-1 || x.pDep==null) continue; }
    else { if(idx===0 || x.pArr==null) continue; }
    const plan = kind==='dep'?x.pDep:x.pArr, pred = kind==='dep'?x.predDep:x.predArr;
    if(plan<mid || plan>=mid+86400) continue;
    rows.push({t, x, idx, plan, pred, delay:x.delay, cn: x.cn || t.cancelled});
  }
  return rows.sort((a,b)=>a.pred-b.pred);
}
function trainDelayChip(d, cn){
  if(cn) return '<span class="chip late">odwołany</span>';
  if(d==null) return '<span class="chip unknown">wg rozkładu</span>';
  const st=statusOf(d*60); if(Math.abs(d)<1) return '<span class="chip ok">na czas</span>';
  return `<span class="chip ${st}">${d>0?'+':'−'}${Math.abs(d)} min</span>`;
}
function renderBoard(){
  const el=document.getElementById('trainBoard'); const info=document.getElementById('trInfo');
  if(CFG.trains===false){ el.innerHTML='<div class="empty-note">Pociągi są wyłączone w Ustawieniach.</div>'; info.textContent=''; return; }
  const modeTxt = TR.mode==='live' ? `Dane PKP PLK · aktualizacja ${TR.ts?fmtClockS(TR.ts):'—'} · co 2 min` : TR.mode==='demo' ? 'Przykładowe dane (brak klucza PKP PLK lub brak połączenia)' : TR.mode==='loading' ? 'Pobieranie danych PKP PLK…' : '';
  info.innerHTML = favButton({type:'stop',view:'kolej',name:RAIL_ST[TR.station][0]}) + ' ' + esc(modeTxt) + (TR.err?` · <span class="txt-red">${esc(TR.err)}</span>`:'');
  const banner = TR.mode==='demo' ? `<div class="line-notice" style="margin:0 0 12px"><div><span class="ln-badge off">i</span>${CFG.plkKey?'Nie udało się pobrać danych PKP PLK — pokazuję przykładowy rozkład.':'Aby widzieć prawdziwe pociągi i opóźnienia, dodaj bezpłatny klucz <b>Otwarte Dane Kolejowe</b> (pdp-api.plk-sa.pl) w Ustawieniach. Poniżej przykładowe dane.'}</div><button class="ln-link" id="trOpenSettings">Ustawienia →</button></div>` : '';
  const all=boardRows(TR.station, TR.tab), now=nowSec();
  const p=paginate(all, TR.page??pageOfNow(all,BOARD_PAGE,r=>r.pred,now-90), BOARD_PAGE), rows=p.rows;
  if(!rows.length){ el.innerHTML = banner+`<div class="empty-note">Brak ${TR.tab==='dep'?'odjazdów':'przyjazdów'} na dziś${TR.mode==='loading'?' (wczytywanie…)':''}.</div>`; }
  else el.innerHTML = banner + `<div class="board">` + rows.map(r=>{ const t=r.t; const changed = r.delay!=null && Math.abs(r.delay)>=1 && !r.cn;
    return `<button class="board-row ${r.cn?'cancel':''} ${r.pred<now-90?'tt-past':''}" data-train="${esc(t.key)}">
      <span class="br-time"><b class="${changed&&statusOf(r.delay*60)==='late'?'txt-red':''}">${fmtClock(r.pred)}</b>${changed?`<s>${fmtClock(r.plan)}</s>`:''}<small>${inMin(r.pred)}</small></span>
      <span class="br-train"><span class="tr-cat">${esc(t.cat||'POC')}</span> <b>${esc(t.num)}</b>${t.name?` <i>„${esc(t.name)}”</i>`:''} ${trainStar(t)}<small>${esc(TR.carriers.get(t.carrier)||t.carrier||'')}</small></span>
      <span class="br-dir">${TR.tab==='dep'?'→ '+esc(t.to):'z: '+esc(t.from)}<small>${TR.tab==='dep'?'z: '+esc(t.from):'→ '+esc(t.to)}</small></span>
      <span class="br-pl">${r.x.pl?`peron <b>${esc(r.x.pl)}</b>`:''}${r.x.tr?` tor <b>${esc(r.x.tr)}</b>`:''}${!r.x.pl&&!r.x.tr?'<small>peron —</small>':''}</span>
      <span class="br-st">${trainDelayChip(r.delay, r.cn)}<small>${esc(TRAIN_STATUS[t.status]||'')}</small></span>
    </button>`; }).join('') + `</div>` + pagerHtml(p, true);
  const os=document.getElementById('trOpenSettings'); if(os) os.onclick=()=>{ fillSettings(); settingsModal.show(); setTimeout(()=>document.getElementById('sPlk').focus(),400); };
}
document.getElementById('trainBoard').addEventListener('click', e=>{ const pg=e.target.closest('[data-page]'); if(pg){ TR.page=+pg.dataset.page; renderBoard(); return; } if(e.target.closest('[data-page-now]')){ TR.page=null; renderBoard(); return; } const b=e.target.closest('[data-train]'); if(b) openTrain(b.dataset.train); });
document.getElementById('trStation').innerHTML = RAIL_IDS.slice().sort((a,b)=>(b===82669)-(a===82669) || RAIL_ST[a][0].localeCompare(RAIL_ST[b][0],'pl')).map(id=>`<option value="${id}">${esc(RAIL_ST[id][0])}</option>`).join('');
document.getElementById('trStation').value=String(TR.station);
document.getElementById('trStation').addEventListener('change', e=>{ TR.station=+e.target.value; TR.page=null; renderBoard(); });
document.querySelectorAll('[data-trtab]').forEach(b=>b.addEventListener('click', ()=>{ TR.tab=b.dataset.trtab; TR.page=null; document.querySelectorAll('[data-trtab]').forEach(x=>x.classList.toggle('active', x===b)); renderBoard(); }));
/* ---------- połączenia kolejowe (bezpośrednie) ---------- */
function railStationNames(){ const names=new Set(Object.values(RAIL_ST).map(s=>s[0])); for(const t of TR.trains) for(const x of t.stops) names.add(railName(x.id)); return [...names].sort(natSort); }
function resolveStation(txt){
  const q=(txt||'').trim().toLowerCase(); if(!q) return null;
  const names=railStationNames();
  return names.find(n=>n.toLowerCase()===q) || names.filter(n=>n.toLowerCase().startsWith(q)).sort((a,b)=>a.length-b.length)[0] || names.filter(n=>n.toLowerCase().includes(q)).sort((a,b)=>a.length-b.length)[0] || null;
}
function planTrainTrips(from, to, at){
  const out=[];
  for(const t of TR.trains){
    if(t.cancelled) continue;
    const i=t.stops.findIndex(x=>railName(x.id)===from); if(i<0) continue;
    const j=t.stops.findIndex((x,k)=>k>i && railName(x.id)===to); if(j<0) continue;
    const a=t.stops[i], b=t.stops[j]; if(a.cn||b.cn) continue;
    const dep=a.predDep, arr=b.predArr??b.predDep;
    if(dep==null || arr==null || dep<at-60 || dep>at+6*3600) continue;
    out.push({t, a, b, dep, arr});
  }
  return out.sort((x,y)=>x.dep-y.dep).slice(0,7);
}
function planTrainRoutes(origin, dest, at){
  const best=new Map();
  for(const from of origin.names) for(const to of dest.names){
    if(from===to) continue;
    const walkFrom=origin.walk.get(from)||0, walkTo=dest.walk.get(to)||0;
    for(const r of planTrainTrips(from, to, at+walkFrom)){
      const cur=best.get(r.t.key);
      if(!cur || walkFrom+walkTo<cur.walkFrom+cur.walkTo) best.set(r.t.key, Object.assign(r,{from,to,walkFrom,walkTo}));
    }
  }
  return [...best.values()].sort((x,y)=>x.dep-y.dep).slice(0,7);
}
/* ---------- okienko pociągu ---------- */
const trainModalEl=document.getElementById('trainModal'); const trainModal=new bootstrap.Modal(trainModalEl);
function openTrain(key){ TR.sel=key; renderTrain(false); trainModal.show(); renderTrainsOnMap(); }
trainModalEl.addEventListener('hidden.bs.modal', ()=>{ TR.sel=null; renderTrainsOnMap(); });
function renderTrain(soft){
  const t=TR.trains.find(x=>x.key===TR.sel); const hero=document.getElementById('trainHero'), body=document.getElementById('trainBody');
  if(!t){ body.innerHTML='<div class="empty-note">Brak danych o tym pociągu.</div>'; return; }
  const dmin=trainDelayNow(t); const st=t.cancelled?'late':statusOf(dmin==null?null:dmin*60);
  hero.style.setProperty('--h1','#181818'); hero.style.setProperty('--h2',STATUS_COLOR[st]);
  hero.innerHTML=`<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Zamknij"></button>
    <div class="d-flex align-items-center gap-3 pe-4"><div class="big-line" style="font-size:1.5rem">${esc(t.cat||'POC')}</div>
    <div style="min-width:0"><span class="kicker mb-1">${TR.mode==='demo'?'Przykładowe dane · ':''}${esc(TR.carriers.get(t.carrier)||t.carrier||'Pociąg')} · ${esc(TRAIN_STATUS[t.status]||'')}</span>
    <h4>${esc(t.label)}${t.name?' „'+esc(t.name)+'”':''} ${trainStar(t)}</h4><div class="sub">${esc(t.from)} → ${esc(t.to)}</div></div></div>`;
  const now=nowSec(); const pos=trainPosition(t);
  const rows=t.stops.map((x,i)=>{ const passed = (x.aDep&&x.aDep<now) || (x.cf && (x.predDep||x.predArr)<now) ; const cur = pos && (pos.at===x.id || pos.next===x.id);
    const pl=x.pl||x.tr?`<small class="text-soft"> · ${x.pl?'peron '+esc(x.pl):''}${x.tr?' tor '+esc(x.tr):''}</small>`:'';
    const ps=statusOf(x.delay==null?null:x.delay*60);
    return `<li class="${passed?'passed':''} ${cur?'current':''}"><span class="node"></span><span>${esc(railName(x.id))}${pl}${x.cn?' <span class="chip late" style="padding:2px 6px;font-size:.6rem">odwołany</span>':''}</span>
      <span class="times"><div class="plan">plan ${x.pArr?fmtClock(x.pArr):''}${x.pArr&&x.pDep?' / ':''}${x.pDep?fmtClock(x.pDep):''}</div>${x.delay!=null?`<div class="pred ${ps}">${fmtClock(x.predDep||x.predArr)}${Math.abs(x.delay)>=1?` <small>(${x.delay>0?'+':''}${x.delay} min)</small>`:''}${x.cf?' ✓':''}</div>`:''}</span></li>`; }).join('');
  const scroll = soft && document.getElementById('trTl') ? document.getElementById('trTl').scrollTop : null;
  body.innerHTML=`<div class="delay-banner ${st}"><div><div class="big">${t.cancelled?'Odwołany':(dmin==null?'Brak danych o punktualności':(Math.abs(dmin)<1?'Na czas':(dmin>0?'Opóźniony +':'Przed czasem ')+Math.abs(dmin)+' min'))}</div>
    <div class="src">${TR.mode==='live'?'dane PKP PLK (Otwarte Dane Kolejowe) · ✓ = przejazd potwierdzony':'dane przykładowe'}</div></div></div>
    <div class="d-flex justify-content-between align-items-center mb-2"><h5 class="section-title">Trasa pociągu</h5><span class="small text-soft">plan → rzeczywisty / prognoza</span></div>
    <ul class="timeline" id="trTl" style="max-height:52vh">${rows}</ul>`;
  const tl=document.getElementById('trTl'); if(scroll!=null) tl.scrollTop=scroll; else { const c=tl.querySelector('li.current'); if(c) setTimeout(()=>{ tl.scrollTop=Math.max(0,c.offsetTop-tl.offsetTop-80); },250); }
}
/* ---------- dane przykładowe (bez klucza) ---------- */
function demoTrains(){
  const lines=[
    {cat:'R', carrier:'PR', base:'33', name:'', st:[82669,261251,280254,241561,280424,280420], every:30, run:22},
    {cat:'R', carrier:'PR', base:'34', name:'', st:[82669,280247,82602,280246,82677,82735,280245,82727], every:60, run:18},
    {cat:'R', carrier:'PR', base:'35', name:'', st:[82669,280256,82644,83022], every:60, run:20},
    {cat:'R', carrier:'PR', base:'36', name:'', st:[82669,261251,280258,241560,280255,82941], every:60, run:24},
    {cat:'IC', carrier:'IC', base:'38', name:'Demo Express', st:[82669,280256,82644,83022], every:120, run:14}
  ];
  TR.carriers.set('PR','POLREGIO'); TR.carriers.set('IC','PKP Intercity');
  const mid=todayMidnight(); const now=nowSec(); const out=[]; let seed=7;
  const rnd=()=>((seed=(seed*1103515245+12345)>>>0)/4294967296);
  for(const L_ of lines){ for(const dir of [0,1]){ const ids=dir?[...L_.st].reverse():L_.st;
    for(let m=4*60+(dir?13:0)+(L_.every===120?37:0); m<24*60; m+=L_.every){
      const start=mid+m*60; const seg=L_.run*60/(ids.length-1);
      const dl = rnd()<0.6 ? 0 : (rnd()<0.6 ? 1+Math.floor(rnd()*4) : 5+Math.floor(rnd()*20));
      const num=L_.base+String(100+Math.floor(m/ L_.every)*2+dir).slice(-3);
      const stops=ids.map((id,i)=>{ const pArr=i?start+i*seg:null, pDep=i<ids.length-1?start+i*seg+(i?60:0):null; const d=dl;
        const passed=(pDep||pArr)+d*60 < now; return {id, pArr, pDep, aArr:pArr&&passed?pArr+d*60:null, aDep:pDep&&passed?pDep+d*60:null, dArr:passed?d:null, dDep:passed?d:null, cf:passed, cn:false, pl:i===0||i===ids.length-1?String(1+(m%3)):'', tr:i===0?String(2+(m%4)):''}; });
      const first=stops[0].pDep, last=stops[stops.length-1].pArr;
      const status = now<first ? 'S' : (now>last+dl*60 ? 'C' : 'P');
      for(const x of stops) if(status!=='S'){ x.dDep = x.dDep ?? dl; x.dArr = x.dArr ?? dl; }
      out.push(finishTrain({key:`demo-${L_.base}-${dir}-${m}`, date:ymdOf(0), cat:L_.cat, num, name:L_.name, carrier:L_.carrier, status, stops}));
    } } }
  return out;
}
/* ---------- cykl pobierania ---------- */
let trSched=null;
async function trainsTick(){
  if(TR.busy || CFG.trains===false) return; TR.busy=true;
  try{
    if(TR.mode==='demo'){ TR.trains=demoTrains(); TR.ts=nowSec(); }
    else {
      if(!trSched){ try{ trSched=await plkSchedules(); }catch(e){ if(e.fatal) throw e; console.warn('PLK schedules', e); trSched={routes:[]}; } }
      const ops=await plkGet('/api/v1/operations', {stations:RAIL_IDS.join(','), withPlanned:'true', fullRoutes:'true', pageSize:'2000'});
      TR.trains=buildTrains(trSched, ops); TR.ts=nowSec(); TR.mode='live'; TR.err=null;
    }
  }catch(e){
    console.warn('PLK', e); TR.err=e.message;
    if(!TR.trains.length || TR.mode!=='live'){ TR.mode='demo'; TR.trains=demoTrains(); TR.ts=nowSec(); }
  }finally{ TR.busy=false; renderTrainsOnMap(); renderBoard(); if(S.agency==='kolej'){ renderStats(); renderLateList(); refreshStopList(); } if(S.plan) runPlan(false); if(trainModalEl.classList.contains('show')) renderTrain(true); }
}
function trainsBoot(){
  clearInterval(TR.timer); trSched=null; TR.err=null; TR.trains=[];
  if(CFG.trains===false){ TR.mode='off'; renderTrainsOnMap(); renderBoard(); return; }
  TR.mode = CFG.plkKey ? 'loading' : 'demo'; renderBoard();
  trainsTick();
  TR.timer=setInterval(()=>{ if(document.hidden) return; if(TR.mode==='demo') trainsTick(); else trainsTick(); }, CFG.plkKey ? 120000 : 30000);
  // pozycje między pobraniami przesuwamy płynnie co 15 s (interpolacja wg czasu)
  clearInterval(TR.anim); TR.anim=setInterval(()=>{ if(!document.hidden) renderTrainsOnMap(); }, 15000);
}

/* ============================================================
   POGODA — Open-Meteo (bez klucza)
   ============================================================ */
const WX={timer:null, data:null};
const WMO = {0:['Bezchmurnie','☀'],1:['Przeważnie pogodnie','🌤'],2:['Częściowe zachmurzenie','⛅'],3:['Pochmurno','☁'],45:['Mgła','🌫'],48:['Mgła szadziowa','🌫'],
  51:['Słaba mżawka','🌦'],53:['Mżawka','🌦'],55:['Gęsta mżawka','🌧'],56:['Marznąca mżawka','🌧'],57:['Marznąca mżawka','🌧'],61:['Słaby deszcz','🌧'],63:['Deszcz','🌧'],65:['Ulewa','🌧'],
  66:['Marznący deszcz','🌧'],67:['Marznący deszcz','🌧'],71:['Słaby śnieg','🌨'],73:['Śnieg','🌨'],75:['Intensywny śnieg','❄'],77:['Ziarna śniegu','🌨'],
  80:['Przelotny deszcz','🌦'],81:['Przelotne opady','🌧'],82:['Silne przelotne opady','⛈'],85:['Przelotny śnieg','🌨'],86:['Silny przelotny śnieg','❄'],95:['Burza','⛈'],96:['Burza z gradem','⛈'],99:['Burza z gradem','⛈']};
function wmo(c){ return WMO[c] || ['—','·']; }
async function weatherTick(){
  if(CFG.weather===false) return;
  const url='https://api.open-meteo.com/v1/forecast?latitude=50.0412&longitude=21.9991&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&forecast_hours=8&timezone=Europe%2FWarsaw';
  try{ let buf; try{ buf=await fetchTimeout(url, 12000); }catch(e){ buf=await fetchBin(url, 15000); } WX.data=JSON.parse(new TextDecoder().decode(buf)); if(WX.data.error) throw new Error(WX.data.reason||'błąd'); WX.err=null; }
  catch(e){ WX.err='Brak danych pogodowych'; console.warn('weather',e); }
  renderWeather();
}
function renderWeather(){
  const el=document.getElementById('wx'); if(!el) return;
  if(CFG.weather===false){ el.classList.add('d-none'); return; }
  el.classList.remove('d-none');
  const d=WX.data; if(!d||!d.current){ el.innerHTML=`<div class="cd-label">Pogoda w Rzeszowie</div><div class="wx-err">${WX.err?esc(WX.err):'wczytywanie…'}</div>`; return; }
  const c=d.current; const [desc,ico]=wmo(c.weather_code);
  const h=d.hourly||{}; const hrs=(h.time||[]).map((t,i)=>({t, temp:h.temperature_2m[i], pp:h.precipitation_probability?h.precipitation_probability[i]:null, pr:h.precipitation?h.precipitation[i]:0, code:h.weather_code?h.weather_code[i]:null})).slice(1,5);
  const codes=[c.weather_code, ...hrs.map(x=>x.code)];
  const hard = codes.some(k=>[45,48,56,57,66,67,71,73,75,77,85,86,95,96,99,65,82].includes(k)) || c.temperature_2m<=0 && c.precipitation>0;
  const wet = c.precipitation>0.3 || hrs.some(x=>(x.pp||0)>=60);
  const tip = hard ? 'Trudne warunki na drogach — licz się z większymi opóźnieniami.' : wet ? 'Spodziewany deszcz — możliwe niewielkie opóźnienia.' : 'Warunki sprzyjające punktualności.';
  el.innerHTML=`<div class="cd-label">Pogoda w Rzeszowie</div>
    <div class="wx-now"><span class="wx-ico">${ico}</span><span class="wx-temp">${Math.round(c.temperature_2m)}°</span>
      <span class="wx-desc">${esc(desc)}<small>odczuwalna ${Math.round(c.apparent_temperature)}° · wiatr ${Math.round(c.wind_speed_10m)} km/h${c.precipitation?` · opad ${c.precipitation} mm`:''}</small></span></div>
    <div class="wx-hours">${hrs.map(x=>`<span><small>${esc(String(x.t).slice(11,16))}</small>${wmo(x.code)[1]} ${Math.round(x.temp)}°${x.pp!=null?`<small>${x.pp}%</small>`:''}</span>`).join('')}</div>
    <div class="wx-tip ${hard?'hard':wet?'wet':''}">${tip}</div>`;
}
function weatherBoot(){ clearInterval(WX.timer); renderWeather(); if(CFG.weather===false) return; weatherTick(); WX.timer=setInterval(()=>{ if(!document.hidden) weatherTick(); }, 45*60*1000); }

/* ============================================================
   Pętla odświeżania i start
   ============================================================ */
const loaderEl=document.getElementById('mapLoader');
let loaderTimer=null;
function showOverlay(t){ clearTimeout(loaderTimer); loaderEl.classList.remove('hidden'); document.getElementById('loaderText').textContent=t; }
function hideOverlay(){ clearTimeout(loaderTimer); loaderTimer=setTimeout(()=>loaderEl.classList.add('hidden'), 250); }
let kickerMode='loading';
function liveClockText(){
  const age = S.feedTs ? Math.max(0, Math.round(nowSec()-S.feedTs)) : null;
  const ageTxt = age==null ? '' : (age<60 ? ` · dane sprzed ${age} s` : ` · dane sprzed ${Math.floor(age/60)} min`);
  return (kickerMode==='live' ? 'Na żywo · ' : 'Demo · ') + fmtClockS(nowSec()) + ageTxt;
}
setInterval(()=>{ if(kickerMode==='live' || kickerMode==='demo-clock') document.getElementById('liveText').textContent = liveClockText(); }, 1000);
function setKicker(mode, text){
  kickerMode = mode==='live' ? 'live' : (mode==='demo' ? 'demo-clock' : mode);
  if(kickerMode==='live' || kickerMode==='demo-clock') text = liveClockText(); const k=document.getElementById('liveKicker'); k.className='kicker '+(mode==='live'?'':mode); document.getElementById('liveText').textContent=text; }
let timer=null, busy=false, failCount=0;
let nextAt=0;
setInterval(()=>{ const left=Math.max(0,Math.ceil((nextAt-Date.now())/1000)); const m=document.getElementById('cdM'), sEl=document.getElementById('cdS'); if(m){ m.textContent=String(Math.floor(left/60)).padStart(2,'0'); sEl.textContent=String(left%60).padStart(2,'0'); } }, 250);
function restartTimer(){ nextAt=Date.now()+CFG.refresh*1000; clearInterval(timer); timer=setInterval(()=>{ nextAt=Date.now()+CFG.refresh*1000; if(!document.hidden) tick(false); }, CFG.refresh*1000); }
async function tick(manual){
  if(busy) return; busy=true;
  const rb=document.getElementById('refreshBtn'); rb.classList.add('spinning');
  try{
    if(S.mode==='demo'){ demoRefresh(); setKicker('demo','Demo · '+fmtClockS(nowSec())); }
    else {
      await refreshLive(); failCount=0; S.lastOk=nowSec();
      setKicker('live','Na żywo · '+fmtClockS(S.feedTs));
    }
    document.getElementById('updatedLbl').textContent = `Aktualizacja ${fmtClockS(nowSec())} · co ${CFG.refresh} s`;
    renderAll();
  }catch(e){
    failCount++; S.lastErr=e;
    console.warn('Błąd odświeżania', e);
    setKicker('error', 'Brak połączenia ('+failCount+')');
    if(failCount>=3 && S.mode==='live' && S.vehicles.size===0){ S.mode='demo'; demoRefresh(); renderAll(); setKicker('demo','Demo — źródło niedostępne'); }
  }finally{ busy=false; setTimeout(()=>rb.classList.remove('spinning'), 400); }
}
let bootId=0;
async function boot(){
  const my=++bootId;
  clearInterval(timer);
  for(const m of markers.values()) map.removeLayer(m); markers.clear();
  S.vehicles=new Map(); S.tripUpdates=new Map(); S.alerts=[]; renderStats(); renderLateList();
  document.querySelectorAll('.thrLbl').forEach(x=>x.textContent=CFG.threshold);
  if(CFG.demo){ S.mode='demo'; hideOverlay(); await tick(true); drawVectorBase(); restartTimer(); return; }
  S.mode='loading'; setKicker('loading','Łączenie…');
  showOverlay('Łączenie z ZTM Rzeszów…');
  const loadTimetable = () => loadStatic(t=>{ if(my===bootId) showOverlay(t); },()=>{
      if(my!==bootId) return;
      GT.failed=false; S.alerts=S.alerts.filter(a=>a.id!=='nogtfs');
      onStaticReady();
      hideOverlay();
      drawVectorBase();
      if(S.vehicles.size) tick(false); // od razu pokaż linie i kierunki pojazdów już widocznych na mapie
    })
    .catch(e=>{
      console.warn('Brak rozkładu GTFS', e);
      GT.failed=true; S.alerts=S.alerts.filter(a=>a.id!=='nogtfs');
      S.alerts.push({id:'nogtfs', header:'Nie wczytano rozkładu jazdy', desc:'Numery linii, kierunki i nazwy przystanków są niedostępne. Aplikacja spróbuje ponownie za minutę.', routes:[], stops:[]});
      hideOverlay();
      setTimeout(()=>{ if(my===bootId && !GT.loaded) loadTimetable(); }, 60000);
    });
  const staticPromise = loadTimetable();
  let rtOk=false;
  try{ S.mode='live'; await refreshLive(); rtOk=true; S.lastOk=nowSec(); renderAll(); hideOverlay(); setKicker('live','Na żywo · '+fmtClockS(S.feedTs)); }
  catch(e){ console.warn('RT niedostępny', e); }
  if(my!==bootId) return;
  if(!rtOk){
    S.mode='demo'; hideOverlay(); demoRefresh(); renderAll(); drawVectorBase(); setKicker('demo','Demo — brak dostępu do danych na żywo');
    if(!store('rzbus.demoInfoShown')){ store('rzbus.demoInfoShown', true); document.getElementById('alertsBtn').click(); }
    restartTimer();
  } else {
    fitView();
    restartTimer();
  }
  await staticPromise;
  if(my!==bootId) return;
  hideOverlay();
  drawVectorBase();
  await tick(true);
}
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) tick(false); });
setView(viewFromPath(), false);
boot();
trainsBoot();
weatherBoot();
