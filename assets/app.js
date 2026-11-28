"use strict";
const ONW=window.ONWARD||{loginUrl:r=>'/login'+(r?'?returnTo='+encodeURIComponent(r):''), share:async()=>false};
async function initializeUserMenu(){
  let user;
  try{
    const response=await fetch('/api/auth/me');
    if(!response.ok) throw new Error('Nie udało się sprawdzić sesji logowania.');
    ({user}=await response.json());
    store('onward.user', user||null);
  }catch(error){
    // Bez internetu: ostatnio zalogowany użytkownik, żeby zapisane podróże i zmiany czekające na wysłanie zostały na miejscu.
    if(navigator.onLine!==false && !(error instanceof TypeError)) throw error;
    user=store('onward.user')||null;
    document.body.classList.add('offline');
  }
  document.body.classList.toggle('guest', !user);
  document.body.classList.toggle('admin', !!user?.canAdminister);
  if(!user){ document.getElementById('loginLink').href=ONW.loginUrl(location.pathname); return null; }
  document.getElementById('currentUser').textContent=user.displayName||user.email;
  const deleteAccountBtn=document.getElementById('deleteAccountBtn');
  deleteAccountBtn.disabled=true;
  fetch('/api/auth/config')
    .then(async configResponse=>{
      if(!configResponse.ok) throw new Error('Nie udało się sprawdzić konfiguracji poczty.');
      const config=await configResponse.json();
      deleteAccountBtn.disabled=!config.emailEnabled;
      // The Podavo group page (podavo.pl): back to every Podavo app, still signed in (single sign-on through /api/auth/sso/clean).
      const groupItem=document.querySelector('.group-item');
      if(groupItem&&config.groupUrl&&!window.ONWARD?.native) groupItem.hidden=false;
      if(!config.emailEnabled) deleteAccountBtn.title='Usuwanie konta wymaga skonfigurowanej usługi e-mail.';
    })
    .catch(error=>console.error('Błąd konfiguracji usuwania konta',error));
  return user;
}
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  try{ await window.PVPUSH?.disable(false); }catch(e){}
  const response=await fetch('/api/auth/logout',{method:'POST'});
  if(response.ok){ forgetActivity(); store('rzbus.favs', []); store('onward.user', null); store('onward.favsPending', false); try{ await caches?.delete('onward-api'); }catch(e){} location.assign(ONW.loginUrl()); }
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
/* ---------- Konto Podavo: hasło (opcjonalne, wspólne dla aplikacji Podavo) ---------- */
const passwordModal=bootstrap.Modal.getOrCreateInstance(document.getElementById('passwordModal'));
const PW={has:false};
function passwordMessage(text,kind='danger'){ const el=document.getElementById('passwordMessage'); el.textContent=text; el.className=text?`alert alert-${kind} mb-3`:'alert d-none mb-3'; }
async function loadPasswordStatus(){
  const status=document.getElementById('passwordStatus');
  try{
    const r=await fetch('/api/auth/password'); const d=await r.json();
    if(!r.ok) throw new Error(d.error||'');
    PW.has=!!d.hasPassword;
    status.textContent=PW.has?L2(`Masz hasło${d.updatedAt?` (zmienione ${new Date(d.updatedAt).toLocaleDateString('pl-PL')})`:''}. Możesz je zmienić albo usunąć — wtedy logujesz się kodem z e-maila.`,`You have a password${d.updatedAt?` (changed ${new Date(d.updatedAt).toLocaleDateString('en-GB')})`:''}. You can change or remove it — then you sign in with an e-mail code.`)
      :L2('Nie masz hasła — logujesz się kodem z e-maila. Ustaw hasło, jeśli wolisz logować się nim.','You have no password — you sign in with an e-mail code. Set one if you prefer signing in with it.');
  }catch(e){ status.textContent=L2('Nie udało się sprawdzić hasła.','Could not check your password.'); }
  document.getElementById('currentPasswordRow').hidden=!PW.has;
  document.getElementById('removePasswordBtn').hidden=!PW.has;
  document.getElementById('savePasswordBtn').textContent=PW.has?L2('Zmień hasło','Change password'):L2('Ustaw hasło','Set password');
}
document.getElementById('passwordBtn')?.addEventListener('click',()=>{
  passwordMessage(''); for(const id of ['currentPassword','newPasswordApp']) document.getElementById(id).value='';
  document.getElementById('passwordUsername').value=store('onward.user')?.email||'';
  document.getElementById('passwordStatus').textContent=L2('Sprawdzam…','Checking…');
  passwordModal.show(); loadPasswordStatus();
});
async function sendPassword(method, body){
  const r=await fetch('/api/auth/password',{method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||L2('Nie udało się zapisać.','Could not save.')); return d;
}
document.getElementById('passwordFormApp')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=document.getElementById('savePasswordBtn'), password=document.getElementById('newPasswordApp').value;
  if(password.length<8){ passwordMessage(L2('Hasło musi mieć co najmniej 8 znaków.','The password must have at least 8 characters.')); return; }
  btn.disabled=true;
  try{ await sendPassword('PUT',{password, currentPassword:document.getElementById('currentPassword').value||undefined}); await loadPasswordStatus();
    document.getElementById('newPasswordApp').value=''; document.getElementById('currentPassword').value='';
    passwordMessage(L2('Zapisano. Inne urządzenia zostały wylogowane.','Saved. Your other devices were signed out.'),'success'); }
  catch(err){ passwordMessage(err.message); } finally{ btn.disabled=false; }
});
document.getElementById('removePasswordBtn')?.addEventListener('click',async()=>{
  const current=document.getElementById('currentPassword').value;
  if(!current){ passwordMessage(L2('Wpisz obecne hasło, aby je usunąć.','Enter your current password to remove it.')); return; }
  if(!(await askConfirm(L2('Usunąć hasło?','Remove the password?'),{detail:L2('Będziesz logować się kodem z e-maila.','You will sign in with an e-mail code.'), ok:L2('Usuń hasło','Remove password'), danger:true}))) return;
  try{ await sendPassword('DELETE',{currentPassword:current}); await loadPasswordStatus(); document.getElementById('currentPassword').value=''; passwordMessage(L2('Hasło usunięte.','Password removed.'),'success'); }
  catch(err){ passwordMessage(err.message); }
});

/* ---------- Wylogowanie na komputerze po godzinie bez aktywności (czas ustala administrator: idleLogoutMinutes, 0 = wyłączone).
   Tylko na komputerze z myszką, wspólne dla kart: ruch w jednej karcie liczy się dla wszystkich. ---------- */
const IDLE={key:'podavo-voyage-last-activity', warn:2*60000, warned:false, timer:null};
const idleLimit=()=>{ const m=Number(CFG?.idleLogoutMinutes); return Number.isFinite(m)&&m>0 ? m*60000 : 0; };
// Komputer: jakiekolwiek precyzyjne wskazywanie (mysz, touchpad), także na laptopie z ekranem dotykowym.
const idleDesktop=()=>matchMedia('(any-pointer: fine)').matches && matchMedia('(any-hover: hover)').matches && !(window.ONWARD&&window.ONWARD.native);
const lastActivity=()=>{ try{ return +localStorage.getItem(IDLE.key)||0; }catch(e){ return 0; } };
function markActivity(){
  const now=Date.now(), last=lastActivity(), limit=idleLimit();
  // Pierwszy ruch po długiej przerwie (np. po uśpieniu komputera) nie przedłuża sesji, tylko kończy ją.
  if(IDLE.timer && limit && last && now-last>=limit){ idleSignOut(); return; }
  if(now-last>15000){ try{ localStorage.setItem(IDLE.key,String(now)); }catch(e){} } IDLE.warned=false; }
const forgetActivity=()=>{ try{ localStorage.removeItem(IDLE.key); }catch(e){} };
async function idleSignOut(){
  if(IDLE.out) return; IDLE.out=true;
  clearInterval(IDLE.timer);
  forgetActivity(); // inaczej stary znacznik wylogowałby od razu po następnym zalogowaniu
  try{ await window.PVPUSH?.disable(false); }catch(e){}
  try{ await fetch('/api/auth/logout',{method:'POST'}); }catch(e){}
  store('onward.user', null); store('rzbus.favs', []); try{ await caches?.delete('onward-api'); }catch(e){}
  location.assign('/login?powod=bezczynnosc&returnTo='+encodeURIComponent(location.pathname));
}
function checkIdle(){
  const limit=idleLimit(); if(!limit) return;
  const idle=Date.now()-(lastActivity()||Date.now());
  if(idle>=limit){ idleSignOut(); return; }
  if(idle>=limit-IDLE.warn && !IDLE.warned){ IDLE.warned=true; toast(L2('Za 2 minuty wylogujemy Cię z powodu braku aktywności. Rusz myszką, aby zostać.','You will be signed out in 2 minutes for inactivity. Move the mouse to stay.')); }
}
sessionUser.then(user=>{
  if(!user || !idleDesktop()) return;
  if(idleLimit() && lastActivity() && Date.now()-lastActivity()>=idleLimit()){ idleSignOut(); return; } // otwarta ponownie po czasie
  markActivity();
  for(const ev of ['mousemove','mousedown','keydown','wheel','scroll','touchstart']) addEventListener(ev, markActivity, {passive:true});
  // Uśpiony komputer lub karta w tle: sprawdź od razu po powrocie, zanim ruch myszy odnowi znacznik.
  const checkFirst=()=>{ if(document.visibilityState==='visible') checkIdle(); };
  document.addEventListener('visibilitychange', checkFirst, true);
  addEventListener('focus', checkFirst, true);
  IDLE.timer=setInterval(checkIdle, 30000);
});
/* ============================================================
   Konfiguracja
   ============================================================ */
const DEFAULTS = window.VOYAGE_DEFAULTS; // assets/app.defaults.js
const TZ = 'Europe/Warsaw';
const RZ_CENTER = [50.0378, 22.0049];

const OLD_PLK_KEY='rzbus.plk.old';
function store(k, v){ try{ if(v===undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); }catch(e){ return null; } }
// Ustawienia ustala administrator dla wszystkich (/admin, GET /api/settings). Kopia z ostatniej wizyty pozwala wystartować
// od razu i bez internetu; dawne ustawienia z tej przeglądarki już nie obowiązują.
const SHARED_KEY='voyage.shared';
// Klucz PKP PLK z dawnych ustawień czeka osobno, aż administrator zapisze go na serwerze (panel /admin).
{ const saved=store('rzbus.cfg'); if(saved?.plkKey) store(OLD_PLK_KEY, saved.plkKey); try{ localStorage.removeItem('rzbus.cfg'); }catch(e){} }
function settingsFrom(shared){
  const cfg=Object.assign({}, DEFAULTS, shared||{});
  if(cfg.proxy!=='custom') cfg.proxy='auto';
  if(!TILE_KEYS_OK(cfg.tiles)) cfg.tiles='podavo';
  return cfg;
}
let CFG = settingsFrom(store(SHARED_KEY));
function TILE_KEYS_OK(k){ return ['podavo','esri','osm','hot','sat','carto','google'].includes(k); }

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
const ONWARD='/assets/onward/';
const assetPaths={noResults:ONWARD+'illustrations/no-results.svg', tripSaved:ONWARD+'illustrations/trip-saved.svg', readyToGo:ONWARD+'illustrations/ready-to-travel.svg', planATrip:ONWARD+'illustrations/plan-a-trip.svg', noFavourites:ONWARD+'illustrations/no-favourites.svg', noTrips:ONWARD+'illustrations/no-trips.svg', noDepartures:ONWARD+'illustrations/no-departures.svg', emptyTimetable:ONWARD+'illustrations/empty-timetable.svg', journeyPlanned:ONWARD+'illustrations/journey-planned.svg', airportTransfer:ONWARD+'illustrations/airport-transfer.svg', flightConnection:ONWARD+'illustrations/flight-connection.svg', compareRoutes:ONWARD+'illustrations/compare-routes.svg', sun:ONWARD+'icons/sun.svg', cloud:ONWARD+'icons/cloud.svg', partlyCloudy:ONWARD+'weather/partly-cloudy.svg', rain:ONWARD+'weather/rain.svg', snow:ONWARD+'weather/snow.svg', storm:ONWARD+'weather/storm.svg'};
// Ikona pogody według kodu WMO z Open-Meteo: 0 bezchmurnie, 1–2 częściowe zachmurzenie, 3/45/48 chmury i mgła,
// 51–67 i 80–82 deszcz lub mżawka, 71–77 i 85–86 śnieg, 95–99 burza.
function weatherIcon(code){ const c=Number(code); return c===0?assetPaths.sun : c===1||c===2?assetPaths.partlyCloudy : (c>=51&&c<=67)||(c>=80&&c<=82)?assetPaths.rain : (c>=71&&c<=77)||c===85||c===86?assetPaths.snow : c>=95&&c<=99?assetPaths.storm : assetPaths.cloud; }
const stateIll=(src,w=240,h=140)=>`<img class="state-ill" src="${src}" alt="" aria-hidden="true" width="${w}" height="${h}" loading="lazy" decoding="async">`;
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
  const key=urls.join('|'), shared=key===(agency==='pks'?DEFAULTS.pksStaticUrls:DEFAULTS.staticUrls).join('|');
  let buf, url;
  if(shared){ // własne adresy z Ustawień pobieramy bezpośrednio
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
  else if(shared && usable){ buf=cached.buf; url=cached.url+' (starsza kopia)'; }
  else if(shared) throw new Error('Rozkład nie jest jeszcze gotowy na serwerze.');
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
    catch(e){ console.warn('Brak rozkładu PKS', e); GT.sources.pks=null; renderAlertsBtn(); }
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
  filter:'all', query:'', agency:'podroz', planView:{picked:{}, sort:'leave'},
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
const AGENCY_LABEL = {ztm:'ZTM', pks:'Podmiejska', kolej:'Kolej'};
function statusOf(delay){
  if(delay==null) return 'unknown';
  if(delay >= CFG.threshold*60) return 'late';
  if(delay >= 60) return 'minor';
  if(delay <= -60) return 'early';
  return 'ok';
}
const STATUS_COLOR = {late:'#DC5555', minor:'#E9A23B', ok:'#199B70', early:'#2878D0', unknown:'#8F8F8F'};
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
// Domyślne kanały pobiera raz serwer dla wszystkich; własne adresy z Ustawień przeglądarka czyta sama.
function sharedFeed(f){ return f.urls.join('|')===(f.name==='pks'?DEFAULTS.pksRtUrls:DEFAULTS.rtUrls).join('|'); }
function loadFeed(f){
  if(!sharedFeed(f)) return fetchFirst(f.urls, 15000);
  const url='/api/live/'+f.name;
  return fetchTimeout(url, 15000).then(buf=>({buf, url}));
}
function fetchFeed(f){
  const key=f.urls.join('|');
  if(!feedJobs.has(key)) feedJobs.set(key, loadFeed(f)
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
/* Na telefonie mapa nie łapie przewijania strony: jeden palec przewija stronę, a mapę przesuwa się i przybliża dwoma
   palcami (jak w Mapach Google osadzonych na stronach). Dotyczy każdej mapy w aplikacji; myszka działa jak dotąd. */
const TOUCH_MAPS = matchMedia('(hover: none) and (pointer: coarse)').matches;
if(TOUCH_MAPS) L.Map.addInitHook(function(){
  const m=this, el=m.getContainer();
  if(m.dragging) m.dragging.disable();
  el.classList.add('two-finger-map');
  const hint=L.DomUtil.create('div','two-finger-hint', el); hint.setAttribute('aria-hidden','true');
  let timer=null;
  const showHint=()=>{ hint.textContent=document.documentElement.lang==='en'?'Use two fingers to move the map':'Użyj dwóch palców, aby przesunąć mapę';
    el.classList.add('two-finger-show'); clearTimeout(timer); timer=setTimeout(()=>el.classList.remove('two-finger-show'), 1200); };
  const hideHint=()=>{ clearTimeout(timer); el.classList.remove('two-finger-show'); };
  // Dwa palce: przeciąganie włączone (Leaflet przesuwa i przybliża mapę gestem szczypania). Jeden palec: wyłączone, strona się przewija.
  el.addEventListener('touchstart', e=>{ if(e.touches.length>1){ m.dragging?.enable(); hideHint(); } else m.dragging?.disable(); }, {passive:true});
  el.addEventListener('touchmove', e=>{ if(e.touches.length===1 && !el.classList.contains('leaflet-drag-target')) showHint(); else if(e.touches.length>1) hideHint(); }, {passive:true});
  el.addEventListener('touchend', e=>{ if(e.touches.length===0) m.dragging?.disable(); }, {passive:true});
});
const map = L.map('map', {zoomControl:true, preferCanvas:false}).setView(RZ_CENTER, 13);
map.attributionControl.setPrefix(false);
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
    img.onerror=e=>{ TILE.err++; if(TILE.ok===0 && TILE.err>=4 && TILE.mode==='img'){ TILE.mode='blob'; setTimeout(()=>tileLayers.forEach(t=>t.redraw?.()),0); } done(e,img); };
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
    if(!CFG.gkey){ showTileNote('Google Maps z natężeniem ruchu wymaga klucza API, który administrator wpisuje w panelu administratora.'); CFG.tiles='esri'; setTiles(); CFG.tiles='google'; return; }
    document.getElementById('map').classList.remove('dim-tiles');
    ensureGoogle(CFG.gkey).then(()=>{
      if(my!==tilesToken) return;
      const g = L.gridLayer.googleMutant({type:'roadmap', maxZoom:20, styles: isDark()?GM_DARK:[{featureType:'poi',stylers:[{visibility:'off'}]}]});
      g.addTo(map); tileLayers=[g]; tiles=g;
      if(CFG.traffic) g.addGoogleLayer('TrafficLayer');
    }).catch(e=>{ if(my===tilesToken) googleFailed('Nie udało się wczytać Google Maps.'); });
    return;
  }
  // Styl Podavo (jak mapa Podavo Clean, assets/app.mapstyle.js); w ciemnym motywie i przy błędzie — dawny podkład Esri.
  if(CFG.tiles==='podavo' && !isDark()){
    document.getElementById('map').classList.remove('dim-tiles');
    PODAVO_MAP.podavoLayer().then(l=>{ if(my!==tilesToken) return; l.addTo(map); tileLayers=[l]; tiles=l; })
      .catch(()=>{ if(my!==tilesToken) return; CFG.tiles='esri'; setTiles(); CFG.tiles='podavo'; });
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
const NUMBERS_ZOOM = 15; // numery pojazdów pojawiają się dopiero po przybliżeniu mapy
map.on('zoomend', ()=>document.getElementById('map').classList.toggle('show-numbers', map.getZoom()>=NUMBERS_ZOOM));
const markers = new Map();
const PIN_BOX = {className:'bus-pin-wrap', iconSize:[24,24], iconAnchor:[12,12]};
const BUS_ICON = '<i class="fa-solid fa-bus" aria-hidden="true"></i>';
const PKS_ICON = '<i class="fa-solid fa-bus-simple" aria-hidden="true"></i>';
function pinHtml(v, st, sel){
  const lbl = String(v.short).length>4 ? String(v.short).slice(0,4) : v.short;
  const dir = v.bearing!=null ? `<span class="dir" style="transform:rotate(${Math.round(v.bearing)}deg)"></span>` : '';
  return `<div class="bus-pin ${st==='late'?'late':''} ${sel?'sel':''} ${v.agency==='pks'?'is-pks':''}" style="--c:${STATUS_COLOR[st]}"><span class="bus-body">${v.agency==='pks'?PKS_ICON:BUS_ICON}${isFavoriteLine(v)?'<i class="pin-star">★</i>':''}</span>${dir}${v.short==='—'?'':`<span class="pin-num">${esc(lbl)}</span>`}</div>`;
}
function matchesFilter(v){
  if(S.agency!=='all' && (v.agency||'ztm')!==S.agency) return false;
  if(S.lineSet && !S.lineSet.has(v.routeId)) return false;
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
    const key = [st, v.short, isFavoriteLine(v), v.bearing!=null?Math.round(v.bearing/10):'-', sel, show].join('|');
    if(!m){
      m = L.marker([v.lat,v.lon], {icon:L.divIcon({...PIN_BOX, html:pinHtml(v,st,sel)}), riseOnHover:true});
      m.on('click', ()=>openBus(v.id));
      m.bindTooltip('', {className:'bus-tip', direction:'top', offset:[0,-10]});
      markers.set(v.id, m); m._key=null;
    }
    m.setLatLng([v.lat,v.lon]);
    if(m._key!==key){ m.setIcon(L.divIcon({...PIN_BOX, html:pinHtml(v,st,sel)})); m._key=key; }
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
function renderLateList(){
  if(S.agency==='kolej') return;
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
/* Stan źródeł danych: co się nie wczytało, dlaczego, co nadal działa i kiedy ponowimy próbę */
const DH={flights:null};
const hhmm=iso=>{ const d=new Date(iso); return isNaN(d)?'':d.toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'}); };
const isEn=()=>document.documentElement.lang==='en';
const L2=(pl,en)=>isEn()?en:pl;
function dataIssues(){
  const out=[], add=(id,level,title,why,works,retry)=>out.push({id,level,title,why,works,retry});
  const sec=CFG.refresh;
  if(!CFG.demo && S.mode==='demo') add('ztm-live','error',
    L2('Brak pozycji autobusów na żywo','No live bus positions'),
    L2('Serwer nie otrzymał danych na żywo (GTFS-RT) od ZTM Rzeszów — źródło nie odpowiada albo jest chwilowo niedostępne. Mapa pokazuje symulację, a nie prawdziwe autobusy.',
       'The server received no live data (GTFS-RT) from ZTM Rzeszów — the source is not responding or is temporarily unavailable. The map shows a simulation, not real buses.'),
    L2('Rozkład jazdy, lista linii i planowanie podróży działają według rozkładu.','The timetable, line list and trip planning work from the timetable.'),
    L2(`Sprawdzamy ponownie co ${sec} s.`,`We check again every ${sec} s.`));
  else if(feedDown()){ const min=Math.round((nowSec()-S.feedTs)/60); add('ztm-stale','warn',
    L2('ZTM nie przesyła teraz pozycji pojazdów','ZTM is not sending vehicle positions right now'),
    L2(`Ostatnie dane na żywo są sprzed ${min} min. Najczęściej to przerwa po stronie ZTM (np. w nocy albo przy awarii nadajników).`,
       `The latest live data is ${min} min old. This is usually a break on the ZTM side (e.g. at night or when transmitters fail).`),
    L2('Rozkład jazdy i planowanie podróży działają; opóźnienia mogą być nieaktualne.','The timetable and trip planning work; delays may be out of date.'),
    L2('Mapa uzupełni się sama, gdy dane wrócą.','The map fills in by itself when the data returns.')); }
  else if(S.mode==='live' && failCount>0){ const why=S.lastErr?.message?` (${S.lastErr.message})`:''; add('ztm-conn','warn',
    L2('Problem z połączeniem z serwerem','Problem connecting to the server'),
    L2(`${failCount===1?'Ostatnie odświeżenie się nie udało':`Ostatnie ${failCount} odświeżenia się nie udały`}${why}. Może to być chwilowy brak internetu lub restart serwera.`,
       `${failCount===1?'The last refresh failed':`The last ${failCount} refreshes failed`}${why}. This may be a short internet outage or a server restart.`),
    L2('Na mapie zostają ostatnie znane pozycje pojazdów.','The map keeps the last known vehicle positions.'),
    L2(`Ponawiamy co ${sec} s.`,`We retry every ${sec} s.`)); }
  if(GT.failed) add('gtfs','error',
    L2('Nie wczytano rozkładu jazdy ZTM','The ZTM timetable did not load'),
    L2('Pliku rozkładu (GTFS) nie udało się pobrać ani odczytać. Bez niego nie znamy numerów linii, kierunków ani nazw przystanków.',
       'The timetable file (GTFS) could not be downloaded or read. Without it we do not know line numbers, directions or stop names.'),
    L2('Pozycje autobusów na mapie mogą być widoczne, ale bez opisu linii.','Bus positions may show on the map, but without line details.'),
    L2('Spróbujemy ponownie za minutę.','We will try again in a minute.'));
  if(CFG.pks && GT.loaded && Object.hasOwn(GT.sources,'pks') && GT.sources.pks===null) add('pks','error',
    L2('Nie wczytano rozkładu komunikacji podmiejskiej','The suburban bus timetable did not load'),
    L2('Rozkładu PKS (GTFS) nie udało się pobrać — źródło nie odpowiada albo adres w Ustawieniach jest nieaktualny.',
       'The PKS timetable (GTFS) could not be downloaded — the source is not responding or the address in Settings is out of date.'),
    L2('Autobusy miejskie, pociągi i loty działają; linie podmiejskie nie pojawią się w wynikach.','City buses, trains and flights work; suburban lines will not appear in results.'),
    L2('Spróbujemy ponownie przy następnym otwarciu aplikacji.','We will try again the next time the app opens.'));
  if(CFG.trains!==false && TR.mode==='demo'){ const why=TR.err?` (${TR.err})`:''; add('plk','error',
    L2('Brak danych o pociągach (PKP PLK)','No train data (PKP PLK)'),
    L2(`Nie udało się pobrać rozkładu i opóźnień z Otwartych Danych Kolejowych PKP PLK${why}. Tablica odjazdów pokazuje przykładowe pociągi, a nie prawdziwe.`,
       `The timetable and delays could not be loaded from PKP PLK Open Rail Data${why}. The departure board shows sample trains, not real ones.`),
    L2('Autobusy, loty i samochód są nadal planowane; połączenia kolejowe mogą nie być uwzględnione.','Buses, flights and the car are still planned; rail connections may be missing.'),
    L2('Ponawiamy co 5 min.','We retry every 5 min.')); }
  if(FL.failed) add('flights','error',
    L2('Ceny lotów są chwilowo niedostępne','Flight prices are unavailable right now'),
    L2('Serwer nie zwrócił zapisanych lotów — baza danych lub usługa lotów nie odpowiada.','The server returned no stored flights — the database or the flight service is not responding.'),
    L2('Planowanie autobusów, pociągów i samochodu działa normalnie.','Planning buses, trains and the car works normally.'),
    L2('Spróbujemy ponownie przy następnym wyszukiwaniu.','We will try again on the next search.'));
  for(const [key,name] of [['wizz','Wizz Air'],['ryanair','Ryanair']]){
    const st=DH.flights?.[key]; if(!st?.available) continue;
    if(st.pausedUntil) add(key+'-pause','warn',
      L2(`${name}: sprawdzanie aktualnych cen wstrzymane`,`${name}: checking current prices is paused`),
      L2(`${name} poprosił o przerwę w zapytaniach, więc przez godzinę nie pytamy o nowe ceny.`,`${name} asked us to pause requests, so we do not ask for new prices for an hour.`),
      L2('Pokazujemy ceny zapisane wcześniej — przy każdej widać, kiedy była sprawdzona.','We show prices stored earlier — each shows when it was checked.'),
      L2(`Wznowimy około ${hhmm(st.pausedUntil)}.`,`We resume around ${hhmm(st.pausedUntil)}.`));
    else if(st.ok===false && st.error) add(key+'-err','warn',
      L2(`${name}: ostatnie pobranie cen nie powiodło się`,`${name}: the last price update failed`),
      st.error,
      L2('Pokazujemy ceny zapisane wcześniej.','We show prices stored earlier.'),
      L2('Spróbujemy ponownie przy kolejnym sprawdzaniu cen.','We will try again at the next price check.'));
  }
  if(CFG.weather!==false && WX.err) add('weather','info',
    L2('Brak prognozy pogody','No weather forecast'),
    L2('Serwis pogodowy Open-Meteo nie odpowiedział.','The Open-Meteo weather service did not respond.'),
    L2('Wszystko inne działa; brakuje tylko pogody przy podróży.','Everything else works; only the trip weather is missing.'),
    L2('Ponawiamy co 45 min.','We retry every 45 min.'));
  return out;
}
async function loadDataStatus(){
  try{ const r=await fetch('/api/flights/status'); if(r.ok) DH.flights=await r.json(); }catch(e){ console.warn('Stan pobierania lotów', e); }
  renderAlertsBtn();
}
function dataIssueCard(i){
  const icon={error:"fa-circle-exclamation", warn:"fa-triangle-exclamation", info:"fa-circle-info"}[i.level];
  return `<div class="data-issue ${i.level}"><b><i class="fa-solid ${icon}" aria-hidden="true"></i> ${esc(i.title)}</b>
    <div class="mt-1">${esc(i.why)}</div>
    <div class="di-meta"><span><b>${L2("Co działa:","What works:")}</b> ${esc(i.works)}</span><span><b>${L2("Co dalej:","What next:")}</b> ${esc(i.retry)}</span></div></div>`;
}
/* Baner w nagłówku: jedna grafika na stronę (pakiet ON/WARD, page-banners). Strona główna planera zostaje przy ilustracji wybrzeża. */
const PAGE_BANNER={kierunki:'flight-destinations', moje:'my-trips', ulubione:'favourites', trip:'trip-details', rozklad:'timetable'};
function updateBanner(){
  const view=S.agency, sub=S.sub||'';
  const b=PAGE_BANNER[sub] || (view==='ztm'?'city-buses':view==='pks'?'suburban-buses':view==='kolej'?'trains':S.plan?'search-results':'');
  const was=document.body.dataset.banner||'';
  if(b) document.body.dataset.banner=b; else delete document.body.dataset.banner;
  // Planer: po wyszukaniu nagłówek „Wyniki wyszukiwania”, po wyczyszczeniu wraca „Zaplanuj podróż”.
  if(view==='podroz' && !sub && (b==='search-results')!==(was==='search-results')){
    const V=VIEWS.podroz, results=b==='search-results';
    setHeroTitle(results?'Wyniki wyszukiwania':V.title);
    document.getElementById('heroLead').textContent=results?'Porównaj możliwości i wybierz najlepszą podróż.':V.lead;
  }
}
// Opis strony podróży: dokąd i czy to już moja podróż, czy plan z ulubionych.
function tripLead(t){
  const route=`${t.from||''} → ${t.to||''}`;
  return t.status==='booked' ? L2(`${route}: Twoja podróż krok po kroku.`, `${route}: your trip step by step.`)
    : L2(`${route}: plan z ulubionych — zapisz go jako swoją podróż, gdy będzie pewny.`, `${route}: a plan from favourites — save it as your trip once it is certain.`);
}
// Wstęp pod wyszukiwarką, zanim ktoś cokolwiek wyszuka (tekst w atrybucie, bo pokazuje go CSS przy pustych wynikach).
{ const res=document.getElementById('planResults'); if(res) res.dataset.intro=L2('Porównaj połączenia: autobusy, pociągi, loty i samochód w jednym planie.','Compare connections: buses, trains, flights and the car in one plan.'); }
// ALERTS powstaje dalej w pliku; przed jego utworzeniem nie ma osiągniętych alertów.
function reachedAlerts(){ try{ return ALERTS.list.filter(a=>a.reached).length; }catch(e){ return 0; } }
// INBOX powstaje dalej w pliku: zaproszenia do podróży i nieprzeczytane odpowiedzi na moje zaproszenia.
function inboxCount(){ try{ return INBOX.invites.length+INBOX.responses.filter(r=>!inboxSeen().includes(responseKey(r))).length; }catch(e){ return 0; } }
function renderAlertsBtn(){
  const b=document.getElementById('alertsBtn'), issues=dataIssues(), reached=reachedAlerts(), invites=inboxCount(), n=S.alerts.length+issues.length+reached+invites;
  // Dzwonek jest zawsze widoczny; liczba pojawia się tylko, gdy jest coś do przeczytania.
  b.style.display = '';
  document.getElementById('alertsCount').hidden = !n;
  b.classList.toggle('has-data-issue', issues.some(i=>i.level!=='info'));
  b.classList.toggle('has-price-hit', reached>0||invites>0);
  b.title = invites ? L2('Ktoś udostępnił Ci podróż albo odpowiedział na zaproszenie','Someone shared a trip with you or answered an invitation') : reached ? L2('Cena osiągnięta w Twoim alercie cenowym','A price alert reached its price') : issues.length ? L2('Niektóre dane nie zostały wczytane — zobacz szczegóły','Some data did not load — see details') : n ? L2('Komunikaty i utrudnienia','Alerts and disruptions') : L2('Komunikaty — brak nowych','Alerts — nothing new');
  document.getElementById('alertsCount').textContent = n;
  if(document.getElementById('alertsModal')?.classList.contains('show')) fillAlerts();
}
function renderAll(){
  S.byTrip=new Map(); for(const v of S.vehicles.values()) if(v.tripId) S.byTrip.set(v.tripId, v);
  const cf=document.getElementById('cdFoot'); if(cf && S.feedTs) cf.textContent=(S.mode==='demo'?'Symulacja · ':'Ostatni odczyt · ')+fmtClockS(S.feedTs);
  renderMarkers(); renderStats(); renderLateList(); renderAlertsBtn(); renderFeedNotice();
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
      <div style="min-width:0"><span class="kicker mb-1">${S.mode==='demo'?'Symulacja · ':''}${v.agency==='pks'?'Komunikacja podmiejska · linia':'ZTM Rzeszów · linia '+esc(v.short)}</span>
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
map.on('click', ()=>{ if(S.routeLayer){ map.removeLayer(S.routeLayer); S.routeLayer=null; } S.follow=false; S.selected=null; renderMarkers(); });

/* ---------- Potwierdzenie w oknie aplikacji (zamiast systemowego „confirm”) ---------- */
function askConfirm(message, {detail='', ok=L2('Potwierdź','Confirm'), cancel=L2('Anuluj','Cancel'), danger=false}={}){
  return new Promise(resolve=>{
    const back=document.createElement('div'); back.className='ask-layer';
    back.innerHTML=`<div class="ask-box" role="alertdialog" aria-modal="true" aria-labelledby="askTitle"${detail?' aria-describedby="askDetail"':''}>
      <span class="ask-ico ${danger?'danger':''}" aria-hidden="true"><i class="fa-solid fa-${danger?'triangle-exclamation':'circle-question'}"></i></span>
      <h4 id="askTitle">${esc(message)}</h4>${detail?`<p id="askDetail">${esc(detail)}</p>`:''}
      <div class="ask-btns"><button type="button" class="btn-ghost" data-ask="0">${esc(cancel)}</button><button type="button" class="${danger?'btn-danger-soft':'btn-grad'}" data-ask="1">${esc(ok)}</button></div></div>`;
    const before=document.activeElement;
    const done=v=>{ document.removeEventListener('keydown', key, true); back.classList.remove('show'); setTimeout(()=>back.remove(), 160); before?.focus?.({preventScroll:true}); resolve(v); };
    const key=e=>{ if(e.key==='Escape'){ e.stopPropagation(); e.preventDefault(); done(false); }
      else if(e.key==='Tab'){ const b=[...back.querySelectorAll('button')], i=b.indexOf(document.activeElement); e.preventDefault(); b[(i+(e.shiftKey?-1:1)+b.length)%b.length].focus(); } };
    back.addEventListener('click', e=>{ const b=e.target.closest('[data-ask]'); if(b) done(b.dataset.ask==='1'); else if(e.target===back) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back); requestAnimationFrame(()=>back.classList.add('show'));
    back.querySelector(danger?'[data-ask="0"]':'[data-ask="1"]').focus();
  });
}
window.askConfirm=askConfirm;

/* ============================================================
   Modale: komunikaty, ustawienia
   ============================================================ */
const alertsModalEl=document.getElementById('alertsModal');
const alertsModal=new bootstrap.Modal(alertsModalEl);
function fillAlerts(){
  const issues=dataIssues();
  const health = issues.length
    ? `<h5 class="section-title mb-2">${L2('Stan danych','Data status')}</h5>${issues.map(dataIssueCard).join('')}`
    : `<div class="data-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${L2('Wszystkie źródła danych działają.','All data sources are working.')}</div>`;
  const ztm = S.alerts.length ? S.alerts.map(a=>`<div class="alert-card"><b>${esc(a.header||'Komunikat')}</b>
    ${a.routes.length?`<div class="small mt-1">Linie: ${a.routes.map(r=>`<span class="chip unknown me-1" style="padding:3px 8px">${esc((GT.routes.get(r)||{}).short||r)}</span>`).join('')}</div>`:''}
    ${a.desc?`<div class="mt-1" style="white-space:pre-line">${esc(a.desc)}</div>`:''}${a.url?`<div class="mt-1"><a href="${esc(a.url)}" target="_blank" rel="noopener">Więcej</a></div>`:''}</div>`).join('') : '<div class="empty-note">Brak aktywnych komunikatów.</div>';
  document.getElementById('alertsBody').innerHTML = pushBoxHtml() + inboxHtml() + myAlertsHtml() + health + (issues.length||S.alerts.length?`<h5 class="section-title mt-3 mb-2">${L2('Komunikaty ZTM Rzeszów','ZTM Rzeszów notices')}</h5>`:'') + ztm;
}
// Powiadomienia push na tym urządzeniu (assets/app.push.js): przypomnienia o podróżach i osiągnięte alerty cenowe.
const PUSHUI={state:null, busy:false, note:''};
async function refreshPushState(){
  if(!window.PVPUSH || document.body.classList.contains('guest')) return;
  PUSHUI.state=await PVPUSH.state();
  if(alertsModalEl.classList.contains('show')) fillAlerts();
}
function pushBoxHtml(){
  const st=PUSHUI.state;
  if(!window.PVPUSH || document.body.classList.contains('guest') || !st || st==='off-server') return '';
  const notes={
    native:L2('W tej wersji aplikacji ze sklepu powiadomienia push jeszcze nie działają. Otwórz podavo.voyage w Chrome i zainstaluj Podavo z menu przeglądarki („Zainstaluj aplikację”), aby je dostawać.','Push notifications do not work in this store version of the app yet. Open podavo.voyage in Chrome and install Podavo from the browser menu (“Install app”) to get them.'),
    'ios-install':L2('Na iPhonie i iPadzie dodaj Podavo do ekranu początkowego (Udostępnij → „Do ekranu początk.”), otwórz je stamtąd i włącz tu powiadomienia.','On iPhone and iPad, add Podavo to the Home Screen (Share → “Add to Home Screen”), open it from there and turn notifications on here.'),
    unsupported:L2('Ta przeglądarka nie obsługuje powiadomień push.','This browser does not support push notifications.'),
    blocked:L2('Powiadomienia są zablokowane w ustawieniach przeglądarki dla tej strony. Zezwól na nie, a potem włącz je tutaj.','Notifications are blocked for this site in the browser settings. Allow them, then turn them on here.'),
  };
  const head=`<div class="push-head"><i class="fa-solid fa-mobile-screen" aria-hidden="true"></i><div><b>${L2('Powiadomienia na tym urządzeniu','Notifications on this device')}</b><small>${L2('Dzień przed wyjazdem i powrotem oraz gdy alert cenowy osiągnie Twoją cenę.','The day before you leave and return, and when a price alert reaches your price.')}</small></div>${st==='on'?`<span class="push-on">${L2('Włączone','On')}</span>`:''}</div>`;
  const dis=PUSHUI.busy?' disabled':'';
  const acts=st==='on'?`<div class="push-acts"><button type="button" class="btn-ghost" data-push-test${dis}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ${L2('Wyślij testowe','Send a test')}</button><button type="button" class="btn-ghost" data-push-off${dis}>${L2('Wyłącz','Turn off')}</button></div>`
    :st==='off'?`<div class="push-acts"><button type="button" class="btn-grad" data-push-on${dis}><i class="fa-solid fa-bell" aria-hidden="true"></i> ${L2('Włącz powiadomienia','Turn on notifications')}</button></div>`
    :`<p class="push-note">${esc(notes[st]||'')}</p>`;
  return `<section class="push-box" aria-live="polite">${head}${acts}${PUSHUI.note?`<p class="push-note">${esc(PUSHUI.note)}</p>`:''}</section>`;
}
async function pushAction(kind){
  if(PUSHUI.busy) return; PUSHUI.busy=true; PUSHUI.note=''; fillAlerts();
  try{
    if(kind==='on'){
      const ok=await PVPUSH.enable(true);
      const err=PVPUSH.error();
      if(!ok) PUSHUI.note=err==='dismissed'?L2('Nie zezwolono na powiadomienia.','Notifications were not allowed.'):err==='blocked'?'':L2('Nie udało się włączyć powiadomień na tym urządzeniu. Spróbuj ponownie później.','Could not turn on notifications on this device. Try again later.');
    }
    if(kind==='off') await PVPUSH.disable(true);
    if(kind==='test'){
      const r=await PVPUSH.test();
      PUSHUI.note=r.sent?L2(`Wysłano na ${r.sent} ${plural(r.sent,'urządzenie','urządzenia','urządzeń')}.`,`Sent to ${r.sent} device${r.sent===1?'':'s'}.`):L2('Nie udało się wysłać. Wyłącz i włącz powiadomienia ponownie.','Could not send. Turn notifications off and on again.');
    }
  }catch(e){ PUSHUI.note=e.message||L2('Coś poszło nie tak.','Something went wrong.'); }
  PUSHUI.busy=false; PUSHUI.state=await PVPUSH.state(); fillAlerts();
}
// Moje alerty cenowe w panelu komunikatów: najpierw te, w których cena została osiągnięta.
function myAlertsHtml(){
  const title=`<h5 class="section-title mb-2"><i class="fa-solid fa-bell" aria-hidden="true"></i> ${L2('Moje alerty cenowe','My price alerts')}${ALERTS.list.length?` <small>${ALERTS.list.length}</small>`:''}</h5>`;
  if(document.body.classList.contains('guest')) return `<section class="my-alerts">${title}<div class="empty-note">${L2('Zaloguj się, aby ustawiać alerty cenowe.','Sign in to set price alerts.')}</div></section>`;
  if(!ALERTS.loaded) return `<section class="my-alerts">${title}<div class="empty-note"><span class="spin sm" aria-hidden="true"></span> ${L2('Wczytuję alerty…','Loading alerts…')}</div></section>`;
  if(!ALERTS.list.length) return `<section class="my-alerts">${title}<div class="empty-note">${L2('Nie masz alertów cenowych. Ustaw je przyciskiem „Powiadom o cenie” przy locie lub zapisanej podróży.','You have no price alerts. Set one with “Price alert” on a flight or a saved trip.')}</div></section>`;
  const list=[...ALERTS.list].sort((a,b)=>(b.reached?1:0)-(a.reached?1:0)||String(a.day).localeCompare(String(b.day)));
  return `<section class="my-alerts">${title}<div class="my-alerts-list">${list.map(alertCard).join('')}</div>
    <button type="button" class="btn-ghost my-alerts-all" data-alerts-fav><i class="fa-solid fa-star" aria-hidden="true"></i> ${L2('Zobacz w Ulubionych','See in Favourites')}</button></section>`;
}
document.getElementById('alertsBody').addEventListener('click', e=>{
  if(e.target.closest('[data-push-on]')){ pushAction('on'); return; }
  if(e.target.closest('[data-push-off]')){ pushAction('off'); return; }
  if(e.target.closest('[data-push-test]')){ pushAction('test'); return; }
  const inv=e.target.closest('[data-invite-answer]'); if(inv){ answerInvite(inv); return; }
  const op=e.target.closest('[data-inbox-open]'); if(op){ alertsModal.hide(); openTrip(op.dataset.inboxOpen); return; }
  const rm=e.target.closest('[data-alert-remove]'); if(rm){ rm.disabled=true; removeAlert(rm.dataset.alertRemove); return; }
  if(e.target.closest('[data-alerts-fav]')){ alertsModal.hide(); goPage(S.agency, 'ulubione', 'alerts'); }
});
document.getElementById('alertsBtn').addEventListener('click', ()=>{
  fillAlerts(); refreshPushState();
  if(!document.body.classList.contains('guest')) loadInbox().then(()=>{ markResponsesSeen(); fillAlerts(); renderAlertsBtn(); });
  if(!document.body.classList.contains('guest')) loadAlerts();
  loadDataStatus();
  alertsModal.show();
});
/* ---------- Wspólne ustawienia (ustala administrator na /admin, obowiązują wszystkich) ---------- */
const sameList=(a,b)=>(a||[]).join('|')===(b||[]).join('|');
function applySettings(next){
  const prev=CFG;
  const reloadData = !sameList(next.rtUrls,prev.rtUrls) || !sameList(next.staticUrls,prev.staticUrls) || next.proxy!==prev.proxy || next.proxyCustom!==prev.proxyCustom || next.demo!==prev.demo
    || (next.pks!==false)!==(prev.pks!==false) || !sameList(next.pksRtUrls,prev.pksRtUrls) || !sameList(next.pksStaticUrls,prev.pksStaticUrls);
  const trainsChanged=(next.trains!==false)!==(prev.trains!==false), weatherChanged=(next.weather!==false)!==(prev.weather!==false);
  CFG=next;
  if(gmLoadedKey && CFG.gkey!==gmLoadedKey){ location.reload(); return; } // Google Maps wczytuje klucz tylko raz
  setTiles();
  document.querySelectorAll('.thrLbl').forEach(x=>x.textContent=CFG.threshold);
  if(reloadData) boot(); else { restartTimer(); renderAll(); }
  if(trainsChanged && typeof trainsBoot==='function') trainsBoot();
  if(weatherChanged && typeof weatherBoot==='function') weatherBoot();
}
let settingsAsked=0;
async function syncSharedSettings(){
  if(Date.now()-settingsAsked<60000) return; settingsAsked=Date.now();
  let shared;
  try{ const r=await fetch('/api/settings'); if(!r.ok) return; shared=(await r.json()).settings||{}; }
  catch(e){ return; } // bez internetu zostaje kopia z ostatniej wizyty
  if(JSON.stringify(shared)===JSON.stringify(store(SHARED_KEY)||{})) return;
  store(SHARED_KEY, shared);
  try{ applySettings(settingsFrom(shared)); }catch(e){ console.warn('Wspólne ustawienia', e); location.reload(); }
}
// Zmiana administratora dociera do otwartych kart: co 5 minut i po powrocie do karty.
setTimeout(syncSharedSettings, 0);
setInterval(syncSharedSettings, 5*60000);
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') syncSharedSettings(); });

/* ============================================================
   Filtry, motyw, przyciski mapy
   ============================================================ */
/* ---------- Podstrony: autobusy, PKS, pociągi ---------- */
const APP_NAME='podavo.voyage';
const VIEWS={
  podroz:{path:'/plan', tab:'Zaplanuj podróż', title:'Zaplanuj podróż', lead:'Wpisz, skąd i dokąd jedziesz. Porównamy autobusy miejskie i podmiejskie, pociągi, samoloty i samochód.', plan:'Dokąd jedziesz?', map:'Trasa na mapie', search:''},
  ztm:{path:'/buses', tab:'Autobusy', title:'Autobusy miejskie', lead:'Znajdź połączenie autobusem miejskim. Mapę autobusów na żywo otworzysz przyciskiem poniżej, a rozkład z menu.', plan:'Skąd i dokąd autobusem?', search:'Szukaj linii, kierunku lub nr pojazdu…'},
  pks:{path:'/suburban', tab:'Podmiejskie', title:'Komunikacja podmiejska', lead:'Miejscowości, do których jeżdżą autobusy podmiejskie. Kliknij miejscowość, aby zaplanować podróż.', search:'Szukaj linii, kierunku lub nr pojazdu…'},
  kolej:{path:'/trains', tab:'Pociągi', title:'Pociągi w Polsce', lead:'Szukaj połączeń kolejowych w całej Polsce. Rozkład stacji otworzysz z menu „Rozkład jazdy”.', search:'Szukaj pociągu lub kierunku…'}
};
function viewFromPath(){ return Object.keys(VIEWS).find(k=>VIEWS[k].path===location.pathname)||'podroz'; }
// Podstrony: '' (wyszukiwarka), 'rozklad' (rozkład jazdy danej kategorii) i 'ulubione' (osobna strona ulubionych).
const FAV_HASH={ztm:'buses', pks:'suburban', kolej:'trains', podroz:'trips'};
// Adresy sprzed zmiany na angielskie (#rozklad, #podroze…) wciąż działają.
const OLD_HASH={'#rozklad':'#timetable', '#podroze':'#trips', '#autobusy':'#buses', '#pociagi':'#trains', '#pks':'#suburban'};
const pageHash=()=>OLD_HASH[location.hash]||location.hash;
const FAVF={kind:'all'};
// Moje podróże (/my-trips) i strona jednej zapisanej podróży (/trip?id=…).
const TRIPV={id:'', city:false, map:false, sheet:'', back:''};
// Moje podróże mają trzy zakładki: nadchodzące (domyślnie), archiwum minionych (/my-trips#archive) i kalendarz (/my-trips#calendar).
const MYT={tab:'upcoming'};
function pageFromLocation(){
  if(location.pathname==='/destinations') return {view:'podroz', sub:'kierunki', kind:'all'};
  if(location.pathname==='/my-trips'){ MYT.tab=pageHash()==='#archive'?'archive':pageHash()==='#calendar'?'calendar':'upcoming'; return {view:'podroz', sub:'moje', kind:'all'}; }
  if(location.pathname==='/trip'){ TRIPV.id=new URLSearchParams(location.search).get('id')||''; return {view:'podroz', sub:'trip', kind:'all'}; }
  if(location.pathname==='/favourites'){
    const kind=Object.keys(FAV_HASH).find(k=>'#'+FAV_HASH[k]===pageHash())||'all';
    return {view:kind==='all'||kind==='podroz'?'podroz':kind, sub:'ulubione', kind};
  }
  // Links from the welcome page inside the Android/iOS app, where every page is index.html.
  if(location.hash==='#destinations') return {view:'podroz', sub:'kierunki', kind:'all'};
  if(location.hash==='#buses' && location.pathname!=='/favourites') return {view:'ztm', sub:'', kind:'all'};
  const view=viewFromPath();
  return {view, sub:view==='podroz'?'':pageHash()==='#timetable'?'rozklad':pageHash()==='#lines'?'linie':'', kind:'all'};
}
function pageUrl(view, sub, kind){
  if(sub==='ulubione') return '/favourites'+(kind&&kind!=='all'?'#'+FAV_HASH[kind]:'');
  if(sub==='kierunki') return '/destinations';
  if(sub==='moje') return '/my-trips'+(MYT.tab==='archive'?'#archive':MYT.tab==='calendar'?'#calendar':'');
  if(sub==='trip') return '/trip?id='+encodeURIComponent(TRIPV.id);
  return VIEWS[view].path+(sub==='rozklad'?'#timetable':sub==='linie'?'#lines':'');
}
const planKey=view=>'rzbus.plan.'+(view==='ztm'?'ztm':'podroz');
function fitView(){
  const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]);
  if(pts.length) map.fitBounds(L.latLngBounds(pts),{padding:[30,30],maxZoom:14}); else map.setView(RZ_CENTER, S.agency==='kolej'?12:13);
}
function renumberSections(){ let n=0; document.querySelectorAll('.sec-num').forEach(e=>{ if(e.offsetParent) e.textContent=String(++n).padStart(2,'0'); }); }
function setView(view, push, sub='', kind=FAVF.kind){
  const V=VIEWS[view];
  if(sub===true) sub='rozklad'; else if(!sub) sub='';
  FAVF.kind=sub==='ulubione'?kind:'all';
  if(push) history.pushState(null,'',pageUrl(view, sub, FAVF.kind));
  clearRouteLayer(); S.selected=null; S.follow=false; S.lineSet=null;
  S.agency=view; S.query=''; S.plan=null; S.placeChoice={}; planReq++; planBusy();
  document.body.dataset.view=view; map.invalidateSize();
  document.getElementById('heroLead').textContent=V.lead;
  // Na stronie podróży „Skąd?” to zawsze adres (ulica z numerem albo miasto), bez przystanków i miejsc z mapy.
  plFrom.placeholder=view==='podroz'?'Adres lub miasto':'Adres, przystanek, stacja lub miasto';
  document.getElementById('plGeo').title=view==='podroz'?'Mój adres':'Najbliższy przystanek';
  document.getElementById('mapTitle').textContent=V.map||'Mapa na żywo';
  if(V.plan) document.getElementById('planTitle').textContent=V.plan;
  const search=document.getElementById('lineSearch'); search.value=''; search.placeholder=V.search;
  document.getElementById('planResults').innerHTML=''; document.getElementById('planErr').textContent=''; document.getElementById('planHint').textContent='';
  const saved=store(planKey(view)); plFrom.value=saved?.from||''; plTo.value=saved?.to||'';
  refreshStopList();
  TT.stop=store('rzbus.tt.'+view)||''; TT.line=''; TT.page=null; TR.page=null;
  document.getElementById('ttStop').value=TT.stop; document.getElementById('ttErr').textContent='';
  renderTimetable(); renderFeedNotice(); renderFavorites(); syncReturn();
  if(view==='podroz') loadFlights();
  renderMarkers(); renderStats(); renderLateList(); renderLineNotice(); renderLinesGrid(); renderBoard(); renderPksDestinations();
  setMapOpen(false); setSubpage(sub);
  map.invalidateSize(); fitView();
}
// Rozkład jazdy i ulubione otwierają się z menu kategorii w miejscu wyszukiwarki.
const FAV_TITLES={all:'Ulubione', podroz:'Ulubione podróże', ztm:'Ulubione autobusy', pks:'Ulubione podmiejskie', kolej:'Ulubione pociągi'};
/* ---------- Komunikacja: autobusy miejskie, podmiejskie i pociągi pod jedną pozycją menu, z zakładkami na stronie ---------- */
/* Wybór miasta: miasta to miejscowości ze stacjami z rozkładu PKP PLK (z bazy) i z krajowej listy stacji.
   Autobusy miejskie i podmiejskie mamy na razie dla Rzeszowa; pociągi dla każdego miasta. */
const LOCAL_TRANSIT=new Set(['Rzeszów']);
/* Komunikacja miejska innych miast Polski (Warszawa, Kraków, Wrocław, Gdańsk…): lista miast z assets/app.cities.js
   (wczytana przed tym plikiem, więc nagłówek od razu zna miasto), rozkłady, pojazdy na mapie, odjazdy i linie z Transitous. */
const TXC={list:(window.PL_CITIES||[]).map(({id,name,centre,modes,live,operator})=>({id,name,centre,modes,live,operator:operator||''}))};
TXC.byName=new Map(TXC.list.map(c=>[c.name,c]));
const RZ_CITY={id:'rzeszow', name:'Rzeszów', centre:[50.0413,21.9990]};
// „Szukaj połączenia” w Rzeszowie to ta sama strona co w Warszawie i innych miastach (planer Transitous z mapą pojazdów):
// Transitous ma rozkłady i dane na żywo ZTM Rzeszów i PKS Rzeszów, więc planer łączy autobusy miejskie i podmiejskie.
// Rozkład jazdy i Linie zostają na danych GTFS importowanych przez serwer.
const RZ_TX={...RZ_CITY, modes:['bus'], live:true, operator:'ZTM Rzeszów · PKS Rzeszów'};
const searchTxCity=()=>txCity()||(LOCAL_TRANSIT.has(TCITY.name)?RZ_TX:null);
const txCity=(name=TCITY.name)=>LOCAL_TRANSIT.has(name)?null:TXC.byName.get(name)||null;
const TX_MODE_NAMES={metro:['metro','metro'], tram:['tramwaje','trams'], bus:['autobusy','buses'], trolleybus:['trolejbusy','trolleybuses'], rail:['SKM','city rail']};
const txModes=c=>c.modes.map(m=>L2(...(TX_MODE_NAMES[m]||[m,m]))).join(' · ');
const TCITY={name:store('onward.city')||'Rzeszów', list:null, size:0, open:false, q:'', applied:false};
// Miasta ze stacjami: ta sama zasada co w wyszukiwarce pociągów (railCities: co najmniej dwie stacje i własna stacja główna),
// a stacja miasta to jego stacja główna (routeStations), np. Kraków → Kraków Główny.
function cityList(){
  const names=railStationNames(), cities=railCities();
  if(TCITY.list && TCITY.size===names.length) return TCITY.list;
  // Stacje miasta: nazwa równa miastu albo zaczynająca się od „miasto ”. Jedno przejście po stacjach zamiast filtra dla każdego miasta.
  const own=new Map(cities.map(c=>[c,[]]));
  for(const n of names){ for(let i=n.indexOf(' '); i>0; i=n.indexOf(' ',i+1)) own.get(n.slice(0,i))?.push(n); own.get(n)?.push(n); }
  TCITY.list=cities.map(city=>{ const st=own.get(city); return {city, main:routeStations(st).sort((a,b)=>a.length-b.length)[0]||city, stations:st.length}; }).sort((a,b)=>PL_COLLATOR.compare(a.city,b.city));
  TCITY.size=names.length; return TCITY.list;
}
function stationIdOf(name){
  for(const [id,n] of TR.names) if(n===name) return +id;
  for(const [id,n] of RAIL_NAMES) if(n===name) return +id;
  const e=Object.entries(RAIL_ST).find(([,s])=>s[0]===name); return e?+e[0]:null;
}
function cityPickerHtml(){
  const fold=s=>s.toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l');
  let list='';
  if(TCITY.open){
    const all=cityList(), q=fold(TCITY.q.trim()), match=n=>!q||fold(n).includes(q), rank=n=>q&&fold(n).startsWith(q)?0:1;
    const rail=new Map(all.map(c=>[c.city,c]));
    // Najpierw miasta z komunikacją miejską (Rzeszów i miasta z Transitous), potem miejscowości tylko ze stacjami.
    const withCity=[...LOCAL_TRANSIT, ...TXC.list.map(c=>c.name)].filter(match).sort((a,b)=>rank(a)-rank(b));
    const others=(q?all.filter(c=>fold(c.city).startsWith(q)).concat(all.filter(c=>!fold(c.city).startsWith(q)&&fold(c.city).includes(q))):all.filter(c=>c.stations>=3)).filter(c=>!LOCAL_TRANSIT.has(c.city)&&!TXC.byName.has(c.city)).slice(0,60);
    const sub=c=>{ const tx=txCity(c.city);
      if(LOCAL_TRANSIT.has(c.city)) return L2('autobusy · podmiejskie · pociągi','buses · suburban · trains');
      if(tx) return `${txModes(tx)}${c.stations?` · ${L2('pociągi','trains')}`:''}${tx.live?` · <span class="tx-live-dot">${L2('na żywo','live')}</span>`:''}`;
      return L2(`pociągi · ${c.stations} ${c.stations===1?'stacja':c.stations<5?'stacje':'stacji'}`,`trains · ${c.stations} ${c.stations===1?'station':'stations'}`); };
    const row=c=>`<li><button type="button" role="option" data-city-pick="${esc(c.city)}" aria-selected="${c.city===TCITY.name}" class="${c.city===TCITY.name?'on':''}"><b>${esc(c.city)}</b><small>${sub(c)}</small></button></li>`;
    const head=t=>`<li class="tx-city-head" role="presentation">${t}</li>`;
    const top=withCity.map(n=>rail.get(n)||{city:n, main:n==='Rzeszów'?'Rzeszów Główny':n, stations:0});
    list=`<div class="tx-city-scrim" data-city-close aria-hidden="true"></div><div class="tx-city-pop" role="dialog" aria-label="${L2('Wybierz miasto','Choose a city')}"><div class="ios-sheet-head"><span class="ios-grab" aria-hidden="true"></span><b>${L2('Wybierz miasto','Choose a city')}</b><button type="button" class="ios-done" data-city-close>${L2('Gotowe','Done')}</button></div><input type="search" id="cityQuery" value="${esc(TCITY.q)}" placeholder="${L2('Szukaj miasta…','Search a city…')}" autocomplete="off">
      <ul role="listbox">${top.length?head(L2('Komunikacja miejska i pociągi','City transport and trains'))+top.map(row).join(''):''}${others.length?head(L2('Pociągi','Trains'))+others.map(row).join(''):''}${top.length||others.length?'':`<li class="tx-city-none">${L2('Brak miasta o tej nazwie.','No city of that name.')}</li>`}</ul>
      <small class="tx-city-note">${L2(`Komunikacja miejska w ${TXC.list.length+LOCAL_TRANSIT.size} miastach · pociągi w ${all.length} miejscowościach ze stacjami.`,`City transport in ${TXC.list.length+LOCAL_TRANSIT.size} cities · trains in ${all.length} towns with stations.`)}</small></div>`;
  }
  return `<div class="tx-city"><button type="button" class="tx-city-btn" data-city-open aria-haspopup="dialog" aria-expanded="${TCITY.open}"><i class="fa-solid fa-city" aria-hidden="true"></i> <span>${L2('Miasto','City')}:</span> <b>${esc(TCITY.name)}</b> <i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>${list}</div>`;
}
function toggleCityPicker(open=!TCITY.open){
  TCITY.open=open; if(open) TCITY.q='';
  // pełna lista stacji w Polsce przychodzi przy pierwszym otwarciu (na stronie autobusów nie jest jeszcze potrzebna)
  if(open && !RAIL_NAMES.size){ if(!railStationsLoading) railStationsLoading=loadRailStations(); railStationsLoading.then(()=>{ TCITY.list=null; if(TCITY.open) renderTransitTabs(TRANSIT.includes(S.agency)?S.agency:'ztm'); }); }
  renderTransitTabs(TRANSIT.includes(S.agency)?S.agency:'ztm');
  if(open) setTimeout(()=>document.getElementById('cityQuery')?.focus(),20);
}
// Stacje wybranego miasta (nazwa miasta albo „Miasto Coś”), główna pierwsza, np. Warszawa Centralna, Wschodnia, Zachodnia…
function cityStations(name){
  const c=cityList().find(x=>x.city===name), main=c?.main||name;
  const names=railStationNames().filter(n=>n===name||n.startsWith(name+' '));
  return names.map(n=>({name:n, id:stationIdOf(n)})).filter(x=>x.id!=null).sort((a,b)=>(b.name===main)-(a.name===main)||a.name.localeCompare(b.name,'pl'));
}
// Lista stacji w tablicy odjazdów: najpierw „wszystkie stacje miasta”, potem każda stacja miasta; w Rzeszowie dodatkowo okolice.
function fillStationSelect(name){
  const sel=document.getElementById('trStation'); if(!sel) return [];
  const list=cityStations(name);
  const region=name==='Rzeszów'?RAIL_IDS.filter(id=>!list.some(x=>x.id===id)).sort((a,b)=>RAIL_ST[a][0].localeCompare(RAIL_ST[b][0],'pl')):[];
  const own=list.length?list:name==='Rzeszów'?[{id:HOME_STATION_ID, name:'Rzeszów Główny'}]:[];
  sel.innerHTML=(own.length>1?`<option value="city">${esc(L2(`Wszystkie stacje: ${name}`,`All stations: ${name}`))}</option>`:'')
    +own.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')
    +(region.length?`<optgroup label="${esc(L2('Okolice','Nearby'))}">${region.map(id=>`<option value="${id}">${esc(RAIL_ST[id][0])}</option>`).join('')}</optgroup>`:'')
    +`<option value="all">${esc(L2('Wszystkie pociągi w Polsce','All trains in Poland'))}</option>`;
  TR.cityIds=new Set(own.map(x=>x.id));
  return own;
}
// Pociągi wybranego miasta: tablica jego stacji i wyszukiwanie połączeń od niego.
function applyCity(name){
  const own=fillStationSelect(name);
  if(!own.length) return false;
  const sel=document.getElementById('trStation');
  TR.station=own.length>1?'city':own[0].id; TR.page=null; if(sel) sel.value=String(TR.station);
  const prev=TCITY.station; TCITY.station=name;
  const trFrom=document.getElementById('trFrom');
  if(trFrom && (!trFrom.value.trim() || trFrom.value===prev)) trFrom.value=name;
  if(S.agency==='kolej' && (!plFrom.value.trim() || plFrom.value===prev)) plFrom.value=own[0].name;
  if(typeof renderBoard==='function' && TR.trains.length){ renderBoard(); if(S.sub==='linie') renderTrainLines(); }
  return true;
}
function applySavedCity(){ if(!TCITY.applied && RAIL_NAMES.size) TCITY.applied=applyCity(TCITY.name); }
function selectCity(name, auto=false){
  TCITY.name=name; TCITY.open=false; store('onward.city', name); store('onward.cityAuto', auto);
  const ok=applyCity(name); TCITY.applied=ok;
  const local=LOCAL_TRANSIT.has(name), tx=txCity(name), sub=['','rozklad','linie'].includes(S.sub)?S.sub:'';
  // Nagłówek, zakładki i treść strony zawsze od razu dla nowego miasta.
  if(TRANSIT.includes(S.agency) && S.sub!=='ulubione'){
    if(!local && !tx && S.agency!=='kolej') goPage('kolej', sub);
    else if(tx && S.agency==='pks') goPage('ztm', sub);
    else setSubpage(sub);
  } else renderTransitTabs(TRANSIT.includes(S.agency)?(S.sub==='ulubione'?FAVF.kind:S.agency):'ztm');
  const what=local?L2('autobusy miejskie, podmiejskie i pociągi','city buses, suburban buses and trains'):tx?L2(`${txModes(tx)}${tx.live?' na żywo':''} i pociągi`,`${txModes(tx)}${tx.live?' live':''} and trains`):L2('pociągi','trains');
  toast(auto?L2(`Najbliższe miasto: ${name} — ${what}. Zmienisz je przyciskiem „Miasto”.`,`Nearest city: ${name} — ${what}. Change it with the “City” button.`):`${name}: ${what}.`);
}
// Miasto domyślne: najbliższe z miast z komunikacją miejską, gdy znamy położenie, a użytkownik sam miasta nie wybrał.
function nearestTransitCity(spot){
  let best=null, bestM=Infinity;
  for(const c of [RZ_CITY, ...TXC.list]){ const m=hav([spot.lat,spot.lon], c.centre); if(m<bestM){ bestM=m; best=c; } }
  return best?.name||null;
}
function autoCity(spot){
  if(!spot || !Number.isFinite(spot.lat) || !(store('onward.city')==null || store('onward.cityAuto')===true)) return;
  const name=nearestTransitCity(spot);
  if(name && name!==TCITY.name) selectCity(name, true);
  else if(name) store('onward.cityAuto', true);
}
document.getElementById('transitTabs')?.addEventListener('input', e=>{
  if(e.target.id!=='cityQuery') return;
  TCITY.q=e.target.value; const pos=e.target.selectionStart;
  renderTransitTabs(TRANSIT.includes(S.agency)?S.agency:'ztm');
  const q=document.getElementById('cityQuery'); q?.focus(); q?.setSelectionRange(pos,pos);
});
document.getElementById('transitTabs')?.addEventListener('keydown', e=>{
  if(e.key==='Escape' && TCITY.open){ toggleCityPicker(false); document.querySelector('[data-city-open]')?.focus(); }
  if(e.key==='Enter' && e.target.id==='cityQuery'){ e.preventDefault(); const first=document.querySelector('[data-city-pick]'); if(first) selectCity(first.dataset.cityPick); }
  if(e.key==='ArrowDown' && e.target.id==='cityQuery'){ e.preventDefault(); document.querySelector('[data-city-pick]')?.focus(); }
});
document.addEventListener('click', e=>{ if(TCITY.open && !e.target.closest('.tx-city')) toggleCityPicker(false); });
const TRANSIT=['ztm','pks','kolej'];
const TRANSIT_MODES=[['ztm','bus','Autobusy miejskie','City buses'],['pks','suburban-bus','Podmiejskie','Suburban'],['kolej','train','Pociągi','Trains']];
function renderTransitTabs(current){
  const el=document.getElementById('transitTabs'); if(!el) return;
  const fav=S.sub==='ulubione', show=TRANSIT.includes(current) && ['', 'rozklad', 'linie', 'ulubione'].includes(S.sub);
  el.hidden=!show; if(!show){ el.innerHTML=''; return; }
  const local=LOCAL_TRANSIT.has(TCITY.name), tx=txCity();
  const txOn=tx&&current==='ztm';
  // Ulubione mają własną stronę (gwiazdka w górnym pasku), więc tu trzecia zakładka to linie wybranego miasta.
  const subs=[['', current==='pks'?L2('Dokąd dojedziesz','Where you can go'):L2('Szukaj połączenia','Find a connection'), 'fa-solid fa-magnifying-glass'], ['rozklad', L2('Rozkład jazdy','Timetable'), 'fa-regular fa-clock'], ['linie', L2('Linie','Lines'), 'fa-solid fa-list-ol']];
  // Autobusy podmiejskie są częścią „Autobusów” (przełącznik Miejskie / Podmiejskie w Rzeszowie), nie osobną sekcją.
  const bus=current==='ztm'||current==='pks';
  const modes=TRANSIT_MODES.filter(([v])=>v!=='pks').map(([v,icon,pl,en])=>{ const on=v==='kolej'?current==='kolej':bus; const soon=v==='ztm'&&!local&&!tx; if(v==='ztm'){ [pl,en]=tx||local?['Komunikacja miejska','City transport']:['Autobusy','Buses']; } return `<button type="button" class="tx-mode ${on?'on':''} ${soon?'soon':''}" data-transit-go="${v}" aria-pressed="${on}" ${soon?`title="${esc(L2(`${TCITY.name}: wkrótce — na razie pociągi`,`${TCITY.name}: coming soon — trains for now`))}" aria-disabled="true"`:''}><i class="oi oi-${icon}" aria-hidden="true"></i> ${L2(pl,en)}</button>`; }).join('');
  const searchTab=current==='ztm'&&S.sub==='';
  const kinds=local&&bus&&!searchTab?`<div class="tx-kinds" role="group" aria-label="${L2('Rodzaj autobusów','Kind of buses')}">${[['ztm',L2('Miejskie','City')],['pks',L2('Podmiejskie','Suburban')]].map(([v,label])=>`<button type="button" class="tx-kind ${v===current?'on':''}" data-transit-go="${v}" aria-pressed="${v===current}">${label}</button>`).join('')}</div>`:'';
  // Rzeszów: ten sam nagłówek miasta co w innych miastach (nazwa, rodzaje komunikacji, znaczek „na żywo”).
  const head=local&&bus&&!searchTab?`<div class="ctx-head tx-city-head"><div><h3><i class="fa-solid fa-bus" aria-hidden="true"></i> ${esc(TCITY.name)}</h3><small>${L2('autobusy miejskie · podmiejskie · ZTM Rzeszów, PKS Rzeszów','city buses · suburban buses · ZTM Rzeszów, PKS Rzeszów')}</small></div>
    <span class="ctx-badge live"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> ${L2('Pozycje na żywo','Live positions')}</span></div>`:'';
  el.innerHTML=`${cityPickerHtml()}<div class="tx-modes" role="group" aria-label="${L2('Rodzaj komunikacji','Kind of transport')}">${modes}</div>
    <div class="tx-subs" role="group" aria-label="${L2('Widok','View')}">${subs.map(([v,label,icon])=>`<button type="button" class="tx-sub ${(fav?'ulubione':S.sub)===v?'on':''}" data-transit-sub="${v}" aria-pressed="${(fav?'ulubione':S.sub)===v}"><i class="${icon}" aria-hidden="true"></i> ${label}</button>`).join('')}</div>${head}${kinds}`;
}
document.getElementById('transitTabs')?.addEventListener('click', e=>{
  const m=e.target.closest('[data-transit-go]'), sub=e.target.closest('[data-transit-sub]');
  const cur=S.sub==='ulubione'?FAVF.kind:S.agency;
  if(e.target.closest('[data-city-close]')){ toggleCityPicker(false); return; }
  if(e.target.closest('[data-city-open]')){ toggleCityPicker(); return; }
  const pick=e.target.closest('[data-city-pick]'); if(pick){ selectCity(pick.dataset.cityPick); return; }
  if(m){ if(m.getAttribute('aria-disabled')==='true'){ toast(txCity()?L2(`${TCITY.name}: autobusy podmiejskie dodamy wkrótce. Komunikacja miejska i pociągi już działają.`,`${TCITY.name}: suburban buses are coming soon. City transport and trains work now.`):L2(`${TCITY.name}: autobusy miejskie i podmiejskie dodamy wkrótce. Na razie pociągi.`,`${TCITY.name}: city and suburban buses are coming soon. Trains for now.`)); return; } const next=S.sub==='ulubione'?'ulubione':S.sub; const go=m.classList.contains('tx-mode')&&m.dataset.transitGo==='ztm'&&cur==='pks'?'pks':m.dataset.transitGo; goPage(go, next, next==='ulubione'?go:'all'); return; }
  // „Szukaj połączenia” to zawsze planer miasta (w Rzeszowie obejmuje też autobusy podmiejskie).
  if(sub){ const v=sub.dataset.transitSub, to=v===''&&cur==='pks'?'ztm':cur; goPage(TRANSIT.includes(to)?to:'ztm', v, v==='ulubione'?(TRANSIT.includes(to)?to:'ztm'):'all'); }
});
function syncNav(){
  const fav=S.sub==='ulubione', current=fav?(FAVF.kind==='all'?'':FAVF.kind):S.agency, tab=S.sub==='kierunki'?'kierunki':TRANSIT.includes(current)?'transit':current;
  renderTransitTabs(current);
  document.querySelectorAll('.view-tab').forEach(a=>{ const on=a.dataset.view===tab; a.classList.toggle('active',on); if(on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-go]').forEach(a=>{ const sub=a.dataset.sub||'', on=a.dataset.go===current&&sub===S.sub; a.classList.toggle('active',on); if(on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  const all=document.getElementById('favLink'); all.classList.toggle('active', fav&&FAVF.kind==='all');
  const trip=S.sub==='trip'?findTrip(TRIPV.id):null;
  document.getElementById('myTripsLink')?.classList.toggle('active', S.sub==='moje'||trip?.status==='booked');
  if(trip && trip.status!=='booked') all.classList.add('active');
  document.querySelectorAll('[data-proxy]').forEach(b=>b.classList.toggle('active', !!document.getElementById(b.dataset.proxy)?.classList.contains('active')));
  document.querySelectorAll('[data-transit]').forEach(b=>b.classList.toggle('active', TRANSIT.includes(current)));
}
function transitHead(agency, sub, city, tx){
  if(agency==='kolej') return sub==='rozklad'?[`Rozkład pociągów: ${city}`,'Odjazdy i przyjazdy na stacjach w mieście.']
    :sub==='linie'?[`Pociągi: ${city}`,'Kierunki pociągów, które dziś zatrzymują się w mieście. Wybierz kierunek, by znaleźć połączenie.']
    :[`Pociągi: ${city}`,'Połączenia kolejowe ze stacji w mieście i w całej Polsce.'];
  if(agency==='pks') return sub==='rozklad'?[`Rozkład jazdy: ${city}`,'Sprawdź rozkład według przystanku i linii.']
    :sub==='linie'?[`Linie: ${city}`,'Linie komunikacji podmiejskiej i ich pojazdy na mapie.']
    :[`Podmiejskie: ${city}`,'Połączenia do pobliskich miejscowości i okolic.'];
  const modes=tx?txModes(tx):L2('autobusy','buses');
  return sub==='rozklad'?[`Rozkład jazdy: ${city}`, tx?'Najbliższe odjazdy z wybranego przystanku, z opóźnieniami na żywo.':'Sprawdź rozkład według przystanku i linii.']
    :sub==='linie'?[`Linie: ${city}`, tx?'Wszystkie linie w mieście i ich pojazdy w trasie. Wybierz linię, by zobaczyć ją na mapie.':'Wszystkie linie i ich pojazdy na mapie.']
    :[`Komunikacja: ${city}`, `${modes[0].toUpperCase()+modes.slice(1)} — połączenia po mieście, rozkłady i pojazdy na mapie.`];
}
function setSubpage(sub){
  // Pełnoekranowa mapa komunikacji nie może zostać nad inną stroną (ani blokować przewijania).
  try{ if(CITY.el?.classList.contains('map-full')) setCityMap(false); }catch(e){} // CITY jeszcze nie istnieje przy pierwszym ustawieniu strony
  if((sub==='rozklad'||sub==='linie') && S.agency==='podroz') sub='';
  if(sub==='kierunki' && S.agency!=='podroz') sub='';
  if((sub==='moje'||sub==='trip') && S.agency!=='podroz') sub='';
  if(S.sub==='trip' && sub!=='trip'){ document.getElementById('tripPage').innerHTML=''; window.PVUI?.layer.leave('trip'); TRIPV.city=false; TRIPV.sheet=''; TRIPV.map=false; stopVehicles(); }
  S.sub=sub;
  const V=VIEWS[S.agency];
  document.body.classList.toggle('tt-mode', sub==='rozklad' && !(S.agency==='ztm' && txCity())); // odjazdy innych miast mają własną stronę
  document.body.classList.toggle('lines-mode', sub==='linie' && !(S.agency==='ztm' && txCity()));
  document.body.classList.toggle('fav-mode', sub==='ulubione');
  document.body.classList.toggle('explore-mode', sub==='kierunki');
  document.body.classList.toggle('mytrips-mode', sub==='moje');
  document.body.classList.toggle('trip-mode', sub==='trip');
  let title=V.title, lead=V.lead;
  // Nagłówki stron jak w arkuszu ON/WARD: krótki tytuł (ostatnie słowo na złoto) i jedno zdanie opisu.
  const tx=S.agency==='ztm'&&['','rozklad','linie'].includes(sub)?txCity():null;
  // Strony komunikacji zawsze w nagłówku podają wybrane miasto (ostatnie słowo tytułu jest złote).
  if(TRANSIT.includes(S.agency) && ['','rozklad','linie'].includes(sub)) [title,lead]=transitHead(S.agency, sub, TCITY.name, tx);
  if(sub==='ulubione'){ title=FAV_TITLES[FAVF.kind]; lead='Zapisane trasy, przystanki, stacje i podróże.'; }
  if(sub==='kierunki'){ title='Sprawdź kierunki'; lead=EXPLORE.summary||'Sprawdź, dokąd polecisz z polskich lotnisk.'; }
  if(sub==='moje'){ title='Moje podróże'; lead=MYT.tab==='archive'?'Archiwum: Twoje minione podróże, ich plany i zdjęcia.':MYT.tab==='calendar'?L2('Kalendarz: podróże, plany z ulubionych i Twoje wolne dni.','Calendar: trips, saved plans and your days off.'):'Twoje zaplanowane podróże w jednym miejscu.'; }
  if(sub==='trip'){ const t=findTrip(TRIPV.id); title='Szczegóły podróży'; lead=t?tripLead(t):'Twoja podróż krok po kroku.'; }
  setHeroTitle(title);
  document.getElementById('heroLead').textContent=lead;
  updateBanner(); renderEditBadge();
  document.title=`${title} · ${APP_NAME}`;
  const url=pageUrl(S.agency, sub, FAVF.kind);
  if(location.pathname+location.search+location.hash!==url) history.replaceState(null,'',url);
  syncNav(); renumberSections(); syncCityTx();
  if(sub==='rozklad' && !tx){ if(S.agency==='kolej') renderBoard(); else renderTimetable(); }
  if(sub==='linie' && !tx){ if(S.agency==='kolej') renderTrainLines(); else renderLinesGrid(); }
  if(sub==='ulubione') renderFavorites();
  if(sub==='moje') renderMyTrips();
  if(sub==='trip') renderTripPage();
  if(sub==='kierunki'){ EXPLORE.open=true; setTimeout(()=>{ renderExplore(); EXPLORE.map?.invalidateSize(); }, 60); }
}
function setTimetableMode(on){ setSubpage(on?'rozklad':''); }
// Przejście z menu: kategoria i jej podstrona.
function goPage(view, sub='', kind='all'){
  if(sub==='ulubione') FAVF.kind=kind;
  if(view!==S.agency) setView(view, true, sub, kind);
  else { const before=location.pathname+location.search+location.hash; setSubpage(sub); const url=pageUrl(view, sub, FAVF.kind); if(before!==url) history.pushState(null,'',url); }
  window.scrollTo({top:0, behavior:'instant'});
  if(sub==='rozklad') setTimeout(()=>document.getElementById(S.agency==='kolej'?'trSearch':'ttStop').focus(), 50);
}
// Dolny pasek: „Podróże” i „Ulubione” działają jak te same przyciski w górnym pasku.
document.querySelectorAll('[data-proxy]').forEach(a=>a.addEventListener('click', e=>{ e.preventDefault(); document.getElementById(a.dataset.proxy)?.click(); }));
// Na komputerze (od 1024 px) ten sam pasek jest lewym panelem; można go zwinąć do samych ikon (app.shell.css).
// Wybór zostaje w przeglądarce; nazwy stron są wtedy podpowiedzią (title) i zostają dla czytników ekranu.
(function sideNav(){
  const KEY='podavo.sideCollapsed', btn=document.getElementById('sideToggle'); if(!btn) return;
  document.querySelectorAll('.bottom-nav a').forEach(a=>{ const t=a.querySelector('span')?.textContent.trim(); if(t) a.title=t; });
  const apply=collapsed=>{
    document.body.classList.toggle('side-collapsed', collapsed);
    const label=collapsed?L2('Rozwiń menu','Expand menu'):L2('Zwiń menu','Collapse menu');
    btn.setAttribute('aria-expanded', String(!collapsed)); btn.title=label; btn.querySelector('span').textContent=label;
  };
  apply(store(KEY)===true);
  btn.addEventListener('click', ()=>{ const collapsed=!document.body.classList.contains('side-collapsed'); store(KEY, collapsed); apply(collapsed); window.dispatchEvent(new Event('resize')); });
})();
document.querySelectorAll('[data-go]').forEach(a=>a.addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault();
  const sub=a.dataset.sub||'';
  goPage(a.dataset.go, sub, sub==='ulubione'?a.dataset.go:'all');
}));
document.addEventListener('click', e=>{
  const go=e.target.closest('[data-fav-goto]'); if(!go || e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); goPage('podroz','ulubione','podroz');
});
document.addEventListener('click', e=>{
  if(!e.target.closest('[data-edit-search]')) return;
  e.target.closest('details')?.removeAttribute('open');
  const box=document.querySelector('.search-box'); box?.scrollIntoView({behavior:'smooth', block:'center'}); setTimeout(()=>plDate.focus(),400);
});
// Czysty planer: przycisk „Resetuj”, zakładka „Zaplanuj podróż” i logo zaczynają od zera (bez wczytanej podróży).
// Planer otwarty z zapisanej podróży („Edytuj w planerze”): mała etykieta „Tryb edycji” w prawym dolnym rogu,
// dopóki podróż nie zostanie zapisana, wyczyszczona albo edycja zakończona przyciskiem ×.
function renderEditBadge(){
  const el=document.getElementById('editBadge'); if(!el) return;
  const on=!!S.editing && S.agency==='podroz' && !S.sub;
  el.hidden=!on;
  if(on) document.getElementById('editBadgeLabel').textContent=S.editing.label;
}
document.getElementById('editBadgeEnd')?.addEventListener('click', ()=>{ S.editing=null; renderEditBadge(); });
/* ---------- Podróż w etapach: każdy odcinek (start → miejsce 1, miejsce 1 → miejsce 2, …) planujemy osobno,
   z wyborem środka transportu (samochód, pociąg, autobus, lot), a na końcu zapisujemy całą podróż ---------- */
/* ---------- Formularz „Wiele miejsc”: start i kolejne miejsca, każde z datą, godziną i środkami transportu ---------- */
const MF_MODES=[['bus','bus','Autobus'],['train','train','Pociąg'],['plane','plane','Samolot'],['car','car','Samochód']], MF_MAX=6;
const mfFrom=document.getElementById('mfFrom'), mfSteps=document.getElementById('mfSteps');
function mfStepHtml(i, x={}){
  const modes=(x.modes||MF_MODES.map(m=>m[0])).map(m=>m==='pks'?'bus':m);
  return `<li class="mf-step">
    <div class="mf-route" aria-live="polite"><span class="mf-route-from"></span><i class="fa-solid fa-arrow-right-long" aria-hidden="true"></i><span class="mf-route-to"></span></div>
    <span class="mf-n" aria-hidden="true">${i+1}</span>
    <div class="pl-field mf-to-f"><label><i class="oi oi-pin" aria-hidden="true"></i> <span class="mf-label">Miejsce ${i+1}</span></label><div class="pl-inp"><input class="mf-to" placeholder="Dokąd" value="${esc(x.to||'')}" autocomplete="off"></div></div>
    <div class="pl-field mf-date-f"><label><i class="oi oi-calendar" aria-hidden="true"></i> Data</label><div class="pl-inp"><input class="mf-date dp-input" type="date" readonly value="${esc(x.date||'')}" min="${ymdOf(0)}" max="${lastPlanDay()}" aria-haspopup="dialog"></div></div>
    <div class="pl-field mf-time-f"><select class="mf-when pl-when" aria-label="Znaczenie godziny"><option value="dep" ${x.when!=='arr'?'selected':''}>Odjazd</option><option value="arr" ${x.when==='arr'?'selected':''}>Na miejscu o</option></select><div class="pl-inp"><input class="mf-time" type="time" value="${esc(x.time||'')}" aria-label="Godzina (puste = dowolna)"></div></div>
    <div class="mf-modes" role="group" aria-label="Środki transportu na tym etapie">${MF_MODES.map(([v,icon,label])=>`<label class="mode-check sm"><input type="checkbox" value="${v}" ${modes.includes(v)?'checked':''}> <i class="oi oi-${icon}" aria-hidden="true"></i> ${label}</label>`).join('')}</div>
    <button type="button" class="pl-stop-remove mf-remove" title="Usuń to miejsce" aria-label="Usuń to miejsce"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
  </li>`;
}
function mfRenumber(){
  [...mfSteps.querySelectorAll('.mf-step')].forEach((li,i)=>{ li.querySelector('.mf-n').textContent=i+1; li.querySelector('.mf-label').textContent=`Miejsce ${i+1}`; });
  const n=mfSteps.querySelectorAll('.mf-step').length;
  document.getElementById('mfAdd').disabled=n>=MF_MAX;
  mfSteps.querySelectorAll('.mf-remove').forEach(b=>{ b.hidden=n<=1; });
  mfRoutes();
}
// Łańcuch etapów: każdy wiersz pokazuje „skąd → dokąd”, a przycisk „Następne miejsce” — skąd ruszy kolejny etap.
const placeName=v=>String(v||'').split(',')[0].trim();
function mfRoutes(){
  let prev=placeName(mfFrom.value)||L2('Start','Start');
  [...mfSteps.querySelectorAll('.mf-step')].forEach((li,i)=>{
    const to=placeName(li.querySelector('.mf-to').value);
    li.querySelector('.mf-route-from').textContent=prev;
    li.querySelector('.mf-route-to').textContent=to||L2(`Miejsce ${i+1}`,`Place ${i+1}`);
    li.querySelector('.mf-route').classList.toggle('empty', !to);
    prev=to||L2(`Miejsce ${i+1}`,`Place ${i+1}`);
  });
  const n=mfSteps.querySelectorAll('.mf-step').length, nx=document.getElementById('mfNextFrom');
  if(nx) nx.textContent=n>=MF_MAX?L2(`Najwyżej ${MF_MAX} miejsc`,`At most ${MF_MAX} places`):L2(`Kolejny etap z: ${prev}`,`Next stage from: ${prev}`);
}
mfFrom?.addEventListener('input', mfRoutes);
mfSteps?.addEventListener('input', e=>{ if(e.target.matches('.mf-to')) mfRoutes(); });
mfSteps?.addEventListener('change', e=>{ if(e.target.matches('.mf-to')) mfRoutes(); });
mfFrom?.addEventListener('change', mfRoutes);
function mfAddStep(x={}){
  const steps=mfSteps.querySelectorAll('.mf-step'); if(steps.length>=MF_MAX) return null;
  const prev=steps[steps.length-1];
  if(!x.date && prev) x.date=prev.querySelector('.mf-date').value;
  if(!x.modes && prev) x.modes=[...busModes([...prev.querySelectorAll('.mf-modes input:checked')].map(i=>i.value))];
  mfSteps.insertAdjacentHTML('beforeend', mfStepHtml(steps.length, x));
  const li=mfSteps.lastElementChild; attachSuggest(li.querySelector('.mf-to'), {streets:true});
  mfRenumber(); return li;
}
// Przełączenie na „Wiele miejsc”: start i pierwsze miejsce z wyszukiwarki; kolejne dodaje się przyciskiem „Następne miejsce”.
function enterMultiForm({addStep=false, from='', steps=null}={}){
  if(!mfFrom.dataset.sugg){ mfFrom.dataset.sugg='1'; attachSuggest(mfFrom, {streets:true}); }
  document.body.classList.add('multi-form'); plRound.checked=false; syncReturn();
  if(from || !mfFrom.value) mfFrom.value=from||plFrom.value;
  if(steps){ mfSteps.innerHTML=''; steps.forEach(x=>mfAddStep({...x})); }
  if(!mfSteps.children.length) mfAddStep({to:plTo.value, date:plDate.value, modes:[...document.querySelectorAll('#plModes input:checked')].map(x=>x.value)});
  if(addStep) mfAddStep();
  mfRenumber();
  const empty=[mfFrom, ...mfSteps.querySelectorAll('.mf-to')].find(i=>!i.value.trim());
  setTimeout(()=>(empty||mfFrom).focus(), 50);
}
function setPlanModes(modes){ document.querySelectorAll('#plModes input').forEach(x=>{ x.checked=modes.includes(x.value) || (x.value==='bus' && modes.includes('pks')); }); }
document.getElementById('mfAdd')?.addEventListener('click', ()=>{ const li=mfAddStep(); li?.querySelector('.mf-to').focus(); });
document.getElementById('multiForm')?.addEventListener('click', e=>{
  const rm=e.target.closest('.mf-remove'); if(rm){ rm.closest('.mf-step').remove(); mfRenumber(); return; }
  const d=e.target.closest('.mf-date'); if(d){ e.preventDefault(); openDatePicker(d); }
});
document.getElementById('multiForm')?.addEventListener('keydown', e=>{
  if(e.target.matches('.mf-date') && ['Enter',' ','ArrowDown'].includes(e.key)){ e.preventDefault(); openDatePicker(e.target); return; }
  if(e.key==='Enter' && e.target.matches('input:not(.mf-date)') && !document.querySelector('.sugg-list:not([hidden]) .on')){ e.preventDefault(); document.getElementById('mfGo').click(); }
});
document.getElementById('mfGo')?.addEventListener('click', ()=>{
  const err=document.getElementById('planErr'); err.textContent='';
  const from=mfFrom.value.trim(), rows=[...mfSteps.querySelectorAll('.mf-step')];
  const steps=rows.map(li=>({to:li.querySelector('.mf-to').value.trim(), date:li.querySelector('.mf-date').value, time:li.querySelector('.mf-time').value, when:li.querySelector('.mf-when').value, modes:[...busModes([...li.querySelectorAll('.mf-modes input:checked')].map(x=>x.value))]}));
  if(!from){ err.textContent='Podaj, skąd zaczynasz podróż.'; mfFrom.focus(); return; }
  const noPlace=steps.findIndex(x=>!x.to); if(noPlace>=0){ err.textContent=`Podaj miejsce ${noPlace+1}.`; rows[noPlace].querySelector('.mf-to').focus(); return; }
  if(steps.length<2){ err.textContent='Dodaj co najmniej dwa miejsca — dla jednego wybierz „W jedną stronę”.'; const li=mfAddStep(); li?.querySelector('.mf-to').focus(); return; }
  const noMode=steps.findIndex(x=>!x.modes.length); if(noMode>=0){ err.textContent=`Zaznacz środek transportu dla miejsca ${noMode+1}.`; return; }
  let last=ymdOf(0);
  for(let i=0;i<steps.length;i++){
    if(!steps[i].date) steps[i].date=last;
    if(steps[i].date<last){ err.textContent=`Data miejsca ${i+1} jest wcześniejsza niż poprzedniego.`; openDatePicker(rows[i].querySelector('.mf-date')); return; }
    if(steps[i].date>lastPlanDay()){ err.textContent=`Podróż można zaplanować najpóźniej na ${fmtDay(lastPlanDay())}.`; return; }
    last=steps[i].date; rows[i].querySelector('.mf-date').value=steps[i].date;
  }
  if(steps.some((x,i)=>x.to===(i?steps[i-1].to:from))){ err.textContent='Dwa kolejne miejsca są takie same.'; return; }
  const before=[...document.querySelectorAll('#plModes input:checked')].map(x=>x.value);
  S.multi={places:[from, ...steps.map(x=>x.to)], stays:[], dates:steps.map(x=>x.date), steps, legs:[], cur:0, to:steps[steps.length-1].to, tripTitle:undefined, saved:null, savedOk:null, modesBefore:before};
  runLeg(0);
});
// S.multi = {places, stays (min), dates (dzień wyjazdu każdego etapu), legs (wybrane), cur (etap albo 'save'), rows (do edycji)}
function startMulti(from, vias, to, date){
  S.multi={places:[from, ...vias.map(v=>v.label), to], stays:vias.map(v=>v.stay), dates:[date||ymdOf(0)], legs:[], cur:0, to, tripTitle:undefined, saved:null, savedOk:null};
  clearVias(); runLeg(0);
}
function runLeg(k){
  const M=S.multi; if(!M) return;
  M.cur=k; M.saved=null;
  if(plRound.checked) document.querySelector('[data-round="0"]')?.click();
  const st=M.steps?.[k];
  plFrom.value=M.places[k]; plTo.value=M.places[k+1]; plDate.value=M.dates[k]||M.dates[k-1]||ymdOf(0); plTime.value=st?.time||''; plWhen.value=st?.when||'dep';
  if(st?.modes?.length) setPlanModes(st.modes);
  S.placeChoice={}; renderMultiBar();
  S.multiLeg=true; document.getElementById('planForm').requestSubmit();
  document.querySelector('.search-box')?.scrollIntoView({behavior:'smooth', block:'start'});
}
// Wybrany odcinek w postaci zapisywanej w podróży (lot z dojazdami albo połączenie lądowe).
function multiLegOf(P, kind){
  const n=Math.max(1,P.people||1);
  if(kind==='ground'){
    const g=P.groundPick; if(!g) return null;
    return {kind:'ground', key:`g:${g.key}@${g.day}`, from:P.from, to:P.to, day:g.day, leave:g.leave, arrive:g.arrive, arrDay:g.arrive!=null?dayOfTs(g.arrive):g.day,
      title:g.title, icon:g.icon, cost:g.cost==null?null:Math.round((g.kind==='car'?g.cost*Math.ceil(n/CAR_SEATS):g.cost*n)*100)/100, a:g.a, b:g.b, g};
  }
  const C=flightChoice(P); if(!C?.out || !P.xferPick) return null;
  const f={...C.out, ret:null, returns:[]}, o=pickedAccess(P,f), d=airportOptions(P,f), {weather, ...snap}=tripSnapshot(P,f,o,d);
  const ll=x=>x?.lat!=null?[x.lat,x.lon]:null;
  return {kind:'flight', key:`f:${fareKey(f)}`, from:P.from, to:P.to, day:f.day, leave:o?.leave||null, arrive:null, arrDay:snap.out?.arrDay||f.day,
    title:`${snap.out?.airlineName||'Lot'} ${f.from} → ${f.to}`, icon:'plane', cost:snap.costs?.total??null, a:ll(snap.home), b:ll(snap.centre)||ll(snap.dest), snap};
}
// Na końcu kroku: zatwierdź ten etap i przejdź do następnego (z jego datą) albo do zapisu całej podróży.
function multiLegBar(P, kind){
  const M=S.multi, k=M.cur, n=M.places.length-1, last=k===n-1, leg=multiLegOf(P, kind);
  if(!leg) return '';
  const next=addDays(leg.arrDay||leg.day, Math.round((M.stays[k]||0)/1440)), keep=M.dates[k+1]&&M.dates[k+1]>=(leg.arrDay||leg.day)?M.dates[k+1]:next;
  return `<div class="cs-save multi-next"><div class="cs-choice"><i class="fa-solid fa-route" aria-hidden="true"></i> Etap ${k+1} z ${n}: <b>${esc(P.from)} → ${esc(P.to)}</b> · ${esc(leg.title)}${leg.cost!=null?` · ok. ${zl(leg.cost)}`:''}</div>
    ${last?'':`<label class="multi-date"><span>Następny etap: <b>${esc(M.places[k+1])} → ${esc(M.places[k+2])}</b> — dzień wyjazdu${M.stays[k]?` <small>(postój ${fmtStay(M.stays[k])})</small>`:''}</span><input type="date" class="dp-input" readonly data-multi-date value="${keep}" min="${leg.arrDay||leg.day}" max="${lastPlanDay()}"></label>`}
    <div class="cs-save-btns"><button type="button" class="btn-grad btn-next" data-multi-next="${kind}">${last?'Dalej: zapisz całą podróż':`Dalej: etap ${k+2} — ${esc(M.places[k+1])} → ${esc(M.places[k+2])}`} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div></div>`;
}
function renderMultiBar(){
  const el=document.getElementById('multiBar'), M=S.multi;
  document.body.classList.toggle('multi-mode', !!M);
  if(!el) return;
  el.hidden=!M; if(!M){ el.innerHTML=''; return; }
  const n=M.places.length-1, all=M.legs.length===n && M.legs.every(Boolean);
  el.innerHTML=`<div class="mb-head"><b><i class="fa-solid fa-route" aria-hidden="true"></i> Podróż w etapach</b><span class="mb-actions"><button type="button" class="btn-ghost" data-multi-edit><i class="fa-solid fa-pen" aria-hidden="true"></i> Edytuj miejsca</button><button type="button" class="btn-ghost" data-multi-end title="Zakończ planowanie w etapach">×</button></span></div>
    <ol class="mb-legs">${M.places.slice(0,-1).map((p,k)=>{ const L=M.legs[k], on=M.cur===k, open=L||on||M.legs[k-1];
      return `<li class="${on?'on':L?'done':''}"><button type="button" data-multi-leg="${k}" ${open?'':'disabled'} aria-current="${on?'step':'false'}"><span class="mb-n">${L&&!on?'<i class="fa-solid fa-check" aria-hidden="true"></i>':k+1}</span><span class="mb-text"><b>${esc(p)} → ${esc(M.places[k+1])}</b><small>${L?`<i class="fa-solid fa-${esc(L.icon)}" aria-hidden="true"></i> ${esc(L.title)} · ${fmtDay(L.day)}`:on?'wybierz środek transportu':M.dates[k]?fmtDay(M.dates[k]):'—'}</small></span></button></li>`; }).join('')}
      <li class="${M.cur==='save'?'on':''}"><button type="button" data-multi-save-step ${all?'':'disabled'}><span class="mb-n"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i></span><span class="mb-text"><b>Zapisz podróż</b><small>${all?'wszystkie etapy wybrane':`wybrano ${M.legs.filter(Boolean).length} z ${n}`}</small></span></button></li></ol>`;
}
function showMultiSave(){
  const M=S.multi; if(!M) return;
  M.cur='save'; planReq++; S.plan=null;
  document.getElementById('planResults').innerHTML=multiSaveView();
  renderMultiBar(); updatePlanScope();
  document.getElementById('planResults').scrollIntoView({behavior:'smooth', block:'start'});
}
function multiSaveView(){
  const M=S.multi, n=M.places.length-1, legs=M.legs;
  const total=legs.reduce((a,L)=>a+(L.cost||0),0), unknown=legs.some(L=>L.cost==null);
  const cards=legs.map((L,k)=>`<div class="journey-box ground-leg"><div class="jl-head"><h4 class="trip-title"><i class="fa-solid fa-${esc(L.icon)}" aria-hidden="true"></i> Etap ${k+1}: ${esc(L.from)} → ${esc(L.to)}</h4><button type="button" class="btn-ghost" data-multi-leg="${k}"><i class="fa-solid fa-pen" aria-hidden="true"></i> Zmień</button></div>
      <small class="text-soft">${esc(L.title)} · ${longDay(L.day,{weekday:'short', day:'numeric', month:'long'})}${L.leave!=null?` · wyjście ${fmtClock(L.leave)}`:''}${L.arrive!=null?` · na miejscu ${fmtClock(L.arrive)}`:''}${L.cost!=null?` · ok. ${zl(L.cost)}`:''}</small>
      ${L.kind==='ground'?stepsHtml(L.g.steps||[]):stepsHtml([...(L.snap.access?.steps||[]).slice(0,6), {icon:'plane-departure', text:`Lot ${L.snap.out?.fromLabel||''} → ${L.snap.out?.toLabel||''}`, sub:`${L.snap.out?.dep||''} → ${L.snap.out?.arr||''} · ${L.snap.out?.airlineName||''}`}, ...(L.snap.xfer?[{icon:L.snap.xfer.skip?'car-side':'bus', text:L.snap.xfer.skip?'Z lotniska: ktoś mnie odbierze':`Z lotniska do centrum: ${L.snap.xfer.name||''}`, sub:[L.snap.xfer.minutes!=null?`ok. ${fmtDuration(L.snap.xfer.minutes)}`:'', L.snap.xfer.fare||''].filter(Boolean).join(' · ')}]:[])])}</div>`+
      (k<n-1&&M.stays[k]?`<div class="trip-stop-note"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(M.places[k+1])}: postój ${fmtStay(M.stays[k])}</div>`:'')).join('');
  return `<div class="plan-head"><span>${M.places.map(esc).join(' <span class="txt-red">→</span> ')}</span></div>${cards}
    <div class="cs-save"><div class="cs-choice"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Zapisz całą podróż w ulubionych albo jako swoją podróż.${legs.length?` <small>Koszt: ${unknown?'od ':'ok. '}${zl(total)}</small>`:''}</div>
      ${planStayBox('multi',M)}
      ${tripTitleField(M)}
      <div class="cs-save-btns"><button type="button" class="btn-ghost" data-multi-save="planned"><i class="fa-regular fa-bookmark" aria-hidden="true"></i> Zapisz w ulubionych</button>
      <button type="button" class="${saveCls(M)}" data-multi-save="booked"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> Zapisz moją podróż</button></div>${SAVE_NOTE}${savedNote(M)}</div>`;
}
function saveMultiTrip(status, title){
  const M=S.multi, legs=M?.legs||[], n=(M?.places.length||1)-1; if(!M || legs.length!==n || legs.some(x=>!x)) return;
  const id='m:'+legs.map(L=>L.key).join('>').slice(0,180);
  const before=FAV.items.find(x=>x.type==='trip' && (x.id===id || (S.editing?.tid && x.tid===S.editing.tid)));
  const at=x=>Array.isArray(x)?{lat:x[0], lon:x[1]}:{lat:null, lon:null};
  const home={label:M.places[0], ...at(legs[0].a)}, dest={label:M.places[n], ...at(legs[n-1].b)};
  const stops=M.places.slice(1,-1).map((label,k)=>({label, ...at(legs[k].b), stay:M.stays[k]||0}));
  const wx=(icon,label,p,day,ts)=>p.lat!=null&&day?[{icon,label,place:label,lat:p.lat,lon:p.lon,day,time:ts!=null?fmtClock(ts):''}]:[];
  const weather=[...wx('house',M.places[0],home,legs[0].day,legs[0].leave), ...stops.flatMap((x,k)=>wx('location-dot',x.label,x,legs[k].arrDay,legs[k].arrive)), ...wx('location-dot',M.places[n],dest,legs[n-1].arrDay,legs[n-1].arrive)];
  const people=Math.max(1,+document.getElementById('plPeople')?.value||1);
  const item={type:'trip', view:'podroz', id, tid:before?.tid||newTid(), status, from:M.places[0], to:M.places[n], stops:stops.map(x=>x.label), title:(title||'').trim().slice(0,80),
    name:legs.map(L=>L.title).join(' + ').slice(0,190), detail:`${fmtDay(legs[0].day)} – ${fmtDay(legs[n-1].arrDay)} · ${n} ${n<5?'etapy':'etapów'}`,
    trip:{multi:true, legs, home, dest, stops, people, weather, savedAt:new Date().toISOString(), ...stayForTrip('multi',M,{},before)}};
  FAV.items=[...FAV.items.filter(x=>!(x.type==='trip' && (x.id===id || (before && x.tid===before.tid)))), item].slice(-50);
  M.savedOk=null; M.saved=item.tid;
  saveFavorites().then(ok=>{ if(ok!==false && M.saved===item.tid){ M.savedOk=item.tid; if(S.multi===M && M.cur==='save') document.getElementById('planResults').innerHTML=multiSaveView(); } }).catch(e=>console.warn('Nie zapisano podróży', e));
  renderFavorites(); syncStars(); navCounts(); S.editing=null; renderEditBadge();
  document.getElementById('planResults').innerHTML=multiSaveView();
  toast(status==='booked'?'Zapisano w „Moje podróże”.':'Zapisano plan w ulubionych.');
  finishSaved(item.tid);
}
document.getElementById('multiBar')?.addEventListener('click', e=>{
  const M=S.multi; if(!M) return;
  const leg=e.target.closest('[data-multi-leg]'); if(leg){ runLeg(+leg.dataset.multiLeg); return; }
  if(e.target.closest('[data-multi-save-step]')){ showMultiSave(); return; }
  if(e.target.closest('[data-multi-edit]')||e.target.closest('[data-multi-end]')){
    const edit=!!e.target.closest('[data-multi-edit]');
    if(M.modesBefore) setPlanModes(M.modesBefore);
    // daty wybrane po drodze wracają do formularza
    [...mfSteps.querySelectorAll('.mf-step')].forEach((li,i)=>{ if(M.dates[i]) li.querySelector('.mf-date').value=M.dates[i]; });
    S.multi=null; planReq++; S.plan=null; document.getElementById('planResults').innerHTML=''; renderMultiBar(); updatePlanScope();
    if(edit) enterMultiForm(); else { document.body.classList.remove('multi-form'); syncReturn(); }
    document.querySelector('.search-box')?.scrollIntoView({behavior:'smooth', block:'center'});
  }
});

/* ---------- Każdy krok ma własny zakres: od kroku 2 wyszukiwarka zwija się do jednej linii ---------- */
function planDeep(){ return S.multi?.cur==='save' || (!!S.plan && (S.plan.groundStep===2 || S.plan.stages.some(P=>wantsFlights(P)&&(P.flightStep||1)>=2))); }
function updatePlanScope(){
  const deep=planDeep(), el=document.getElementById('planScope');
  document.body.classList.toggle('plan-deep', deep);
  if(!el) return;
  el.hidden=!deep; if(!deep){ el.innerHTML=''; return; }
  if(S.multi){ const M=S.multi; el.innerHTML=`<span class="ps-route"><i class="fa-solid fa-route" aria-hidden="true"></i> <b>${M.places.map(esc).join(' → ')}</b></span><span class="ps-meta">${M.cur==='save'?'Podsumowanie podróży':`Etap ${M.cur+1} z ${M.places.length-1}`}</span>${M.cur==='save'?'':`<button type="button" class="btn-ghost" data-scope-edit><i class="fa-solid fa-pen" aria-hidden="true"></i> ${L2('Zmień wyszukiwanie','Change search')}</button>`}`; return; }
  const st=S.plan.stages, first=st[0], last=st[st.length-1];
  const dates=plDate.value?`${fmtDay(plDate.value)}${plRound.checked&&plBack.value?' – '+fmtDay(plBack.value):''}`:L2('od dziś','from today');
  el.innerHTML=`<span class="ps-route"><i class="fa-solid fa-route" aria-hidden="true"></i> <b>${esc(first.from)} → ${esc(last.to)}</b></span><span class="ps-meta">${plRound.checked?L2('W obie strony','Round trip'):L2('W jedną stronę','One way')} · ${esc(dates)}</span><button type="button" class="btn-ghost" data-scope-edit><i class="fa-solid fa-pen" aria-hidden="true"></i> ${L2('Zmień wyszukiwanie','Change search')}</button>`;
}
document.getElementById('planScope')?.addEventListener('click', e=>{
  if(!e.target.closest('[data-scope-edit]') || !S.plan) return;
  S.plan.groundStep=1; S.plan.stages.forEach(P=>{ P.flightStep=1; });
  runPlan(false); document.querySelector('.search-box')?.scrollIntoView({behavior:'smooth', block:'center'});
});
function resetPlanner(){
  planReq++; S.plan=null; if(S.multi?.modesBefore) setPlanModes(S.multi.modesBefore); S.multi=null; renderMultiBar(); mfSteps.innerHTML=''; mfFrom.value=''; updateBanner(); document.body.classList.remove('plan-deep'); { const sc=document.getElementById('planScope'); if(sc){ sc.hidden=true; sc.innerHTML=''; } } S.editing=null; renderEditBadge(); S.restore=null; S.placeChoice={}; S.planView={picked:{}, sort:S.planView.sort};
  plFrom.value=''; plTo.value=''; plDate.value=''; plBack.value=''; plTime.value=''; plWhen.value='dep';
  clearVias(); store(planKey(S.agency), {from:'', to:''});
  document.getElementById('planResults').innerHTML=''; document.getElementById('planErr').textContent=''; document.getElementById('planHint').textContent='';
  if(typeof closeRange==='function') closeRange();
  syncReturn(); planBusy();
}
document.getElementById('plReset').addEventListener('click', ()=>{ resetPlanner(); plFrom.focus(); });
// Zapis („Zapisz moją podróż” albo „Zapisz w ulubionych”) kończy planowanie: czyści planer i otwiera zapisaną podróż.
function finishSaved(tid){
  resetPlanner(); document.body.classList.remove('multi-form'); syncReturn();
  openTrip(tid); window.scrollTo({top:0, behavior:'smooth'});
}
document.addEventListener('click', e=>{
  if(!e.target.closest('[data-plan-finish]')) return;
  e.preventDefault(); goPage('podroz'); resetPlanner(); document.body.classList.remove('multi-form'); syncReturn();
  window.scrollTo({top:0, behavior:'smooth'});
});
document.querySelectorAll('.brand, .view-tab[data-view="podroz"]').forEach(a=>a.addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); goPage('podroz'); resetPlanner();
}));
document.getElementById('myTripsLink').addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); MYT.tab='upcoming'; goPage('podroz', 'moje');
});
document.addEventListener('click', e=>{
  const go=e.target.closest('[data-go-mytrips]'); if(!go || e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); MYT.tab=go.dataset.goMytrips==='archive'?'archive':'upcoming'; goPage('podroz','moje');
});
document.getElementById('favLink').addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); goPage(S.agency, 'ulubione', 'all');
});
// Mapa autobusów na żywo jest schowana, dopóki ktoś jej nie otworzy.
const MAP_LABELS={ztm:'Pokaż mapę autobusów na żywo', pks:'Mapa'};
function setMapOpen(on, area){
  if(on && !MAP_LABELS[S.agency]) setView('ztm', true);
  document.body.classList.toggle('map-open', on);
  const b=document.getElementById('mapToggle'); b.setAttribute('aria-expanded', String(on));
  b.querySelector('span').textContent=on?'Ukryj mapę':(MAP_LABELS[S.agency]||MAP_LABELS.ztm);
  renumberSections();
  if(on){ map.invalidateSize(); if(area) map.fitBounds(area,{padding:[40,40], maxZoom:15, animate:false}); else fitView(); document.getElementById('map-sec').scrollIntoView({behavior:'smooth'}); }
}
document.getElementById('mapToggle').addEventListener('click', ()=>setMapOpen(!document.body.classList.contains('map-open')));
document.querySelectorAll('.view-tab:not(.dropdown-toggle):not([data-go]), [data-brand], .topbar a.brand').forEach(a=>a.addEventListener('click', e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault();
  goPage(a.dataset.view||'podroz');
}));
// Autobusy podmiejskie mamy tylko w Rzeszowie: w innym mieście /suburban otwiera jego komunikację (albo pociągi).
function openPage(page, push){
  if(page.view==='pks' && page.sub!=='ulubione' && !LOCAL_TRANSIT.has(TCITY.name)){ page={...page, view:txCity()?'ztm':'kolej'}; if(!push) history.replaceState(null,'',pageUrl(page.view, page.sub, page.kind)); }
  setView(page.view, push, page.sub, page.kind);
}
window.addEventListener('popstate', ()=>openPage(pageFromLocation(), false));
function setFilter(f){ S.filter=f; document.querySelectorAll('.pill-btn[data-filter]').forEach(b=>{ b.classList.toggle('active', b.dataset.filter===f); b.classList.toggle('late', b.dataset.filter==='late'); }); renderMarkers(); renderLateList(); }
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click', ()=>setFilter(b.dataset.filter)));
let qTimer; document.getElementById('lineSearch').addEventListener('input', e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ S.query=e.target.value.trim(); renderMarkers(); renderLateList(); renderLineNotice(); fitQuery(); }, 250); });
function fitQuery(){ if(!S.query) return; const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]); if(pts.length===1) map.setView(pts[0],15); else if(pts.length>1 && pts.length<40) map.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:15}); }
document.getElementById('lateList').addEventListener('click', e=>{ const b=e.target.closest('[data-id]'); if(!b) return; const v=S.vehicles.get(b.dataset.id); if(v){ map.setView([v.lat,v.lon], Math.max(map.getZoom(),15)); openBus(v.id); } });
document.getElementById('fitBtn').addEventListener('click', ()=>{ const pts=[...S.vehicles.values()].filter(matchesFilter).map(v=>[v.lat,v.lon]); if(pts.length) map.fitBounds(L.latLngBounds(pts),{padding:[30,30]}); });
document.getElementById('centerBtn').addEventListener('click', ()=>map.setView(RZ_CENTER,13));
document.getElementById('resetViewBtn').addEventListener('click', resetMapView);
const savedTheme = store('rzbus.theme'); if(savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeBtn').addEventListener('click', ()=>{ const t=isDark()?'light':'dark'; document.documentElement.setAttribute('data-theme',t); store('rzbus.theme',t); setTiles(); });
document.getElementById('refreshBtn').addEventListener('click', ()=>tick(true));

/* ============================================================
   ROZKŁAD: kalendarz, indeksy, odjazdy
   ============================================================ */
GT.cal = new Map(); GT.calDates = new Map(); GT.samples = new Map(); GT.byStop = new Map(); GT.groups = new Map(); GT.stopGroupOf = new Map(); GT.tripsByRoute = new Map();
// One collator for every sort: localeCompare with options builds a new one on each call (10c: ~200 ms at start-up).
const NAT_COLLATOR=new Intl.Collator('pl',{numeric:true, sensitivity:'base'}), PL_COLLATOR=new Intl.Collator('pl');
const natSort = (a,b)=>NAT_COLLATOR.compare(String(a),String(b));
function dayInfo(offset){ // offset dni względem dziś (Warszawa)
  const p=zparts(nowSec()); const base0=midnightEpoch(p.year,p.month,p.day);
  const q=zparts(base0 + 12*3600 + offset*86400);
  const base=midnightEpoch(q.year,q.month,q.day);
  const ymd=`${q.year}${String(q.month).padStart(2,'0')}${String(q.day).padStart(2,'0')}`;
  const wd=(new Date(Date.UTC(q.year,q.month-1,q.day)).getUTCDay()+6)%7;
  return {base, ymd, wd, offset};
}
const svcCache=new Map();
/* Gdy przewoźnik nie opublikował jeszcze rozkładu, przyjmujemy ostatni zwykły taki sam dzień tygodnia. */
const SAMPLE_WEEKS=5, WEEKDAY_NAMES=['poniedziałek','wtorek','środę','czwartek','piątek','sobotę','niedzielę'];
const agencyOfService=sid=>sid.startsWith('pks:')?'pks':'ztm';
function publishedService(sid, ymd, wd){
  const e=GT.calDates.get(sid)?.get(ymd);
  if(e===1) return true;
  if(e===2) return false;
  const c=GT.cal.get(sid);
  return !!(c && c.days[wd] && ymd>=c.start && ymd<=c.end);
}
function publishedUntil(agency){
  const key='end|'+agency; if(GT.samples.has(key)) return GT.samples.get(key);
  let end='';
  for(const [sid,dates] of GT.calDates) if(agencyOfService(sid)===agency) for(const [date,type] of dates) if(type===1 && date>end) end=date;
  for(const [sid,c] of GT.cal) if(agencyOfService(sid)===agency && c.end>end) end=c.end;
  GT.samples.set(key,end); return end;
}
function tripsPerService(){
  if(!GT.samples.has('trips')){ const count=new Map(); for(const t of GT.trips.values()) count.set(t.service,(count.get(t.service)||0)+1); GT.samples.set('trips',count); }
  return GT.samples.get('trips');
}
// Święta mają mniej kursów, więc z ostatnich tygodni bierzemy ten dzień, w którym jeździ najwięcej.
function sampleDay(agency, day){
  const end=publishedUntil(agency); if(!end || day.ymd<=end) return null;
  const key=agency+'|'+day.wd; if(GT.samples.has(key)) return GT.samples.get(key);
  const last=Date.UTC(+end.slice(0,4),+end.slice(4,6)-1,+end.slice(6,8)); let best=null, most=-1;
  for(let back=0; back<SAMPLE_WEEKS*7; back++){
    const date=new Date(last-back*86400000), wd=(date.getUTCDay()+6)%7; if(wd!==day.wd) continue;
    const ymd=date.toISOString().slice(0,10).replace(/-/g,''); let trips=0;
    for(const [sid,n] of tripsPerService()) if(agencyOfService(sid)===agency && publishedService(sid,ymd,wd)) trips+=n;
    if(trips>=most){ most=trips; best={ymd, wd}; } // przy remisie starszy dzień, dalej od końca roku i świąt
  }
  GT.samples.set(key,best); return best;
}
function serviceOn(sid, day){
  if(!GT.cal.size && !GT.calDates.size) return true;
  const k=sid+'|'+day.ymd; if(svcCache.has(k)) return svcCache.get(k);
  const sample=sampleDay(agencyOfService(sid), day), r=publishedService(sid, sample?sample.ymd:day.ymd, sample?sample.wd:day.wd);
  svcCache.set(k,r); return r;
}
function estimatedAgencies(day){ return ['ztm','pks'].filter(agency=>sampleDay(agency,day)); }
function estimateNote(agencies, day){
  const names=agencies.map(agency=>agency==='pks'?'Komunikacja podmiejska':'ZTM').join(' i ');
  return `<div class="trip-estimate"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${names}: rozkład na ${day.ymd.slice(6,8)}.${day.ymd.slice(4,6)} nie został jeszcze opublikowany. Ten plan opiera się na ostatnim rozkładzie na ${WEEKDAY_NAMES[day.wd]} i może być niedokładny.</div>`;
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
  hint.textContent='';
}
function dirKey(t){ return (t.dir!=null && t.dir!=='') ? 'd'+t.dir : 'h'+(t.headsign||''); }
function onStaticReady(){
  GT.byStop=new Map(); GT.groups=new Map(); GT.stopGroupOf=new Map(); GT.tripsByRoute=new Map(); GT.nearGroups=new Map(); GT.samples=new Map(); svcCache.clear();
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
  renderLinesGrid(); renderLineNotice(); if(S.plan) runPlan(false); renderTimetable(); if(S.sub==='ulubione') renderFavorites();
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
// Numery kursów powtarzają się co dzień, a dane na żywo dotyczą tylko najbliższego przejazdu.
const LIVE_WINDOW_SEC=12*3600;
function liveFor(tid, st, idx, base){
  const sched = base + st[idx].dep, seq = st[idx].seq;
  if(Math.abs(sched-nowSec())>LIVE_WINDOW_SEC) return {state:'sched', delay:null, pred:sched};
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
  if(!q || S.agency==='kolej'){ el.classList.add('d-none'); return; }
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
    // Kafelek to przycisk linii i obok niego gwiazdka (dwa osobne przyciski, nie jeden w drugim).
    return `<div class="line-tile ${n?'':'off'} ${r.agency==='pks'?'is-pks':''}"><button type="button" class="lt-open" data-route="${esc(r.id)}"><span class="lt-num" style="${n?`background:${lineColor(r.short,r.color,r.agency)}`:''}">${esc(r.short)}</span>
      <span class="lt-meta">${n?`${n} w trasie`:(feedDown()?'brak danych':'nie kursuje')}${l?` · <span class="txt-red">${l} spóźn.</span>`:''}</span></button>${lineStar(r.id)}</div>`; };
  const groups=[['ztm','ZTM Rzeszów — komunikacja miejska'],['pks','Komunikacja podmiejska']].filter(([ag])=>S.agency==='all'||S.agency==='kolej'||S.agency===ag);
  renderPksDestinations();
  el.innerHTML = groups.map(([ag,title])=>{ const rs=[...GT.routes.values()].filter(r=>(r.agency||'ztm')===ag).sort((a,b)=>natSort(a.short,b.short)); if(!rs.length) return ag==='pks'?`<div class="lg-head">${title}</div><div class="empty-note" style="grid-column:1/-1">Rozkład PKS nie jest wczytany — sprawdź adres w Ustawieniach.</div>`:''; return `<div class="lg-head">${title} <span>${rs.length} linii</span></div>`+rs.map(tile).join(''); }).join('');
}
document.getElementById('linesGrid').addEventListener('click', e=>{ const b=e.target.closest('[data-route]'); if(b) openLine(b.dataset.route); });
/* ---------- PKS: miejscowości z nazw linii, np. „Rzeszów D.A. - Boguchwała - Niebylec” ---------- */
function pksDestinations(routes){
  const towns=new Map();
  for(const r of routes){
    if(r.agency!=='pks') continue;
    for(const part of String(r.long||'').split(/\s+-\s+/)){
      const name=part.split(',')[0].replace(/[()]/g,'').replace(/\s+D\.\s?A\.?$/,'').trim();
      if(!name || /^Rzeszów\b/i.test(name)) continue;
      if(!towns.has(name)) towns.set(name,new Map());
      towns.get(name).set(r.id,r);
    }
  }
  return [...towns].map(([name,list])=>({name, routes:[...list.values()].sort((x,y)=>natSort(x.short,y.short))})).sort((x,y)=>natSort(x.name,y.name));
}
function renderPksDestinations(){
  if(S.agency!=='pks') return;
  const el=document.getElementById('pksDest'), info=document.getElementById('destInfo'), q=foldText(document.getElementById('destSearch').value.trim());
  const key=`${GT.loaded}|${GT.routes.size}|${q}`; if(el.dataset.key===key) return; el.dataset.key=key;
  if(!GT.loaded){ el.innerHTML=searching('Wczytuję rozkład komunikacji podmiejskiej…'); info.textContent=''; return; }
  const all=pksDestinations(GT.routes.values()), list=q?all.filter(d=>foldText(d.name).includes(q)):all;
  info.textContent=`${list.length} z ${all.length} miejscowości`;
  el.innerHTML=list.length?list.map(d=>`<div class="dest-card"><button type="button" class="dest-map" data-dest-map="${esc(d.name)}" title="Trasa do ${esc(d.name)} z przystankami"><i class="fa-solid fa-route" aria-hidden="true"></i> Trasa na mapie</button><button type="button" class="dest-name" data-dest="${esc(d.name)}"><b>${esc(d.name)}</b><span>Zaplanuj podróż <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span></button>
    <div class="dest-lines">${d.routes.map(r=>`<button type="button" class="leg-line" style="background:${lineColor(r.short,r.color,r.agency)}" data-route="${esc(r.id)}" title="${esc(r.long||'')}">${esc(r.short)}</button>`).join('')}</div></div>`).join('')
    : '<div class="empty-note">Żadna linia podmiejska nie dojeżdża do takiej miejscowości.</div>';
}
document.getElementById('destSearch').addEventListener('input', renderPksDestinations);
// Kierunek linii, który jedzie z Rzeszowa do danej miejscowości (jej przystanki zaczynają się od jej nazwy).
function townDirection(r, town){
  const t=foldText(town), score=d=>{
    const names=(GT.stopTimes.get(d.rep.id)||[]).map(s=>foldText(GT.stopGroupOf.get(s.stop)||''));
    const at=names.findIndex(n=>n.startsWith(t)), from=names.findIndex(n=>n.startsWith('rzeszow'));
    return at<0 ? 0 : from<0 || from<at ? 2 : 1;
  };
  return [...lineDirections(r.id)].sort((x,y)=>score(y)-score(x))[0]||null;
}
// Na mapie tylko trasy linii do tej miejscowości, ich przystanki i ich autobusy; przystanki w miejscowości są wyróżnione.
function showTownRoutes(town){
  const d=pksDestinations(GT.routes.values()).find(x=>x.name===town); if(!d) return;
  const t=foldText(town), layers=[], all=[];
  for(const r of d.routes){
    const dir=townDirection(r,town); if(!dir) continue;
    const st=GT.stopTimes.get(dir.rep.id)||[], stops=st.map(s=>GT.stops.get(s.stop)).filter(Boolean), color=lineColor(r.short,r.color,r.agency);
    const pts=(dir.rep.shape && GT.shapes.get(dir.rep.shape)) || stops.map(s=>[s.lat,s.lon]);
    layers.push(L.polyline(pts,{color:'#fff',weight:8,opacity:.85}), L.polyline(pts,{color,weight:4}).bindTooltip(`Linia ${r.short}: ${r.long||''}`,{className:'bus-tip',sticky:true}));
    for(const x of st){ const s=GT.stops.get(x.stop); if(!s) continue; const here=foldText(GT.stopGroupOf.get(x.stop)||s.name).startsWith(t);
      layers.push(L.circleMarker([s.lat,s.lon],here?{radius:6,color:'#DA291C',weight:2,fillColor:'#fff',fillOpacity:1}:{radius:3.5,color:'#000',weight:1.2,fillColor:'#fff',fillOpacity:1}).bindTooltip(`${esc(s.name)}${here?'':' · linia '+esc(r.short)}`,{className:'bus-tip',direction:'top'})); }
    all.push(...pts);
  }
  if(!all.length) return;
  clearRouteLayer(); S.query=''; document.getElementById('lineSearch').value='';
  S.lineSet=new Set(d.routes.map(r=>r.id));
  setMapOpen(true, L.latLngBounds(all));
  S.routeLayer=L.layerGroup(layers).addTo(map);
  document.getElementById('mapTitle').textContent=`Trasa do: ${town}`;
  renderMarkers(); renderLateList(); renderLineNotice();
}
document.getElementById('pksDest').addEventListener('click', e=>{
  const m=e.target.closest('[data-dest-map]'); if(m){ showTownRoutes(m.dataset.destMap); return; }
  const r=e.target.closest('[data-route]'); if(r){ openLine(r.dataset.route); return; }
  const d=e.target.closest('[data-dest]'); if(!d) return;
  setView('podroz', true); plTo.value=d.dataset.dest; window.scrollTo({top:0, behavior:'instant'});
  if(plFrom.value.trim()) document.getElementById('planForm').requestSubmit(); else plFrom.focus();
});

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
    <h4>${r.agency==='pks'?'Podmiejska · ':''}Linia ${esc(r.short)} ${lineStar(r.id)}</h4><div class="sub">${esc(r.long||'')}</div></div></div>`;
  const body=document.getElementById('lineBody');
  if(!d){ body.innerHTML='<div class="empty-note">'+stateIll(assetPaths.emptyTimetable)+'Brak kursów tej linii w rozkładzie.</div>'; return; }
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
  setMapOpen(true);
  const st=GT.stopTimes.get(d.rep.id)||[]; const color=lineColor(r.short,r.color,r.agency);
  let pts=d.rep.shape && GT.shapes.get(d.rep.shape); const stopPts=st.map(s=>GT.stops.get(s.stop)).filter(Boolean).map(s=>[s.lat,s.lon]);
  if(!pts) pts=stopPts;
  clearRouteLayer();
  S.routeLayer=L.layerGroup([L.polyline(pts,{color:'#fff',weight:9,opacity:.85}), L.polyline(pts,{color,weight:5}),
    ...st.map(s=>{ const p=GT.stops.get(s.stop); return p?L.circleMarker([p.lat,p.lon],{radius:4,color:'#000',weight:1.5,fillColor:'#fff',fillOpacity:1}).bindTooltip(p.name,{className:'bus-tip'}):null; }).filter(Boolean)]).addTo(map);
  S.lineSet=new Set([r.id]); S.query=''; document.getElementById('lineSearch').value=''; document.getElementById('mapTitle').textContent=`Linia ${r.short}`;
  renderMarkers(); renderLateList(); renderLineNotice();
  lineModal.hide(); if(pts.length>1) map.fitBounds(L.latLngBounds(pts),{padding:[30,30]});
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
// ZTM i PKS mają osobne przystanki, często po sąsiedzku, więc przesiadka może wymagać krótkiego spaceru.
function groupsNear(name){
  if(GT.nearGroups.has(name)) return GT.nearGroups.get(name);
  const g=GT.groups.get(name), near=[];
  for(const o of GT.groups.values()){
    if(o===g || Math.abs(o.lat-g.lat)>0.004 || Math.abs(o.lon-g.lon)>0.006) continue;
    const walk=Math.round(hav([g.lat,g.lon],[o.lat,o.lon])); if(walk<=TRANSFER_WALK_M) near.push({name:o.name, walk});
  }
  GT.nearGroups.set(name,near); return near;
}
function planTrips(origin, dest, atTs, allow=tripInView){
  const t0=performance.now();
  const day=Math.round((atTs-todayMidnight())/86400), days=[day-1,day,day+1];
  const fromNames=new Set(origin.names);
  const destIds=new Set(dest.names.flatMap(n=>GT.groups.get(n)?.ids||[]));
  const walkTo=sid=>walkSec(dest.walk.get(GT.stopGroupOf.get(sid)));
  const walkFrom=d=>walkSec(origin.walk.get(GT.stopGroupOf.get(d.st[d.idx].stop)));
  const destIdx=new Map(); for(const sid of destIds) for(const [tid,idx] of GT.byStop.get(sid)||[]){ let a=destIdx.get(tid); if(!a){a=[];destIdx.set(tid,a);} a.push(idx); }
  const firstDestAfter=(tid,i)=>{ const a=destIdx.get(tid); if(!a) return null; const st=GT.stopTimes.get(tid); let m=null, best=Infinity; for(const j of a) if(j>i){ const door=st[j].arr+walkTo(st[j].stop); if(door<best || (door===best && j<m)){ best=door; m=j; } } return m; };
  const deps=origin.names.flatMap(n=>departuresFrom(n, atTs-45*60, atTs+3*3600, allow, days)).map(d=>Object.assign(d,{L:liveFor(d.tid,d.st,d.idx,d.base)})).filter(d=>{ const w=walkFrom(d); return d.L.state!=='passed' && d.L.pred>=atTs+w-30 && (d.L.state!=='sched' || d.dep>=atTs+w-60); }).sort((a,b)=>a.L.pred-b.L.pred);
  const out=[]; const seen=new Set();
  const boards=bestBoardings(deps, walkFrom); // ten sam kurs z kilku przystanków: wsiadamy tam, skąd najpóźniej trzeba wyjść z domu
  for(const d of boards){ const j=firstDestAfter(d.tid,d.idx); if(j!=null) out.push({legs:[mkLeg(d,j,d.L)]}); }
  if(out.length<4){
    const served=new Set(); for(const tid of destIdx.keys()) for(const x of GT.stopTimes.get(tid)||[]) served.add(GT.stopGroupOf.get(x.stop)); // tylko tam warto szukać przesiadki
    for(const d of boards.slice(0,40)){
      if(performance.now()-t0>700) break;
      if(firstDestAfter(d.tid,d.idx)!=null) continue;
      const delay1 = d.L.delay||0; let best=null;
      for(let k=d.idx+1;k<d.st.length && k<=d.idx+40;k++){
        const X=GT.stopGroupOf.get(d.st[k].stop); if(!X||fromNames.has(X)) continue;
        const arr1=d.base+d.st[k].arr+Math.max(0,delay1);
        for(const {name:Y, walk} of [{name:X, walk:0}, ...groupsNear(X)]){
          if(!served.has(Y) || fromNames.has(Y)) continue;
          const ready=arr1+60+walk;
          const sec=departuresFrom(Y, ready, ready+45*60, (t,st2,i2)=> allow(t) && t.route!==d.t.route && firstDestAfter(t.id,i2)!=null, days);
          for(const s2 of sec){ const L2=liveFor(s2.tid,s2.st,s2.idx,s2.base); if(L2.state==='passed' || L2.pred < ready) continue;
            const j2=firstDestAfter(s2.tid,s2.idx); const arrive=s2.base+s2.st[j2].arr+(L2.delay||0);
            if(!best || arrive<best.arrive) best={arrive, legs:[mkLeg(d,k,d.L), mkLeg(s2,j2,L2)]}; break; }
        }
      }
      if(best){ const key=best.legs.map(l=>l.tid).join('>'); if(!seen.has(key)){ seen.add(key); out.push({legs:best.legs}); } }
    }
  }
  for(const o of out){
    const last=o.legs[o.legs.length-1]; o.dep=o.legs[0].predDep; o.arr=last.predArr;
    o.walkFromM=origin.walk.get(o.legs[0].from)||0; o.walkToM=dest.walk.get(last.to)||0; o.walkFrom=walkSec(o.walkFromM); o.walkTo=walkSec(o.walkToM);
  }
  const res=withoutWorse(out);
  for(const o of res) o.legs.forEach((l,k)=>{ l.lineColor=l.color; l.color=LEG_COLORS[k%LEG_COLORS.length]; });
  return res.sort((a,b)=>(a.arr+a.walkTo)-(b.arr+b.walkTo) || a.legs.length-b.legs.length).slice(0,7).sort((a,b)=>a.dep-b.dep);
}
// Kurs przejeżdża często obok kilku pobliskich przystanków: zostawiamy jedno wejście na kurs,
// to, przy którym wychodzi się z domu najpóźniej (przy remisie: krótszy spacer). Kolejność wg odjazdu.
function bestBoardings(deps, walkFrom){
  const best=new Map(), leave=d=>d.L.pred-walkFrom(d);
  for(const d of deps){ const cur=best.get(d.tid); if(!cur || leave(d)>leave(cur) || (leave(d)===leave(cur) && walkFrom(d)<walkFrom(cur))) best.set(d.tid,d); }
  return deps.filter(d=>best.get(d.tid)===d);
}
// Spacer: odległości w metrach, czas liczony tym samym tempem w planie i w opisie.
const WALK_MPS=1.25;
function walkSec(m){ return Math.round((m||0)/WALK_MPS); }
// Odrzucamy podróż, gdy inna wychodzi nie wcześniej, jest na miejscu nie później i ma nie więcej pojazdów,
// więc krótki spacer od bliższego przystanku wygrywa z dodatkową przesiadką.
function withoutWorse(list){
  const leave=o=>o.dep-o.walkFrom, door=o=>o.arr+o.walkTo;
  const beats=(p,o)=>leave(p)>=leave(o) && door(p)<=door(o) && p.legs.length<=o.legs.length && (leave(p)>leave(o) || door(p)<door(o) || p.legs.length<o.legs.length);
  return list.filter(o=>!list.some(p=>p!==o && beats(p,o)));
}
// Pociąg zostaje tylko wtedy, gdy żaden autobus i żaden inny pociąg (z nie większą liczbą przesiadek) nie jest lepszy od drzwi do drzwi.
function railWorthIt(rail, transit){
  const vehicles=r=>(r.access?r.access.legs.length:0)+railParts(r).length+(r.egress?r.egress.legs.length:0);
  const byBus=r=>transit.some(o=>o.dep-o.walkFrom>=r.leave && o.arr+o.walkTo<=r.doorArr);
  const byTrain=r=>rail.some(q=>q!==r && q.leave>=r.leave && q.doorArr<=r.doorArr && vehicles(q)<=vehicles(r) && (q.leave>r.leave || q.doorArr<r.doorArr || vehicles(q)<vehicles(r)));
  return rail.filter(r=>!byBus(r) && !byTrain(r));
}
function walkText(m){ if(m<20) return 'na miejscu'; return `${m>=1000?(m/1000).toFixed(1).replace('.',',')+' km':m+' m'} · ok. ${Math.max(1,Math.round(walkSec(m)/60))} min pieszo`; }
function walkStep(m, text){ return m ? `<div class="walk-step"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${text} <span class="text-soft">(${walkText(m)})</span></div>` : ''; }
// Kółko kręci się, dopóki szukamy.
function searching(text){ return `<div class="searching" role="status"><span class="spin" aria-hidden="true"></span><span>${esc(text)}</span></div>`; }
const HOME_STATION='Rzeszów Główny', RAIL_CHANGE_SEC=300, BUS_MS=7, TRANSFER_WALK_M=300, RAIL_ENOUGH_DIRECT=3;
const WALK_MAX_KM=3, RAIL_MIN_KM=5, FLIGHT_MIN_KM=350, WALK_ONLY_KM=1.2, WALK_KMH=5, WALK_FACTOR=1.3, ROAD_FACTOR=1.25, CAR_KMH=70, RAIL_WALK_M=1500;
const ALL_TRANSPORT=new Set(['bus','pks','train','plane','car']);
const AGENCY_NAMES={ztm:'Autobus', pks:'Autobus podmiejski'}, MODE_NAMES={walk:'Pieszo', rail:'Pociąg', flight:'Samolot', car:'Samochód'};
function transitName(o){ const kinds=new Set(o.legs.map(l=>l.agency==='pks'?'pks':'ztm')); return kinds.size>1?'Autobus miejski + podmiejski':kinds.has('pks')?AGENCY_NAMES.pks:'Autobus'; }
// Samochód jest opcją, gdy ma sens: krótką trasę przejdziesz pieszo, chyba że nie ma nic innego.
function tripModes(km, found, allowed=ALL_TRANSPORT){
  const modes=[];
  if(km!=null && km<=WALK_MAX_KM) modes.push('walk');
  if(found.transit) modes.push('transit');
  if(found.rail) modes.push('rail');
  if(found.flights) modes.push('flight');
  if(allowed.has('car') && (!modes.length || km==null || km>WALK_MAX_KM)) modes.push('car');
  return modes;
}
function returnStart(round, arrive){ return Math.max(round.at, arrive+RAIL_CHANGE_SEC); }
function bestMode(km, modes, arrival){
  if(modes.includes('flight')) return 'flight';
  if(modes.includes('walk') && km<=WALK_ONLY_KM) return 'walk';
  return modes.filter(m=>arrival[m]!=null).sort((a,b)=>arrival[a]-arrival[b])[0] || modes[0];
}
// Postój w minutach pokazany w największej pełnej jednostce: tygodnie, dni, godziny albo minuty.
function fmtStay(min){ return min>=10080&&min%10080===0?`${min/10080} tyg.`:min>=1440&&min%1440===0?`${min/1440} ${min/1440===1?'dzień':'dni'}`:min>=60&&min%60===0?`${min/60} godz.`:`${min} min`; }
function fmtKm(km){ return km<1 ? Math.round(km*1000)+' m' : (km<10?km.toFixed(1).replace('.',','):Math.round(km))+' km'; }
function fmtDuration(min){ const m=Math.max(1,Math.round(min)); return m<60 ? m+' min' : `${Math.floor(m/60)} godz. ${m%60} min`; }
function fmtDay(day){ return `${day.slice(8,10)}.${day.slice(5,7)}`; }
function walkMinutes(km){ return km*WALK_FACTOR/WALK_KMH*60; }
function routeButton(route){ S.planRoutes.push(route); return `<button class="btn-ghost" data-route="${S.planRoutes.length-1}">Na mapie</button>`; }
/* ---------- Podróż bez samolotu: krok 1 wybór połączenia (tam i ewentualnie powrót), krok 2 zapis ---------- */
// Kreator działa przy jednym etapie bez lotu; przy kilku etapach zostaje dawny zapis gwiazdką.
function groundWizard(P){ return !!P; } // także przy godzinie „na miejscu o”: wybór połączenia, zapis dopiero na końcu
function groundPicked(P, key, dir){ return groundWizard(P) && (dir==='back'?P.groundBack:P.groundPick)?.key===key; }
function groundPickBtn(P, kind, obj, key, dir, ends={}){
  if(!groundWizard(P)) return '';
  const on=groundPicked(P,key,dir), i=(S.groundOpts||(S.groundOpts=[])).push({kind, obj, key, dir, ends})-1;
  return `<button type="button" class="cs-pick pc-pick ${on?'on':''}" data-ground-pick="${i}" aria-pressed="${on}">${on?'<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Wybrano':`<i class="fa-regular fa-circle" aria-hidden="true"></i> ${dir==='back'?'Wybierz powrót':'Wybierz'}`}</button>`;
}
// Zapis połączenia w takiej postaci, jaką pokaże strona podróży (kroki, godziny, koszt), niezależnie od późniejszych danych.
function groundSnap(P, x){
  const {kind, obj, key, dir}=x, origin=x.ends.origin||(dir==='out'?P.origin:P.dest), dest=x.ends.dest||(dir==='out'?P.dest:(P.home||P.origin));
  let title, steps=[], leave=null, arrive=null, minutes=null, km=null, cost=null, icon;
  if(kind==='transit'){ title=`${transitName(obj)} ${obj.legs.map(l=>l.short).join(' › ')}`; steps=transitSteps(obj); leave=obj.dep-obj.walkFrom; arrive=obj.arr+obj.walkTo; const p=transitParts(obj); cost=(p.bus||0)+(p.pks||0)||null; icon=obj.legs.some(l=>l.agency==='pks')?'bus-simple':'bus'; }
  else if(kind==='train'){
    title=`${obj.access?transitName(obj.access)+' + pociąg':'Pociąg'} ${railParts(obj).map(p=>p.t.label).join(' › ')}`; steps=trainSteps(obj,origin,dest); leave=obj.leave; arrive=obj.doorArr; icon='train';
    const t=railFare(railParts(obj)); cost=t!=null?t+[obj.access,obj.egress].filter(Boolean).map(transitParts).reduce((a,p)=>a+(p.bus||0)+(p.pks||0),0):null;
  } else if(kind==='car'){
    const d=P.driving; km=d?d.km:P.km*ROAD_FACTOR; minutes=d?d.minutes:km/CAR_KMH*60; leave=dir==='back'?null:plainStart(P,minutes); arrive=leave!=null?leave+minutes*60:null; title='Samochód'; icon='car'; cost=fuelCost(km);
    steps=[withMap(step('car',`Jedź samochodem: ${origin?.label||P.from} → ${dest?.label||P.to}`,`${fmtKm(km)} · ok. ${fmtDuration(minutes)} · paliwo ok. ${fuelCost(km)} zł`),origin?.points?.[0]||P.origin.points[0],dest?.points?.[0]||P.dest.points[0])];
  } else {
    km=P.km*WALK_FACTOR; minutes=walkMinutes(P.km); leave=plainStart(P,minutes); arrive=leave!=null?leave+minutes*60:null; title='Pieszo'; icon='person-walking'; cost=0;
    steps=[step('person-walking',`Idź pieszo: ${P.from} → ${P.to}`,`ok. ${fmtKm(km)} · ${fmtDuration(minutes)}`)];
  }
  if(minutes==null && leave!=null && arrive!=null) minutes=(arrive-leave)/60;
  const day=leave!=null?dayOfTs(leave):(dir==='out'?P.date:P.round?.back)||ymdOf(0);
  const pt=x=>{ const p=x?.points?.[0]; const q=Array.isArray(p)?p:p?.lat!=null?[p.lat,p.lon]:null; return q?[Math.round(q[0]*1e4)/1e4, Math.round(q[1]*1e4)/1e4]:null; };
  return {key, kind, icon, title, day, leave, arrive, a:pt(origin), b:pt(dest), minutes:minutes!=null?Math.round(minutes):null, km:km!=null?Math.round(km*10)/10:null, cost:cost!=null?Math.round(cost*100)/100:null,
    from:origin?.label||(dir==='out'?P.from:P.to), to:dest?.label||(dir==='out'?P.to:P.from),
    steps:steps.slice(0,14).map(s=>({icon:s.icon, text:s.text, sub:s.sub||'', ...(s.note?{note:s.note}:{}), ...(s.link?.href&&s.link.href.length<=300?{link:{href:s.link.href, label:s.link.label||'Mapy Google'}}:{})}))};
}
const groundWhen=g=>`${fmtDay(g.day)}${g.leave!=null?' '+fmtClock(g.leave):''}${g.arrive!=null?' → '+fmtClock(g.arrive):''}`;
function groundStepBar(P){
  const J=S.plan, st=J?.stages||[P], cur=J?.groundStep||1, picked=st.filter(x=>x.groundPick).length;
  const info=[st.length>1?`wybrano ${picked} z ${st.length} etapów`:P.groundPick?`${P.groundPick.title} · ${groundWhen(P.groundPick)}`:'', st[0].saved?'zapisano':''];
  const steps=[['Połączenie'],['Zapisz podróż']].map(([name],i)=>({label:name, info:info[i], enabled:i===1&&picked>=st.length}));
  return `<div class="fl-stepbar">${PVUI.stepper(steps, cur, {attr:'data-ground-step'})}</div>`;
}
// Pasek pod wynikami: co wybrano i „Dalej”.
function groundNext(P){
  const J=S.plan, st=J?.stages||[P];
  if(st.length>1){
    const picked=st.filter(x=>x.groundPick).length, all=picked===st.length;
    return `<div class="ground-next ${all?'ready':''}"><span>${all?'<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Wybrano połączenia na wszystkich etapach.':`<i class="fa-regular fa-hand-pointer" aria-hidden="true"></i> Wybierz połączenie na każdym etapie (${picked} z ${st.length}): ${st.map((x,k)=>`<b class="${x.groundPick?'ok':''}">${k+1}. ${esc(x.to)}</b>`).join(' · ')}`}</span>${all?`<button type="button" class="btn-grad btn-next" data-ground-step="2">Dalej: zapisz podróż <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`:''}</div>`;
  }
  const g=P.groundPick, b=P.groundBack;
  if(!g) return '';
  return `<div class="ground-next ready"><span><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Wybrano: <b>${esc(g.title)}</b> · ${esc(groundWhen(g))}${b?` · powrót: <b>${esc(b.title)}</b> ${esc(groundWhen(b))}`:P.round?' · powrót możesz wybrać poniżej':''}</span><button type="button" class="btn-grad btn-next" data-ground-step="2">Dalej: zapisz podróż <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>`;
}
function groundLegCard(g, label){
  return `<div class="journey-box ground-leg"><div class="jl-head"><h4 class="trip-title"><i class="fa-solid fa-${esc(g.icon)}" aria-hidden="true"></i> ${label}: ${esc(g.title)}</h4></div>
    <small class="text-soft">${esc(g.from)} → ${esc(g.to)} · ${longDay(g.day,{weekday:'short', day:'numeric', month:'long'})}${g.leave!=null?` · ${fmtClock(g.leave)} → ${g.arrive!=null?fmtClock(g.arrive):'—'}`:''}${g.minutes?` · ${fmtDuration(g.minutes)}`:''}${g.km?` · ${fmtKm(g.km)}`:''}${g.cost!=null?` · ok. ${zl(g.cost)}`:''}</small>${stepsHtml(g.steps||[])}</div>`;
}
// Pole na przyjazną nazwę podróży: zapamiętane między odświeżeniami, przy edycji podpowiada dotychczasową nazwę.
function tripTitleField(P){
  const edited=S.editing?.tid?FAV.items.find(x=>x.type==='trip'&&x.tid===S.editing.tid):null;
  const value=P.tripTitle ?? (edited?.title||'');
  return `<label class="trip-title-field"><span><i class="fa-solid fa-pen" aria-hidden="true"></i> Nazwa podróży <small>(opcjonalnie)</small></span><input type="text" maxlength="80" data-trip-title value="${esc(value)}" placeholder="np. Wakacje w ${esc(P.to||'')}"></label>`;
}
// Po zapisie: link do zapisanej podróży i „Zakończ”, które czyści planer i wraca na stronę „Planuj”.
// Zapis to nie rezerwacja (Phase 3c): pod przyciskami zapisu jedno zdanie, że bilety i nocleg kupuje się u przewoźnika
// i na Booking.com, a nocleg nie jest potrzebny do zapisania. Po zapisie główny przycisk to „Zakończ”, a „Zapisz” staje się zwykły.
const SAVE_NOTE='<p class="cs-save-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Zapisanie nie rezerwuje biletów ani noclegu: kupujesz je u przewoźnika i na Booking.com. Nocleg możesz dodać teraz, później albo wcale.</p>';
const saveCls=P=>savedNote(P)?'btn-ghost':'btn-grad';
function savedNote(P){
  const saved=P.saved && FAV.items.find(x=>x.type==='trip' && x.tid===P.saved);
  return saved?`<div class="cs-saved" role="status">${P.savedOk===saved.tid?stateIll(assetPaths.tripSaved,200,117):''}<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${saved.status==='booked'?'Zapisano w „Moje podróże”.':'Zapisano w ulubionych jako plan.'} <a href="/trip?id=${esc(saved.tid)}" data-trip-open="${esc(saved.tid)}">Zobacz podróż <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a><button type="button" class="btn-grad cs-finish" data-plan-finish><i class="fa-solid fa-flag-checkered" aria-hidden="true"></i> Zakończ</button></div>`:'';
}
function groundSaveAll(J){
  const st=J.stages, P0=st[0], n=Math.max(1,P0.people||1), multi=st.length>1, legs=st.map(P=>P.groundPick), back=multi?null:P0.groundBack;
  const all=[...legs, back].filter(Boolean), total=all.reduce((a,x)=>a+(x.kind==='car'?(x.cost||0):(x.cost||0)*n),0), unknown=all.some(x=>x.cost==null);
  const cards=legs.map((g,k)=>groundLegCard(g, multi?`Etap ${k+1}`:'Tam')+(multi&&k<st.length-1&&st[k].stay?`<div class="trip-stop-note"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(st[k].to)}: postój ${fmtStay(st[k].stay)}</div>`:'')).join('')+(back?groundLegCard(back,'Powrót'):!multi&&P0.round?'<div class="empty-note tp-noreturn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Nie wybrano powrotu — możesz zapisać podróż bez niego albo wrócić i wybrać połączenie powrotne.</div>':'');
  return `<div class="plan-head"><span>${[P0.from, ...st.map(P=>P.to)].map(esc).join(' <span class="txt-red">→</span> ')}</span></div>`+groundStepBar(P0)+cards+(S.multi&&S.multi.cur!=='save'?multiLegBar(P0,'ground'):
    `<div class="cs-save"><div class="cs-choice"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Zapisz plan w ulubionych albo jako swoją podróż.${all.length?` <small>Koszt: ${unknown?'od ':'ok. '}${zl(total)}${n>1?` za ${peopleText(n)}`:''}</small>`:''}</div>
      ${planStayBox('ground',P0,{stages:st})}
      ${tripTitleField(P0)}
      <div class="cs-save-btns"><button type="button" class="btn-ghost" data-ground-save="planned"><i class="fa-regular fa-bookmark" aria-hidden="true"></i> Zapisz w ulubionych</button>
      <button type="button" class="${saveCls(P0)}" data-ground-save="booked"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> Zapisz moją podróż</button></div>${SAVE_NOTE}${savedNote(P0)}</div>`)+
    `<div class="fl-nav"><button type="button" class="btn-ghost" data-ground-step="1"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Wstecz</button><span></span></div>`;
}
function saveGroundTrip(J, status, title){
  const st=J.stages, P0=st[0], last=st[st.length-1], legs=st.map(P=>P.groundPick); if(legs.some(x=>!x)) return;
  const back=st.length===1?P0.groundBack:null, id='g:'+legs.map(g=>`${g.key}@${g.day}`).join('>')+(back?'|'+back.key:'');
  const before=FAV.items.find(x=>x.type==='trip' && (x.id===id || (S.editing?.tid && x.tid===S.editing.tid)));
  const pt=x=>{ const p=x?.points?.[0]; const q=Array.isArray(p)?p:p?.lat!=null?[p.lat,p.lon]:null; return q?{lat:Math.round(q[0]*1e4)/1e4, lon:Math.round(q[1]*1e4)/1e4}:{lat:null, lon:null}; };
  const home={label:P0.from, ...pt(P0.origin)}, dest={label:last.to, ...pt(last.dest)};
  const stops=st.slice(0,-1).map(P=>({label:P.to, ...pt(P.dest), stay:P.stay||0}));
  const wx=(icon,label,place,p,day,ts)=>p.lat!=null&&day?[{icon,label,place,lat:p.lat,lon:p.lon,day,time:ts!=null?fmtClock(ts):''}]:[];
  const arrDay=g=>g.arrive!=null?dayOfTs(g.arrive):g.day;
  const weather=[...wx('house','Start',P0.from,home,legs[0].day,legs[0].leave),
    ...stops.flatMap((x,k)=>wx('location-dot',x.label,x.label,x,arrDay(legs[k]),legs[k].arrive)),
    ...wx('location-dot','Na miejscu',last.to,dest,arrDay(legs[legs.length-1]),legs[legs.length-1].arrive), ...(back?wx('rotate-left','Powrót',last.to,dest,back.day,back.leave):[])];
  const item={type:'trip', view:'podroz', id, tid:before?.tid||newTid(), status, from:P0.from, to:last.to, ...(stops.length?{stops:stops.map(x=>x.label)}:{}), title:(title||'').trim().slice(0,80),
    name:legs.map(g=>g.title).join(' + ').slice(0,120), detail:`${groundWhen(legs[0])}${legs.length>1?` · ${legs.length} etapy`:''}${back?` · powrót ${fmtDay(back.day)}`:''}`,
    trip:{ground:{out:legs[0], legs, back:back||null, roundBack:last.round?.back||null}, home, dest, stops, people:Math.max(1,P0.people||1), weather, savedAt:new Date().toISOString(), ...stayForTrip('ground',P0,{stages:st},before)}};
  FAV.items=[...FAV.items.filter(x=>!(x.type==='trip' && (x.id===id || (before && x.tid===before.tid)))), item].slice(-50);
  P0.savedOk=null;
  saveFavorites().then(ok=>{ if(ok!==false && P0.saved===item.tid){ P0.savedOk=item.tid; runPlan(false); } }).catch(e=>console.warn('Nie zapisano podróży', e));
  P0.saved=item.tid; renderFavorites(); syncStars(); runPlan(false); navCounts();
  S.editing=null; renderEditBadge();
  toast(status==='booked'?'Zapisano w „Moje podróże”.':'Zapisano plan w ulubionych.');
  finishSaved(item.tid);
}
// Trasa z miejscami pośrednimi: „Rzeszów → Szczecin → Gdańsk → Wrocław”.
const routeText=f=>[f.from, ...(f.stops||[]), f.to].join(' → ');
function saveTrip(P, id, name, detail, flight, plan){ return favButton({type:'trip', view:'podroz', id, from:P.from, to:P.to, name, detail, ...(flight?{flight}:{}), ...(plan?{plan}:{})}, 'Zapisz podróż'); }
// Edycja zapisanego planu: powrót do wybranego kroku (loty, dojazd) albo do dat i miejsc w wyszukiwarce.
function planEditMenu(){
  return `<details class="plan-edit"><summary class="btn-ghost"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edytuj</summary><div class="plan-edit-menu">
    <button type="button" data-flight-step="1"><i class="fa-solid fa-plane" aria-hidden="true"></i> Zmień loty</button>
    <button type="button" data-flight-step="2"><i class="fa-solid fa-route" aria-hidden="true"></i> Zmień dojazd na lotnisko</button>
    <button type="button" data-flight-step="3"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> Zmień dojazd do centrum</button>
    <button type="button" data-edit-search><i class="fa-solid fa-calendar-days" aria-hidden="true"></i> Zmień daty lub miejsca</button></div></details>`;
}
const tripFlight=f=>f&&!f.placeholder?{from:f.from, to:f.to, day:f.day, back:f.ret?.day||'', airline:f.airline, price:fareTotal(f)}:null;
// Karta to najpierw sama sekwencja środków transportu, a szczegóły rozwija się na życzenie.
const seqWalk=sec=>sec?`<span class="seq-walk"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${Math.max(1,Math.round(sec/60))} min</span>`:'';
const seqLeg=l=>`<span class="leg-line" style="background:${l.color}">${esc(l.short)}</span>`;
const seqRide='<span class="seq-walk">dojazd</span>';
function seqHtml(parts){ return parts.filter(Boolean).join('<span class="pc-arrow">›</span>'); }
function transitSeq(o){ return [seqWalk(o.walkFrom), ...o.legs.map(seqLeg), seqWalk(o.walkTo)]; }
function toggleCard(button, opened){
  const open=button.closest('.plan-card').classList.toggle('open');
  if(open) opened.add(button.dataset.expand); else opened.delete(button.dataset.expand);
  button.setAttribute('aria-expanded',String(open)); button.textContent=open?'Zwiń ▲':'Rozwiń ▼';
}
// Godzina odjazdu i przyjazdu z linią czasu pośrodku, jak w wyszukiwarkach lotów.
function changesText(n){ return !n?'bez przesiadek':n===1?'1 przesiadka':n<5?`${n} przesiadki`:`${n} przesiadek`; }
function tripRow(dep, from, arr, to, changes, leave, door, late){
  return `<div class="pc-trip">
    <div class="pc-end"><b class="${late?'txt-red':''}">${fmtClock(dep)}</b><span>${esc(from)}</span>${leave<dep?`<small>wyjdź ${fmtClock(leave)}</small>`:''}</div>
    <div class="pc-span"><span>${fmtDuration((door-leave)/60)}</span><i class="pc-track">${'<em></em>'.repeat(Math.min(changes,3))}</i><span class="${changes?'txt-red':''}">${changesText(changes)}</span></div>
    <div class="pc-end pc-end-to"><b>${fmtClock(arr)}</b><span>${esc(to)}</span>${door>arr?`<small>na miejscu ${fmtClock(door)}</small>`:''}</div></div>`;
}
function cardData(kinds, leave, door, changes){ return `data-kind="${[...new Set(kinds)].join(' ')}" data-leave="${leave}" data-arrive="${door}" data-changes="${changes}"`; }
function leaveBox(dep){ return `<div class="pc-box"><small>odjazd</small><b>${dep-nowSec()>12*3600?fmtDay(dayOfTs(dep))+' '+fmtClock(dep):inMin(dep)}</b></div>`; }
function cardToggle(P, key){ const open=P.open.has(key); return `<button class="btn-ghost" type="button" data-expand="${esc(key)}" aria-expanded="${open}">${open?'Zwiń ▲':'Rozwiń ▼'}</button>`; }
function transitCard(o, P, origin=P.origin, dest=P.dest){
  const l0=o.legs[0], last=o.legs[o.legs.length-1], key='t:'+o.legs.map(l=>l.tid).join('>'), dur=Math.round((o.arr-o.dep)/60), changes=o.legs.length-1;
  const legsH=o.legs.map((l,k)=>`<div class="leg">
      <span class="leg-line" style="background:${l.color}">${esc(l.short)}</span>${lineStar(l.t.route)}
      <div class="leg-body"><div><b>${fmtClock(l.predDep)}</b> ${esc(l.from)} <span class="text-soft">→</span> <b>${fmtClock(l.predArr)}</b> ${esc(l.to)}</div>
      <div class="leg-meta">${esc(AGENCY_NAMES[l.agency]||'Autobus')} · kierunek ${esc(l.head)} · ${l.j-l.i} przyst.${l.predDep!==l.dep?` · rozkł. ${fmtClock(l.dep)}`:''} ${liveChip(l.L)}</div></div></div>${k<o.legs.length-1?`<div class="transfer">↳ przesiadka: ${esc(l.to)}${o.legs[k+1].from!==l.to?' → '+esc(o.legs[k+1].from):''} · ${Math.max(0,Math.round((o.legs[k+1].predDep-l.predArr)/60))} min na przesiadkę</div>`:''}`).join('');
  const dir=dest===P.dest?'out':'back';
  return `<div class="plan-card res-card ${P.open.has(key)?'open':''} ${groundPicked(P,key,dir)?'picked':''}" ${cardData(o.legs.map(l=>l.agency==='pks'?'pks':'bus'), o.dep-o.walkFrom, o.arr+o.walkTo, changes)}>
    <div class="pc-main">
      <div class="pc-badges"></div>
      ${tripRow(o.dep, l0.from, o.arr, last.to, changes, o.dep-o.walkFrom, o.arr+o.walkTo, l0.L&&l0.L.delay!=null&&statusOf(l0.L.delay)==='late')}
      <div class="pc-lines">${seqHtml(transitSeq(o))}</div>
      ${fareLine(o)}
      <div class="pc-detail">
        <div class="pc-status">${liveChip(l0.L)}${l0.L&&l0.L.v?` <span class="text-soft small">pojazd ${esc(l0.L.v.label)}${l0.L.v.stopName?' · teraz: '+esc(l0.L.v.stopName):''}</span>`:''}</div>
        <div class="pc-legs">${walkStep(o.walkFromM,`Idź na przystanek ${esc(l0.from)}`)}${legsH}${walkStep(o.walkToM,`Z przystanku ${esc(last.to)} dojdź do celu`)}</div>
      </div>
    </div>
    <div class="pc-actions">${leaveBox(o.dep)}${groundPickBtn(P,'transit',o,key,dir)}${cardToggle(P,key)}<div class="pc-detail pc-buttons">${routeButton({kind:'transit',o,origin,dest})}${l0.L&&l0.L.v?`<button class="btn-ghost" data-bus="${esc(l0.L.v.id)}">Autobus</button>`:''}</div></div>
  </div>`;
}
// Pociągi tej podróży: jeden przy połączeniu bezpośrednim, więcej przy przesiadkach.
function railParts(r){ return r.parts||[r]; }
// Cała podróż w jednym ciągu: dojście lub autobus na stację, pociąg, dalsza droga do celu.
function trainSteps(r, origin, dest){
  const {from,to,walkFrom,walkTo,access,egress,startDist}=r, steps=[];
  if(access) steps.push(...transitSteps(access,`na stację ${from}`));
  else if(walkFrom) steps.push(step('person-walking',`Idź na stację ${from}`,walkText(walkFrom)));
  else if(startDist>RAIL_WALK_M || (startDist==null && isStreet(origin))) steps.push(step('bus',`Dojedź na stację ${from}`,startDist?`ok. ${fmtKm(startDist/1000)}`:''));
  railParts(r).forEach((p,k,parts)=>{
    const carrier=TR.carriers.get(p.t.carrier), start=railName(p.a.id), end=railName(p.b.id);
    if(k) steps.push(step('shuffle',`Przesiadka: ${start}`,`${Math.round((p.dep-parts[k-1].arr)/60)} min na przesiadkę`));
    steps.push(Object.assign(step('train',`Pociąg ${p.t.label}${p.t.name?' „'+p.t.name+'”':''}: ${start} → ${end}`,`odjazd ${fmtClock(p.dep)}${p.a.pl?' z peronu '+p.a.pl:''} · wysiądź ${fmtClock(p.arr)}${p.b.pl?' na peronie '+p.b.pl:''}${carrier?' · '+carrier:''}`),{note:proxyNote(p.t)}));
  });
  if(egress) steps.push(...transitSteps(egress));
  else if(walkTo>RAIL_WALK_M || (!walkTo && isStreet(dest))) steps.push(step('bus',`Ze stacji ${to} dojedź do celu: ${dest.label}`,walkTo?`ok. ${fmtKm(walkTo/1000)}`:''));
  else if(walkTo) steps.push(step('person-walking',`Ze stacji ${to} dojdź do celu`,walkText(walkTo)));
  return steps;
}
function trainSeq(r, origin, dest){
  const {walkFrom,walkTo,access,egress,startDist}=r, chips=railParts(r).map(railChip);
  const before=access ? transitSeq(access) : [seqWalk(walkFrom) || (startDist>RAIL_WALK_M || (startDist==null && isStreet(origin)) ? seqRide : '')];
  const after=egress ? transitSeq(egress) : [walkTo>RAIL_WALK_M || (!walkTo && isStreet(dest)) ? seqRide : seqWalk(walkTo)];
  return [...before, ...chips, ...after];
}
function trainCard(r, P, origin, dest){
  const {t,a,dep,from,to,access,egress,doorArr,leave}=r, label=access?`${transitName(access)} + pociąg`:'Pociąg', start=access?access.dep:dep, key='r:'+railParts(r).map(p=>p.t.key).join('>')+':'+from+':'+to;
  const bus=o=>o?o.legs.map(l=>l.agency==='pks'?'pks':'bus'):[], vehicles=bus(access).length+railParts(r).length+bus(egress).length;
  const startName=access?access.legs[0].from:from, end=egress?egress.arr:r.arr, endName=egress?egress.legs[egress.legs.length-1].to:to;
  const dir=dest===P.dest?'out':'back';
  return `<div class="plan-card res-card ${P.open.has(key)?'open':''} ${groundPicked(P,key,dir)?'picked':''}" ${cardData([...bus(access),'train',...bus(egress)], leave, doorArr, vehicles-1)}>
    <div class="pc-main">
      <div class="pc-badges"></div>
      ${tripRow(start, startName, end, endName, vehicles-1, leave, doorArr, a.delay!=null&&statusOf(a.delay*60)==='late')}
      <div class="pc-lines">${seqHtml(trainSeq(r,origin,dest))}${r.showStations?`<span class="pc-sum">${esc(from)} → ${esc(to)}</span>`:''}</div>
      ${trainFareLine(r)}
      <div class="pc-detail">
        <div class="pc-status">${trainDelayChip(a.delay,false)} ${trainStar(t)}</div>
        <div class="pc-legs">${stepsHtml(trainSteps(r,origin,dest))}</div>
      </div>
    </div>
    <div class="pc-actions">${leaveBox(start)}${groundPickBtn(P,'train',r,key,dir,{origin,dest})}${cardToggle(P,key)}<div class="pc-detail pc-buttons">${routeButton({kind:'train',r,origin,dest})}${TR.trains.includes(t)?`<button class="btn-ghost" data-train="${esc(t.key)}">Szczegóły</button>`:''}</div></div>
  </div>`;
}
// Pieszo i samochodem wyglądają jak pozostałe wyniki: trasa po lewej, koszt i przyciski po prawej.
function plainTrip(dep, P, min, middle, fromLabel=P.from||P.origin.label, toLabel=P.to||P.dest.label){
  const arr=dep!=null?dep+min*60:null;
  return `<div class="pc-trip">
    <div class="pc-end"><b>${dep!=null?fmtClock(dep):'—'}</b><span>${esc(fromLabel)}</span></div>
    <div class="pc-span"><span>${fmtDuration(min)}</span><i class="pc-track"></i><span>${middle}</span></div>
    <div class="pc-end pc-end-to"><b>${arr!=null?fmtClock(arr):'—'}</b><span>${esc(toLabel)}</span></div></div>`;
}
const plainStart=(P,min)=>P.by?P.by-min*60:(P.at??(P.date?null:nowSec()));
function walkCard(P){
  const min=walkMinutes(P.km), km=P.km*WALK_FACTOR;
  return `<div class="plan-card res-like open ${groundPicked(P,'walk','out')?'picked':''}">
    <div class="pc-main">
      ${plainTrip(plainStart(P,min), P, min, `ok. ${fmtKm(km)}`)}
      <div class="pc-lines"><span class="leg-line" style="background:${MODE_COLOR.walk}"><i class="fa-solid fa-person-walking" aria-hidden="true"></i></span><span class="pc-sum">Pieszo · czas szacunkowy</span></div>
    </div>
    <div class="pc-actions"><div class="pc-box"><small>koszt</small><b>0 zł</b></div>${routeButton({kind:'walk',origin:P.origin,dest:P.dest,sub:`ok. ${fmtKm(km)} · ${fmtDuration(min)}`})}${groundPickBtn(P,'walk',null,'walk','out')}</div>
  </div>`;
}
// Samochód tam albo z powrotem (dir 'back': z celu do domu, wyjazd o dowolnej porze dnia powrotu).
function carCard(P, dir='out'){
  const d=P.driving, km=d?d.km:(P.km==null?null:P.km*ROAD_FACTOR), min=d?d.minutes:(km==null?null:km/CAR_KMH*60);
  if(km==null) return '<div class="empty-note">Nie udało się ustalić odległości między tymi miejscami.</div>';
  const back=dir==='back', origin=back?P.dest:P.origin, dest=back?(P.home||P.origin):P.dest;
  return `<div class="plan-card res-like open ${groundPicked(P,'car',dir)?'picked':''}">
    <div class="pc-main">
      ${plainTrip(back?null:plainStart(P,min), P, min, `${fmtKm(km)}${d?'':' · szacunkowo'}`, origin.label, dest.label)}
      <div class="pc-lines">${seqIcon('car',MODE_COLOR.car)}<span class="pc-sum">Samochód · ${esc(fuelNote())}${back?' · wyjazd o dowolnej porze':''}</span></div>
    </div>
    <div class="pc-actions"><div class="pc-box"><small>paliwo</small><b>ok. ${fuelCost(km)} zł</b></div>${gmapsButton(origin.points[0],dest.points[0])}${routeButton({kind:'car',origin,dest,sub:`${fmtKm(km)} · ok. ${fmtDuration(min)}`})}${groundPickBtn(P,'car',null,'car',dir,{origin,dest})}</div>
  </div>`;
}
/* ---------- Kolory środków transportu, koszty dojazdu i nawigacja ---------- */
const MODE_COLOR={walk:'#16A34A', bus:'#E11D48', pks:'#0F766E', train:'#7C3AED', plane:'#0284C7', car:'#EA580C', other:'#64748B'};
const STEP_COLOR={'person-walking':MODE_COLOR.walk, bus:MODE_COLOR.bus, 'bus-simple':MODE_COLOR.pks, train:MODE_COLOR.train, 'plane-departure':MODE_COLOR.plane, 'plane-arrival':MODE_COLOR.plane, passport:MODE_COLOR.plane, car:MODE_COLOR.car, shuffle:MODE_COLOR.other, 'flag-checkered':'#0B1A33', house:'#0B1A33'};
// Średnie spalanie auta osobowego; cenę paliwa podaje serwer (domyślnie cena maksymalna Ministerstwa Energii).
const CAR_L_PER_100=7;
const FUEL={pb95:6.04, date:'', source:''};
fetch('/api/fuel').then(r=>r.ok?r.json():null).then(j=>{ if(j?.pb95) Object.assign(FUEL,j); }).catch(e=>console.warn('Ceny paliw', e));
function fuelCost(km){ return Math.round(km*CAR_L_PER_100/100*FUEL.pb95); }
function fuelNote(){ return `${CAR_L_PER_100} l/100 km · Pb95 ${FUEL.pb95.toFixed(2).replace('.',',')} zł/l${FUEL.source?' · '+FUEL.source:''}${FUEL.date?' · '+fmtDay(FUEL.date):''}`; }
// Przewoźnicy kolejowi nie udostępniają cen, więc bilet szacujemy z odległości: dalekobieżne drożej niż regionalne.
const IC_CATS=new Set(['IC','TLK','EIC','EIP','EC','EN','ICC','IC/TLK']);
function railPoint(id){ return RAIL_BY_ID.get(+id) || stopPoint(railName(id)); }
function railFare(parts){
  let total=0;
  for(const p of parts){
    const a=railPoint(p.a.id), b=railPoint(p.b.id); if(!a||!b) return null;
    const km=hav(a,b)/1000*1.2, cat=String(p.t.cat||'').toUpperCase();
    total+=IC_CATS.has(cat) ? Math.max(25, 8+0.3*km)*(cat==='EIP'?1.6:1) : Math.max(5, 0.28*km);
  }
  return Math.round(total);
}
// Bilety ZTM wg cennika (ztm.erzeszow.pl, Cennik.pdf), bilety normalne. Strefa A to Rzeszów, B to gminy obok.
const ZTM_PRICES={single:{A:5.00, AB:6.20, B:4.40}, min90:{A:8.20, AB:10.20}};
const RZ_CITY_KM=7.5, RZ_CENTRE=[50.0413,21.9990];
function ztmZone(legs){
  const out=legs.flatMap(l=>[stopPoint(l.from),stopPoint(l.to)]).filter(Boolean).map(p=>hav(p,RZ_CENTRE)/1000>RZ_CITY_KM);
  return out.every(x=>!x)?'A':out.every(Boolean)?'B':'AB';
}
// Bilet 60-minutowy (lub na jeden przejazd), 90-minutowy, a przy dłuższej jeździe kilka 60-minutowych.
function ztmFare(legs){
  if(!legs.length) return 0;
  const zone=ztmZone(legs), single=ZTM_PRICES.single[zone], m90=ZTM_PRICES.min90[zone];
  const min=((legs[legs.length-1].predArr??legs[legs.length-1].arr)-(legs[0].predDep??legs[0].dep))/60;
  if(legs.length===1 || min<=60) return single;
  if(min<=90 && m90) return Math.min(m90, single*2);
  return single*Math.ceil(min/60);
}
// Ceny PKS z wyszukiwarki pks.rzeszow.pl (przez serwer, z pamięcią); do czasu odpowiedzi szacunek z odległości.
const PKSF=new Map();
let pksTimer=null;
function pksPriceArrived(){ clearTimeout(pksTimer); pksTimer=setTimeout(()=>{ for(const P of S.plan?.stages||[]) P.access?.clear(); if(S.plan) runPlan(false); },500); }
function pksLegPrice(l){
  const a=stopPoint(l.from), b=stopPoint(l.to), dep=l.dep??l.predDep; if(!a||!b||dep==null) return null;
  const key=`${l.from}|${l.to}|${dayOfTs(dep)}|${fmtClock(dep)}|${l.short}`;
  if(!PKSF.has(key)){
    PKSF.set(key,'loading');
    const q=new URLSearchParams({from:l.from, fromLat:a[0], fromLon:a[1], to:l.to, toLat:b[0], toLon:b[1], day:dayOfTs(dep), time:fmtClock(dep), line:l.short||''});
    // Brak ceny zapamiętujemy tylko, gdy PKS odpowiedział; przy błędzie albo przerwie spróbujemy przy następnym planowaniu.
    fetch('/api/pks-price?'+q).then(async r=>{ const j=await r.json().catch(()=>({})); if(!r.ok){ PKSF.delete(key); return; } PKSF.set(key, j.price!=null?j:null); if(j.price!=null) pksPriceArrived(); }).catch(()=>PKSF.delete(key));
  }
  const v=PKSF.get(key); return v&&v!=='loading'?v.price:null;
}
function pksEstimate(l){ const a=stopPoint(l.from), b=stopPoint(l.to); return Math.max(4, a&&b?Math.round(0.35*hav(a,b)/1000*1.2*100)/100:4); }
function transitParts(o){
  const ztm=o.legs.filter(l=>l.agency!=='pks'), pksLegs=o.legs.filter(l=>l.agency==='pks');
  let pks=0, estimated=false;
  for(const l of pksLegs){ const p=pksLegPrice(l); if(p==null){ estimated=true; pks+=pksEstimate(l); } else pks+=p; }
  return {bus:ztm.length?ztmFare(ztm):0, pks:Math.round(pks*100)/100, pksEstimated:estimated && pksLegs.length>0};
}
function transitCost(o){ const p=transitParts(o); return Math.round((p.bus+p.pks)*100)/100; }
const mergeParts=(a={},b={})=>{ const out={...a}; for(const [k,v] of Object.entries(b)){ if(typeof v==='number') out[k]=Math.round(((out[k]||0)+v)*100)/100; else if(v) out[k]=v; } return out; };
const scaleParts=(p,n)=>Object.fromEntries(Object.entries(p).map(([k,v])=>[k,typeof v==='number'?Math.round(v*n*100)/100:v]));
const zl=v=>`${v.toFixed(2).replace('.',',')} zł`;
// Bilet kolejowy szacujemy z odległości (przewoźnicy nie udostępniają cen); dojazd autobusem ma cenę z cennika.
function trainFareLine(r){
  const train=railFare(railParts(r)), bus=[r.access,r.egress].filter(Boolean).map(transitParts);
  const items=[];
  for(const p of bus){ if(p.bus) items.push(`ZTM ${zl(p.bus)}`); if(p.pks) items.push(`podmiejski ${p.pksEstimated?'ok. ':''}${zl(p.pks)}`); }
  items.unshift(train!=null?`pociąg ok. ${zl(train)}`:'pociąg: cena niedostępna');
  return `<div class="pc-fare"><i class="fa-solid fa-ticket" aria-hidden="true"></i> Bilety: ${items.join(' + ')}<small> · bilet normalny${train!=null?', cena pociągu szacunkowa':''}</small></div>`;
}
function fareLine(o){
  const p=transitParts(o), items=[];
  if(p.bus) items.push(`ZTM ${zl(p.bus)}`);
  if(p.pks) items.push(`podmiejski ${p.pksEstimated?'ok. ':''}${zl(p.pks)}`);
  if(!items.length) return '';
  return `<div class="pc-fare"><i class="fa-solid fa-ticket" aria-hidden="true"></i> Bilety: ${items.join(' + ')}${items.length>1?` = ${zl(p.bus+p.pks)}`:''}<small> · bilet normalny</small></div>`;
}
function gmapsUrl(a,b){ return `https://www.google.com/maps/dir/?api=1&origin=${a[0].toFixed(5)},${a[1].toFixed(5)}&destination=${b[0].toFixed(5)},${b[1].toFixed(5)}&travelmode=driving`; }
function gmapsButton(a,b){ return a&&b?`<a class="btn-ghost gmaps-btn" href="${esc(gmapsUrl(a,b))}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> Otwórz w Mapach Google</a>`:''; }
const withMap=(s,a,b)=>a&&b?Object.assign(s,{link:{href:gmapsUrl(a,b), label:'Otwórz w Mapach Google'}}):s;
const railChip=p=>`<span class="leg-line" style="background:${MODE_COLOR.train}">${esc(p.t.cat||'POC')}</span>`;

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
function arrivingBy(origin, stops, deadline, allow, windows=[3,5.5], notBefore=0){
  const dest={names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist]))};
  for(const hours of windows){ const fit=planTrips(origin,dest,Math.max(deadline-hours*3600,notBefore),allow).filter(o=>o.arr+o.walkTo<=deadline); if(fit.length) return fit[fit.length-1]; }
  return null;
}
function transitSteps(o, target='na miejsce'){
  const steps=[], last=o.legs[o.legs.length-1];
  if(o.walkFrom) steps.push(step('person-walking',`Idź na przystanek ${o.legs[0].from}`,walkText(o.walkFromM)));
  o.legs.forEach((l,k)=>{
    const prev=o.legs[k-1]; if(prev && prev.to!==l.from) steps.push(step('person-walking',`Przejdź na przystanek ${l.from}`,`z przystanku ${prev.to}`));
    steps.push(step(l.agency==='pks'?'bus-simple':'bus',`${AGENCY_NAMES[l.agency]||'Autobus'} ${l.short}: ${l.from} → ${l.to}`,`${fmtClock(l.predDep)} – ${fmtClock(l.predArr)} · kierunek ${l.head}`));
  });
  if(o.walkTo) steps.push(step('person-walking',`Z przystanku ${last.to} dojdź ${target}`,walkText(o.walkToM)));
  return steps;
}
function stepsHtml(steps){ return `<ol class="trip-steps">${steps.map(s=>`<li><i class="fa-solid fa-${s.icon} step-ico" style="--k:${STEP_COLOR[s.icon]||MODE_COLOR.other}" aria-hidden="true"></i><div><b>${esc(s.text)}</b>${s.sub?`<small>${esc(s.sub)}</small>`:''}${s.note?`<small class="step-note">${esc(s.note)}</small>`:''}${s.link?`<a class="step-link" href="${esc(s.link.href)}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> ${esc(s.link.label)}</a>`:''}</div></li>`).join('')}</ol>`; }
const seqIcon=(icon,color)=>`<span class="leg-line" style="background:${color}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`;
// Pociąg na lotnisko i z powrotem z rozkładu PKP PLK: konkretny pociąg, peron i przewoźnik.
const AIRPORT_RAIL_M=3000, BAGGAGE_MIN=30, RAIL_LOOKBACK_H=10, HOME_RAIL_KM=30;
function nearestStations(point, maxM, n=3){
  const out=[]; for(const [name,pt] of RAIL_BY_NAME){ const d=hav(point,pt); if(d<=maxM) out.push({name, dist:Math.round(d)}); }
  return out.sort((a,b)=>a.dist-b.dist).slice(0,n);
}
function homeStations(point){
  // Dwie najbliższe stacje i każdy główny dworzec w zasięgu, nawet jeśli bliżej jest kilka mniejszych przystanków kolejowych.
  const list=nearestStations(point, HOME_RAIL_KM*1000, 60), picked=[...list.slice(0,2), ...list.filter(x=>isCityMain(x.name))];
  return [...new Map(picked.map(x=>[x.name,x])).values()];
}
function airportPoint(P, code){
  const a=[...(P.flights?.originAirports||[]), ...(P.flights?.destAirports||[]), ...(FL.data?.airports||[])].find(x=>x.code===code);
  return a&&a.lat!=null?[a.lat,a.lon]:null;
}
// Najpierw stacja przy terminalu; gdy jej nie ma, główny dworzec miasta lotniska, a dalej autobus lotniskowy lub taksówka.
function airportRailTargets(code, point){
  const out=[], at=nearestStations(point, AIRPORT_RAIL_M, 1)[0], hub=RAIL_HUBS[code];
  if(at) out.push({station:at.name, lastKm:0, walkM:at.dist});
  if(hub && hub[0]!==at?.name) out.push({station:hub[0], lastKm:hav([hub[1],hub[2]],point)/1000*ROAD_FACTOR, walkM:0});
  return out.map(t=>({...t, ids:stationIds([t.station]), lastMin:t.lastKm?t.lastKm/CAR_KMH*60+15:Math.max(5,walkSec(t.walkM)/60)})).filter(t=>t.ids.length);
}
// Rozkład na dzień lotu wczytuje się w tle; czekamy na niego, zamiast zgadywać czas jazdy.
async function railTrainsFor(at){
  for(let i=0;i<120;i++){
    if(TR.mode!=='loading'){ const t=trainsAround(at); if(t) return TR.mode==='live'?t:[]; }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  return [];
}
const proxyNote=t=>t.proxy?`Wg rozkładu z ${fmtDay(t.proxy)} — rozkład na ten dzień nie jest jeszcze opublikowany.`:'';
function railPartSteps(parts){
  const steps=[];
  parts.forEach((p,k)=>{
    const carrier=TR.carriers.get(p.t.carrier), start=railName(p.a.id), end=railName(p.b.id);
    if(k) steps.push(step('shuffle',`Przesiadka: ${start}`,`${Math.round((p.dep-parts[k-1].arr)/60)} min na przesiadkę`));
    steps.push(Object.assign(step('train',`Pociąg ${p.t.label}${p.t.name?' „'+p.t.name+'”':''}: ${start} → ${end}`,`odjazd ${fmtClock(p.dep)}${p.a.pl?' z peronu '+p.a.pl:''} · wysiądź ${fmtClock(p.arr)}${p.b.pl?' na peronie '+p.b.pl:''}${carrier?' · '+carrier:''}`),{note:proxyNote(p.t)}));
  });
  return steps;
}
// Z domu na stację: pieszo, autobusem z rozkładu albo samochodem z nawigacją.
function toStation(P, a, station, dep){
  const pt=stopPoint(station)||RAIL_BY_NAME.get(station), dist=pt?Math.round(hav(a,pt)):null;
  if(dist!=null && dist<=RAIL_WALK_M) return {walk:dist, steps:[step('person-walking',`Idź na stację ${station}`,walkText(dist))], seq:[seqWalk(walkSec(dist))], leave:dep-walkSec(dist)-300, cost:0, parts:{}};
  const stops=pt?nearbyStops({points:[pt]}).filter(x=>x.dist<=800):[];
  const o=stops.length && P.origin.names.length && usesTransit(P) ? arrivingBy(P.origin,stops,dep-300,tripAllowed(P)) : null;
  if(o) return {o, steps:transitSteps(o,`na stację ${station}`), seq:transitSeq(o), leave:o.dep-o.walkFrom, cost:transitCost(o), parts:transitParts(o)};
  const km=(dist||0)/1000*ROAD_FACTOR, min=km/CAR_KMH*60+10;
  return {drive:dist, steps:[withMap(step('car',`Dojedź na stację ${station}`,`ok. ${fmtKm(km)} · ok. ${fmtDuration(min)} samochodem lub taksówką`),a,pt)], seq:[seqIcon('car',MODE_COLOR.car)], leave:dep-min*60, cost:fuelCost(km), parts:{car:fuelCost(km)}};
}
async function railToAirport(P, f, deadline){
  const a=P.origin.points[0], point=[f.airport.lat,f.airport.lon]; if(!a) return null;
  const homeIds=stationIds(homeStations(a).map(x=>x.name)); if(!homeIds.length) return null;
  const trains=await railTrainsFor(deadline-RAIL_LOOKBACK_H*3600); if(!trains.length) return null;
  for(const target of airportRailTargets(f.from, point)){
    const by=deadline-target.lastMin*60, starts=new Map(homeIds.map(id=>[id,by-RAIL_LOOKBACK_H*3600]));
    const found=railConnections(trains, starts, new Set(target.ids), by).filter(parts=>parts[parts.length-1].arr<=by);
    if(!found.length) continue;
    // Pociąg z jednej stacji w mieście na drugą tylko po to, by się przesiąść, zastępuje dojazd autobusem lub pieszo na tę drugą stację.
    let parts=found[found.length-1]; const home=new Set(homeIds.map(String));
    while(parts.length>1 && home.has(String(parts[0].b.id))) parts=parts.slice(1);
    const first=parts[0], last=parts[parts.length-1], access=toStation(P, a, railName(first.a.id), first.dep);
    const steps=[...access.steps, ...railPartSteps(parts)], seq=[...access.seq, ...parts.map(railChip)];
    if(target.lastKm){ steps.push(step('bus',`Z dworca ${target.station} na lotnisko ${f.fromLabel}`,`ok. ${fmtKm(target.lastKm)} · autobus lotniskowy lub taksówka — tego odcinka nie ma w rozkładzie PKP`)); seq.push(seqIcon('bus',MODE_COLOR.other)); }
    else steps.push(step('person-walking',`Ze stacji ${target.station} dojdź do terminalu`,walkText(target.walkM)));
    const atAirport=last.arr+target.lastMin*60, fare=railFare(parts);
    const route={kind:'train', r:{parts, a:first.a, b:last.b, dep:first.dep, arr:last.arr, from:railName(first.a.id), to:target.station, access:access.o||null, walkFrom:access.walk||0, startDist:access.drive??(access.o||access.walk?0:null), walkTo:target.walkM||0}, origin:P.origin, dest:{label:f.fromLabel, points:[point]}};
    return {id:'rail', title:'Pociąg', route, steps, seq, leave:access.leave, atAirport, minutes:(atAirport-access.leave)/60, cost:fare==null?null:fare+access.cost, parts:mergeParts(access.parts,{train:fare??0})};
  }
  return null;
}
async function railHome(P, r){
  const a=P.origin.points[0], point=airportPoint(P,r.to), landed=r.arrival?parseLocalDT(r.arrival):null; if(!a||!point||!landed) return null;
  const homeIds=new Set(stationIds(homeStations(a).map(x=>x.name))); if(!homeIds.size) return null;
  const trains=await railTrainsFor(landed); if(!trains.length) return null;
  for(const target of airportRailTargets(r.to, point)){
    const ready=landed+(BAGGAGE_MIN+target.lastMin)*60, found=railConnections(trains, new Map(target.ids.map(id=>[id,ready])), homeIds, ready+8*3600);
    if(!found.length) continue;
    let parts=found[0]; const home=new Set([...homeIds].map(String));
    while(parts.length>1 && home.has(String(parts[parts.length-1].a.id))) parts=parts.slice(0,-1);
    const last=parts[parts.length-1], station=railName(last.b.id), pt=stopPoint(station)||RAIL_BY_NAME.get(station), dist=pt?Math.round(hav(pt,a)):0;
    const steps=[target.lastKm ? step('bus',`Z lotniska ${r.toLabel} na dworzec ${target.station}`,`ok. ${fmtKm(target.lastKm)} · autobus lotniskowy lub taksówka — tego odcinka nie ma w rozkładzie PKP`) : step('person-walking',`Z terminalu dojdź na stację ${target.station}`,walkText(target.walkM)), ...railPartSteps(parts)];
    const km=dist/1000*ROAD_FACTOR;
    steps.push(dist<=RAIL_WALK_M ? step('house',`Ze stacji ${station} dojdź do domu`,walkText(dist)) : withMap(step('car',`Ze stacji ${station} do domu`,`ok. ${fmtKm(km)} · autobusem, samochodem lub taksówką`),pt,a));
    const fare=railFare(parts);
    const seq=[target.lastKm?seqIcon('bus',MODE_COLOR.other):seqWalk(walkSec(target.walkM)), ...parts.map(railChip), dist<=RAIL_WALK_M?seqWalk(walkSec(dist)):seqIcon('car',MODE_COLOR.car)];
    return {steps, seq, cost:fare==null?null:fare+(dist<=RAIL_WALK_M?0:fuelCost(km)), parts:{train:fare??0, car:dist<=RAIL_WALK_M?0:fuelCost(km)}};
  }
  return null;
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
  return {id:'car', title:'Samochód', route:{kind:'car', origin:P.origin, dest:{label:f.fromLabel, points:[b]}}, minutes:min, km, cost:fuelCost(km), parts:{car:fuelCost(km)}, seq:[seqIcon('car',MODE_COLOR.car)], steps:[withMap(step('car',`Jedź samochodem na lotnisko ${f.fromLabel}`,`${fmtKm(km)} · ok. ${fmtDuration(min)}${d?'':' · szacunkowo'} · paliwo ok. ${fuelCost(km)} zł`),a,b)]};
}
function flightSteps(P, f){
  if(f.placeholder) return [
    step('passport','Bądź na lotnisku 2 godz. przed wylotem','Dojazd liczony na przykładowy lot w południe — zmień, gdy poznasz godzinę.'),
    step('plane-departure',`Lot ${f.fromLabel} → ${f.toLabel}`,`${fmtDay(f.day)} · godzina i cena do sprawdzenia u przewoźnika`),
    f.fromAirportKm>=1 && step('flag-checkered',`Z lotniska do celu: ${P.to}`,`ok. ${fmtKm(f.fromAirportKm)}`),
  ].filter(Boolean);
  const {at}=fareStart(f), times=f.departure?`${f.departure.slice(11)}${f.arrival?' – '+f.arrival.slice(11):''}`:'godzinę sprawdź u przewoźnika';
  return [
    step('passport',at?`Bądź na lotnisku do ${fmtClock(at-CHECKIN_MIN*60)}`:'Bądź na lotnisku 2 godz. przed wylotem',at?'2 godz. przed wylotem':'Linia podała tylko cenę dnia, więc dojazd to przykładowy kurs.'),
    step('plane-departure',`Lot ${airlineOf(f).name}${f.flightNumber?' '+f.flightNumber:''}: ${f.fromLabel} → ${f.toLabel}`,`${fmtDay(f.day)} · ${times} · ${Math.round(f.pricePln)} zł`),
    f.fromAirportKm>=1 && step('flag-checkered',`Z lotniska do celu: ${P.to}`,`ok. ${fmtKm(f.fromAirportKm)}`),
  ].filter(Boolean);
}
// Poza Rzeszowem (np. z Barcelony na lotnisko BCN) nie ma naszych autobusów ani rozkładu PKP. Wtedy bierzemy te same linie,
// którymi jedzie się z tego lotniska do centrum (z bazy i rozkładów: R2 Nord, Aerobus, taksówka…), w drugą stronę:
// czas i cena jak w tamtą stronę, wyjście liczone tak, by zdążyć na odprawę.
const XFER_TO_ICON={rail:'train', metro:'train', tram:'train', bus:'bus', ferry:'ferry', taxi:'car'};
const XFER_TO_MODE={rail:'train', metro:'train', tram:'train', bus:'bus', ferry:'bus', taxi:'car'};
async function xferToAirport(P, f, deadline){
  const a=P.origin.points[0]; if(!a || !f.from) return [];
  const key=f.from+'|'+a.map(x=>(+x).toFixed(3)).join(',');
  P.xferTo=P.xferTo||new Map();
  if(!P.xferTo.has(key)){
    let d=null;
    try{
      const time=(f.departure||`${f.day}T12:00`).slice(0,16);
      const r=await fetch('/api/airport-transfers/options?'+new URLSearchParams({code:f.from, time, lat:a[0], lon:a[1], label:P.from||''}));
      if(r.ok) d=await r.json();
    }catch(e){ console.warn('Dojazd na lotnisko (linie lotniskowe)', e); }
    P.xferTo.set(key, d?.options||[]);
  }
  const back=f.ret&&!f.ret.placeholder?2:1, out=[];
  for(const o of P.xferTo.get(key)){
    const mode=XFER_TO_MODE[o.kind]||'bus', icon=XFER_TO_ICON[o.kind]||'bus';
    if(!P.allowed.has(mode) && !(mode==='bus' && P.allowed.has('pks'))) continue;
    if(o.minutes==null) continue;
    const title=o.name||[o.line, o.agency].filter(Boolean).join(' · ')||(o.kind==='taxi'?'Taksówka':'Linia lotniskowa');
    const one=o.fare?.pln!=null?Math.round(o.fare.pln):null, cost=one==null?null:one*back, buffer=o.kind==='taxi'?5:15;
    const leave=deadline-(o.minutes+buffer)*60;
    const where=o.kind==='taxi'?L2('z miejsca startu','from your start'):o.alight?L2(`wsiądź w okolicy: ${o.alight}`,`board near: ${o.alight}`):'';
    const sub=[L2(`ok. ${fmtDuration(o.minutes)}`,`about ${fmtDuration(o.minutes)}`), o.fare?.text||'', where, o.kind==='taxi'?'':L2('rozkład w stronę lotniska sprawdź u przewoźnika','check the timetable towards the airport with the operator')].filter(Boolean).join(' · ');
    const chip=seqIcon(icon, MODE_COLOR[mode]||MODE_COLOR.other);
    out.push({id:'x-'+o.id, title, xferLine:true, route:{kind:'car', origin:P.origin, dest:{label:f.fromLabel, points:[[f.airport.lat,f.airport.lon]]}},
      steps:[step(icon,`Na lotnisko ${f.fromLabel}: ${title}`,sub)], seq:[chip],
      leave, atAirport:deadline, minutes:o.minutes+buffer, cost, parts:{[mode]:cost??0},
      back:back>1?{seq:[chip], steps:[step(icon,`Z lotniska ${f.ret.toLabel}: ${title}`,`ok. ${fmtDuration(o.minutes)}${o.fare?.text?' · '+o.fare.text:''}`)]}:null});
  }
  return out;
}
async function buildAccess(P, f){
  const {base,at}=fareStart(f), deadline=at!=null?at-CHECKIN_MIN*60:base+10*3600, point=[f.airport.lat,f.airport.lon], options=[];
  const stops=nearbyStops({points:[point]}).filter(x=>x.dist<=800);
  const o=stops.length && P.origin.names.length && usesTransit(P) ? arrivingBy(P.origin,stops,deadline,tripAllowed(P)) : null;
  const back=f.ret&&!f.ret.placeholder?f.ret:null;
  if(o){ const leave=o.dep-o.walkFrom, atAirport=o.arr+o.walkTo; options.push({id:'bus', title:transitName(o), route:{kind:'transit', o, origin:P.origin, dest:{label:f.fromLabel, points:[point]}}, steps:transitSteps(o), seq:transitSeq(o), leave, atAirport, minutes:(atAirport-leave)/60, parts:scaleParts(transitParts(o),back?2:1), cost:transitCost(o)*(back?2:1)}); }
  const rail=P.allowed.has('train') ? await railToAirport(P,f,deadline) : null;
  if(rail){
    if(back){ rail.back=await railHome(P,back); rail.cost=rail.cost==null||rail.back?.cost==null?null:rail.cost+rail.back.cost; rail.parts=mergeParts(rail.parts, rail.back?.parts||{}); }
    options.push(rail);
  }
  // Nie ma naszego autobusu ani pociągu (start za granicą): linie lotniskowe z bazy, w stronę lotniska.
  if(!options.length){ try{ options.push(...await xferToAirport(P,f,deadline)); }catch(e){ console.warn('Dojazd na lotnisko', e); } }
  const car=P.allowed.has('car') ? await carToAirport(P,f) : null;
  if(car){
    if(at!=null) car.leave=deadline-car.minutes*60;
    if(f.ret){ const home=P.origin.points[0], ap=airportPoint(P,f.ret.to)||[f.airport.lat,f.airport.lon], km=f.ret.to===f.from||!home?car.km:hav(ap,home)/1000*ROAD_FACTOR;
      car.back={seq:[seqIcon('car',MODE_COLOR.car)], steps:[withMap(step('car',`Z lotniska ${f.ret.toLabel} jedź do domu`,`ok. ${fmtKm(km)} · ok. ${fmtDuration(km/CAR_KMH*60)} · paliwo ok. ${fuelCost(km)} zł`),ap,home)]};
      car.cost+=fuelCost(km); car.parts={car:car.cost}; }
    options.push(car);
  }
  return options;
}
function returnSteps(P, f, o){
  const r=f.ret; if(!r) return [];
  if(r.placeholder) return [step('plane-arrival',`Lot powrotny ${r.fromLabel} → ${r.toLabel}`,`${fmtDay(r.day)} · godzina i cena do sprawdzenia u przewoźnika`), step('house',`Z lotniska do domu: ${P.from}`,`ok. ${fmtKm(r.homeKm)}`)];
  const times=r.departure?`${r.departure.slice(11)}${r.arrival?' – '+r.arrival.slice(11):''}`:'godzinę sprawdź u przewoźnika';
  return [
    step('plane-arrival',`Lot powrotny ${airlineOf(r).name}${r.flightNumber?' '+r.flightNumber:''}: ${r.fromLabel} → ${r.toLabel}`,`${fmtDay(r.day)} · ${times} · ${Math.round(r.pricePln)} zł`),
    ...(o?.back?.steps || [step('house',`Z lotniska do domu: ${P.from}`,`ok. ${fmtKm(r.homeKm)}`)]),
  ];
}
function otherReturns(f){
  const list=(f.returns||[]).slice(1); if(!list.length) return '';
  return `<div class="trip-others"><b>Inne terminy powrotu</b>${list.map(r=>{ FL.byKey.set(fareKey(r),r); return `<button class="btn-ghost" type="button" data-flight="${esc(fareKey(r))}">${esc(flightDetail(r))}</button>`; }).join('')}</div>`;
}
// Dojazd liczymy dla wybranej pary lotów (wylot i powrót) i odświeżamy wyniki raz, na końcu.
function ensureAccessAll(P, list){
  const todo=list.filter(f=>!P.access.has(offerKey(f))); if(!todo.length) return;
  for(const f of todo) P.access.set(offerKey(f), null);
  (async()=>{
    for(const f of todo){ let options=[]; try{ options=await buildAccess(P,f); }catch(e){ console.warn('Dojazd na lotnisko', e); } P.access.set(offerKey(f), options); }
    if(inPlan(P)) runPlan(false);
  })();
}
// Wybrany sposób dojazdu (wiersz tabeli porównania); domyślnie pierwszy.
function pickedAccess(P, f){
  const options=P.access.get(offerKey(f))||[], id=P.accessPick?.get(offerKey(f));
  return options.find(o=>o.id===id)||options[0]||null;
}
function accessHtml(P, f){
  const options=P.access.get(offerKey(f));
  if(!options) return searching('Liczę dojazd na lotnisko…');
  const o=pickedAccess(P,f);
  return `<div class="journey-top">${compareHtml(P,f,options,o)}${journeyLine(P,f,o)}</div>`;
}
const fareTotal=f=>Math.round(f.pricePln+(f.ret?.pricePln||0));
/* ---------- Ceny lotów w dwóch walutach: najpierw EUR, potem PLN (kurs średni NBP z serwera) ---------- */
const FX={eur:null, asked:false};
async function loadFx(){
  if(FX.asked) return; FX.asked=true;
  try{ const r=await fetch('/api/rates?currency=EUR'); const d=r.ok?await r.json():null; if(d?.pln>0){ FX.eur=d.pln; if(S.plan) runPlan(false); } }
  catch(e){ console.warn('Kurs EUR', e); FX.asked=false; }
}
// Cena w euro: z taryfy przewoźnika, gdy sprzedaje w EUR, inaczej przeliczona z PLN.
const eurOf=f=>!f||f.priceUnknown?null:f.currency==='EUR'&&f.price>0?f.price:FX.eur&&f.pricePln>0?f.pricePln/FX.eur:null;
const eurSum=f=>{ const a=eurOf(f), b=f?.ret?eurOf(f.ret):0; return a!=null&&b!=null?a+b:null; };
const fmtEur=v=>v>=100?String(Math.round(v)):v.toFixed(2).replace('.',',');
function eurPln(pln, eur){ const e=eur!=null?eur:(FX.eur&&pln!=null?pln/FX.eur:null); return `${e!=null?`<span class="fx-eur">${fmtEur(e)} €</span> <span class="fx-sep">·</span> `:''}<span class="fx-pln">${pln} zł</span>`; }
// Porównanie dojazdów: kiedy wyjść, ile trwa droga na lotnisko i ile kosztuje razem z lotem.
// Główne miejsca podróży na pionowej, kropkowanej linii. Szczegóły wszystkich punktów są od razu rozwinięte
// (to planowanie, więc nie trzeba klikać); kliknięcie punktu zwija albo rozwija jego szczegóły.
// Szczegóły punktów przebiegu podróży z ostatniego rysowania planu, do otwarcia w oknie (klucz: oferta|punkt).
const JL_DETAIL=new Map();
function openJourneyDetail(k){
  const d=JL_DETAIL.get(k); if(!d || !window.PVUI) return;
  wireSheet(PVUI.sheet.open({title:d.title, html:(d.sub?`<p class="jl-sheet-sub">${esc(d.sub)}</p>`:'')+`<div class="jl-sheet">${d.detail}</div>`}));
}
// Przyciski w oknie, które otwierają inne okno („Szczegóły lotu”, „Trasa na mapie”): to okno zamyka się najpierw,
// tak jak wcześniej, gdy te przyciski były na liście.
function wireSheet(h){
  h.el.addEventListener('click', e=>{
    const fl=e.target.closest('[data-flight]'); if(fl){ h.close(); openFlight(fl.dataset.flight); return; }
    const rt=e.target.closest('[data-route]'); if(rt){ h.close(); openTripMap(S.planRoutes[+rt.dataset.route]); }
  });
  return h;
}
// Szczegóły, które nie muszą stale zajmować ekranu (rozbicie kosztów, założenia, trasa krok po kroku), są gotowe
// przy rysowaniu ekranu i otwierają się w oknie (PVUI.sheet) po kliknięciu przycisku. Najstarsze wpisy wypadają.
const INFO=new Map(); let infoSeq=0;
function infoButton(label, title, html, {icon='circle-info', cls='btn-ghost pv-info-btn'}={}){
  if(!html) return '';
  const k='i'+(++infoSeq); INFO.set(k,{title, html});
  while(INFO.size>300) INFO.delete(INFO.keys().next().value);
  return `<button type="button" class="${cls}" data-pv-info="${k}" aria-haspopup="dialog"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${esc(label)}</button>`;
}
function openInfo(k){
  const d=INFO.get(k); if(!d || !window.PVUI) return;
  wireSheet(PVUI.sheet.open({title:d.title, html:`<div class="jl-sheet pv-info">${d.html}</div>`}));
}
function journeyLine(P, f, o, {only=''}={}){
  if(JL_DETAIL.size>300) JL_DETAIL.clear();
  const key=offerKey(f), clock=v=>v?v.slice(11,16):'';
  const when=ts=>ts?`${dayOfTs(ts)!==f.day?fmtDay(dayOfTs(ts))+' ':''}${fmtClock(ts)}`:'';
  // Na ekranie zostaje tylko to, co potrzebne od razu (środek transportu, skąd–dokąd, godziny, czas, koszt).
  // Szczegóły punktu (trasa krok po kroku, linki, odprawa) otwierają się w oknie (PVUI.sheet) po kliknięciu.
  const item=(id, cls, mark, title, sub, detail)=>{
    const k=key+'|'+id;
    if(detail) JL_DETAIL.set(k, {title, sub, detail});
    return `<li class="${cls}"><button type="button" class="jl-btn" data-jl="${esc(k)}" ${detail?'aria-haspopup="dialog"':'disabled'}>${mark}<span class="jl-text"><b>${esc(title)}</b>${sub?`<small>${esc(sub)}</small>`:''}</span>${detail?'<i class="fa-solid fa-chevron-right jl-caret" aria-hidden="true"></i>':''}</button></li>`;
  };
  const dot='<span class="jl-dot" aria-hidden="true"></span>';
  const ico=(m)=>`<span class="jl-ico" style="--k:${MODE_COLOR[m]||MODE_COLOR.other}"><i class="fa-solid fa-${MODE_ICON[m]||m}" aria-hidden="true"></i></span>`;
  const legIco=modes=>modes.length?`<span class="jl-icos">${modes.map(ico).join('')}</span>`:ico('route');
  const goModes=mainModes(o?.steps), fs=flightSteps(P,f), home=returnSteps(P,f,o);
  const onwardStep=f.fromAirportKm>=1?[withMap(step('car',`Z lotniska ${f.toLabel} do celu: ${P.to}`,`ok. ${fmtKm(f.fromAirportKm)}`), airportPoint(P,f.to), P.dest.points[0])]:[];
  const items=[
    item('start','jl-node',dot,P.from,o?.leave?`wyjście ${when(o.leave)}`:'', o?.leave?stepsHtml([step('house',`Wyjdź o ${when(o.leave)}`, o.title)]):''),
    item('go','jl-leg',legIco(goModes),o?.title?o.title.replace(/ \+ samolot$/,''):'Dojazd na lotnisko',o?.minutes?fmtDuration(o.minutes)+(o.cost!=null?` · ok. ${Math.round(o.cost)} zł`:''):'', o?.steps?.length?stepsHtml(o.steps)+accessLinks(P,f,o):''),
    item('airport','jl-node',dot,f.fromLabel,f.departure?`wylot ${fmtDay(f.day)} ${clock(f.departure)}`:fmtDay(f.day), stepsHtml(fs.filter(x=>x.icon==='passport'))),
    item('out','jl-leg',legIco(['plane']),`${f.placeholder?'Lot':airlineOf(f).name}${f.flightNumber?' '+f.flightNumber:''}`, f.departure?`${clock(f.departure)}${f.arrival?' – '+clock(f.arrival):''}`:'', stepsHtml(fs.filter(x=>x.icon==='plane-departure'))+(f.placeholder?'':`<button class="btn-ghost mt-2" type="button" data-flight="${esc(fareKey(f))}">Szczegóły lotu</button>`)),
    item('dest','jl-node',dot,f.toLabel,f.arrival?`przylot ${clock(f.arrival)}`:'', ''),
  ];
  const xo=P.xferPick==='skip'?'skip':P.xferPick?airportOptions(P,f)?.options?.find(x=>x.id===P.xferPick):null;
  const xMode={rail:'train', metro:'train', tram:'train', bus:'bus', taxi:'car', ferry:'car'};
  if(xo==='skip') items.push(item('onward','jl-leg',legIco(['car']),'Odbiór z lotniska','ktoś odbiera', ''));
  else if(xo) items.push(item('onward','jl-leg',legIco([xMode[xo.kind]||'bus']),`Do centrum: ${xo.name||xo.line}`, [xo.minutes!=null?'ok. '+fmtDuration(xo.minutes):'', xo.fare?.pln!=null?`ok. ${xo.fare.pln} zł`:'', xo.departures?.length?`odjazdy ${xo.departures.slice(0,3).join(', ')}`:''].filter(Boolean).join(' · '),
    (xo.board?.name?stepsHtml([step('location-dot',`Gdzie iść: ${xo.board.name}`, xo.alight?`wysiadasz: ${xo.alight}`:'')]):'')+(xo.steps?.length?csSteps(xo.steps):xo.fare?.text?`<p class="text-soft small">${esc(xo.fare.text)}</p>`:'')));
  else if(onwardStep.length) items.push(item('onward','jl-leg',legIco(['car']),`Do celu: ${P.to}`,`ok. ${fmtKm(f.fromAirportKm)}`, stepsHtml(onwardStep)));
  if(f.ret){
    const r=f.ret, retFlight=home.filter(x=>x.icon==='plane-arrival'), homeSteps=home.filter(x=>x.icon!=='plane-arrival');
    items.push(item('stay','jl-leg',ico('bed'),`Pobyt do ${fmtDay(r.day)}`,'', ''));
    items.push(item('ret-airport','jl-node',dot,r.fromLabel,r.departure?`wylot ${fmtDay(r.day)} ${clock(r.departure)}`:fmtDay(r.day), onwardStep.length?stepsHtml([withMap(step('car',`Z celu na lotnisko ${r.fromLabel}`,`ok. ${fmtKm(f.fromAirportKm)} · bądź 2 godz. przed wylotem`), P.dest.points[0], airportPoint(P,r.from))]):''));
    items.push(item('ret','jl-leg',legIco(['plane']),`${r.placeholder?'Lot':airlineOf(r).name}${r.flightNumber?' '+r.flightNumber:''}`, r.departure?`${clock(r.departure)}${r.arrival?' – '+clock(r.arrival):''}`:'', stepsHtml(retFlight)));
    items.push(item('ret-land','jl-node',dot,r.toLabel,r.arrival?`przylot ${clock(r.arrival)}`:'', ''));
    items.push(item('home','jl-leg',legIco(mainModes(o?.back?.steps)),'Powrót do domu','', homeSteps.length?stepsHtml(homeSteps):''));
    items.push(item('end','jl-node',dot,P.from,'', ''));
  }
  const save='';
  if(only==='go') return `<div class="journey-box"><div class="jl-head"><h4 class="trip-title"><i class="fa-solid fa-route" aria-hidden="true"></i> Dojazd na lotnisko krok po kroku</h4></div><div class="jl-steps">${o?.steps?.length?stepsHtml(o.steps):''}</div></div>`;
  return `<div class="journey-box"><div class="jl-head"><h4 class="trip-title"><i class="fa-solid fa-route" aria-hidden="true"></i> Przebieg podróży</h4>${save}</div><small class="text-soft">Kliknij punkt podróży, aby zobaczyć szczegóły.</small><ol class="journey-line">${items.join('')}</ol></div>`;
}
function compareHtml(P, f, options, picked){
  const list=options.filter(o=>o.minutes!=null||o.cost!=null); if(!list.length) return '';
  const fast=Math.min(...list.map(o=>o.minutes??Infinity)), cheap=Math.min(...list.map(o=>o.cost??Infinity)), flight=f.placeholder?null:fareTotal(f), many=list.length>1;
  const rows=list.map(o=>`<tr class="acc-row ${o===picked?'on':''}" data-acc-pick="${esc(offerKey(f))}" data-acc-id="${o.id}" tabindex="0"><th scope="row"><span class="acc-seq">${modeChips(mainModes(o.steps))}</span> ${esc(o.title)}${many&&o.minutes===fast?' <span class="pc-badge alt">Najszybciej</span>':''}${many&&o.cost===cheap?' <span class="pc-badge cheap">Najtaniej</span>':''}</th>
    <td data-label="Wyjście">${o.leave?(dayOfTs(o.leave)!==f.day?fmtDay(dayOfTs(o.leave))+' ':'')+fmtClock(o.leave):'—'}</td><td data-label="Droga na lotnisko">${o.minutes!=null?fmtDuration(o.minutes):'—'}</td><td data-label="Koszt dojazdu">${o.cost!=null?'ok. '+Math.round(o.cost)+' zł':'—'}</td><td data-label="Razem z lotem">${o.cost!=null&&flight!=null?'ok. '+Math.round(flight+o.cost)+' zł':'—'}</td></tr>`).join('');
  // Założenia cen (paliwo, bilety szacowane) są w oknie „Jak liczymy koszt dojazdu”, nie pod tabelą.
  const how=`<p>Samochód: koszt paliwa, ${esc(fuelNote())}, bez parkingu. Bilety kolejowe i autobusowe to szacunek ceny normalnej.</p>`
    +`<p>„Razem z lotem” to cena lotu za 1 osobę i koszt dojazdu${f.ret?' tam i z powrotem':''}. Aktualną cenę biletu potwierdzisz u przewoźnika.</p>`;
  return `<div class="acc-compare"><b class="acc-title">Dojazd na lotnisko — wybierz sposób</b><table><thead><tr><th>Dojazd</th><th>Wyjście</th><th>Droga na lotnisko</th><th>Koszt dojazdu${f.ret?' (tam i z powrotem)':''}</th><th>Razem z lotem</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pv-info-row">${infoButton('Jak liczymy koszt dojazdu','Jak liczymy koszt dojazdu',how)}</div></div>`;
}
// Karta lotu jak w wyszukiwarkach: dojazd na lotnisko, wylot, powrót, a z prawej cena za osobę.
// Tylko główne środki transportu, bez pieszych odcinków i numerów linii: autobus › pociąg › samolot.
const MODE_OF_ICON={bus:'bus', 'bus-simple':'pks', train:'train', car:'car', 'plane-departure':'plane', 'plane-arrival':'plane'};
const MODE_ICON={bus:'bus', pks:'bus-simple', train:'train', car:'car', plane:'plane', stay:'bed'};
function mainModes(steps){ const out=[]; for(const st of steps||[]){ const m=MODE_OF_ICON[st.icon]; if(m && out[out.length-1]!==m) out.push(m); } return out; }
function modeChips(modes){ const out=[]; for(const m of modes){ if(m && out[out.length-1]!==m) out.push(m); } return seqHtml(out.map(m=>`<span class="leg-line mode-chip" style="background:${MODE_COLOR[m]||MODE_COLOR.other}" title="${esc({bus:'Autobus',pks:'Autobus podmiejski',train:'Pociąg',car:'Samochód',plane:'Samolot',stay:'Pobyt'}[m]||'')}"><i class="fa-solid fa-${MODE_ICON[m]}" aria-hidden="true"></i></span>`)); }
const planeChip=icon=>`<span class="leg-line" style="background:${MODE_COLOR.plane}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`;
function chosenXfer(P, f){
  if(P.xferPick==='skip') return 'skip';
  return P.xferPick?airportOptions(P,f)?.options?.find(x=>x.id===P.xferPick)||null:null;
}
const XFER_MODE={rail:'train', metro:'train', tram:'train', bus:'bus', taxi:'car', ferry:'car'};
function journeyRow(P, f){
  const xo=chosenXfer(P,f), o=pickedAccess(P,f), onward=xo==='skip'?['car']:xo?[XFER_MODE[xo.kind]||'bus']:f.fromAirportKm>=1?['car']:[];
  const modes=[...mainModes(o?.steps), 'plane', ...onward];
  if(f.ret) modes.push('stay', ...onward, 'plane', ...mainModes(o?.back?.steps||(o?.id==='car'?[{icon:'car'}]:[])));
  return `<div class="fl-access fl-journey"><span class="fl-access-lbl">Cała podróż</span>${modeChips(modes)}</div>`;
}
// Cena za osobę rozbita na środki transportu. Bilety autobusu, PKS i pociągu dojdą później; na razie są miejscem na nie.
function priceSplit(P, f){
  if(f.placeholder) return '';
  const c=tripCosts(P,f);
  return `<ul class="price-split">${c.rows.map(r=>`<li><span><i class="fa-solid fa-${esc(r.icon)}" aria-hidden="true"></i> ${esc(r.label.replace(/ · .*$/,''))}</span><b>${r.value==null?'—':zl(r.value)}</b></li>`).join('')}</ul>`;
  const o=pickedAccess(P,f), p=o?.parts||{}, line=(m,name,value)=>`<li><span><i class="fa-solid fa-${MODE_ICON[m]||'route'}" style="color:${MODE_COLOR[m]||MODE_COLOR.other}" aria-hidden="true"></i> ${name}</span><b>${value}</b></li>`;
  const lines=[line('plane','Lot',eurPln(fareTotal(f), eurSum(f)))];
  if(p.bus) lines.push(line('bus','Autobus ZTM',zl(p.bus)));
  if(p.pks) lines.push(line('pks','Autobus podmiejski',`${p.pksEstimated?'ok. ':''}${zl(p.pks)}`));
  if(p.train) lines.push(line('train','Pociąg (szacunek)',`ok. ${zl(p.train)}`));
  if(p.car) lines.push(line('car','Samochód (paliwo)',`ok. ${zl(p.car)}`));
  const xo=chosenXfer(P,f);
  if(xo && xo!=='skip') lines.push(line(XFER_MODE[xo.kind]||'bus',`Lotnisko ↔ centrum${f.ret?' (2×)':''}`,xo.fare?.pln!=null?`ok. ${zl(xo.fare.pln*(f.ret?2:1))}`:'—'));
  if(o && !Object.values(p).some(v=>typeof v==='number'&&v>0) && o.cost==null) lines.push(line('route','Dojazd na lotnisko','—'));
  if(f.fromAirportKm>=1) lines.push(line('car','Dojazd do celu','—'));
  return `<ul class="price-split">${lines.join('')}</ul>`;
}
// Rozbicie ceny i bagaż w oknie, żeby karta lotu pokazywała tylko cenę.
const BAGGAGE_NOTE='W cenie lotu jest mała torba pod siedzenie, bez większego bagażu i wyboru miejsca. Większy bagaż dokupisz u przewoźnika.';
function priceInfo(P, f){
  if(f.placeholder) return '';
  const html=priceSplit(P,f)+`<p class="pv-info-note"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> ${esc(BAGGAGE_NOTE)}</p>`
    +`<p class="pv-info-note">Bilety autobusowe i kolejowe to szacunek ceny normalnej; samochód to koszt paliwa. Aktualną cenę potwierdzisz u przewoźnika.</p>`;
  return infoButton('Rozbicie ceny','Rozbicie ceny',html,{icon:'receipt', cls:'btn-ghost fl-update pv-info-btn'});
}
// Cena za osobę razem z lotem dla wybranego sposobu dojazdu na lotnisko (tak jak w tabeli porównania).
function priceHeadline(P, f){
  const o=pickedAccess(P,f), flight=fareTotal(f), total=o?.cost!=null?tripCosts(P,f).total:null;
  const how=o?o.title:'';
  return `<b>${total!=null?'ok. '+total:flight} zł</b><small>${total!=null?`Razem za ${peopleText(P.people||1)}${f.ret?', w obie strony':''}`:`Lot za 1 osobę${f.ret?', w obie strony':''}`}</small>${how?`<small class="ps-how">${esc(how)}${o.cost!=null?'':' · koszt dojazdu nieznany'}</small>`:'<small class="ps-how">liczę dojazd…</small>'}`;
}
function flightPlanCard(f, P, badge){
  const key=offerKey(f), open=!!P.planOpen, options=P.access.get(key); FL.byKey.set(fareKey(f),f);
  const ground=(icon,text)=>`<div class="fl-access"><span class="fl-access-lbl">${text}</span>${icon}</div>`;
  const onward=(km,text)=>km>=1?ground(`${seqIcon('car',MODE_COLOR.car)} <span class="text-soft">ok. ${fmtKm(km)}</span>`, text):'';
  return `<div class="fl-card plan-fl ${open?'open':''}">
    <div class="fl-legs"><div class="pc-badges">${badge||''}</div>
      ${journeyRow(P,f)}
      ${options==null?'<div class="fl-access text-soft"><span class="spin sm" aria-hidden="true"></span> liczę dojazd na lotnisko…</div>':''}
      ${legRow(f,'Wylot')}${timesRow(f)}${legUpdate(f)}
      ${onward(f.fromAirportKm, 'Z lotniska do celu')}
      ${f.ret?legRow(f.ret,'Powrót')+timesRow(f.ret)+legUpdate(f.ret)+onward(f.ret.homeKm, 'Z lotniska do domu'):''}
      ${f.placeholder?`<div class="fl-incl"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Przykładowy lot: godziny i cenę poznasz po sprawdzeniu u przewoźnika.${f.airlines.length?` Tą trasą lata ${esc(f.airlines.map(x=>AIRLINES[x]?.name||x).join(', '))}.`:''}</div>`:`<div class="fl-incl"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> W cenie: mała torba pod siedzenie${isSampleFare(f)?' · próbka':''}</div>`}
      ${open?`<div class="trip-open">${accessHtml(P,f)}</div>`:''}
    </div>
    <div class="fl-pricebox">${f.placeholder?'<b>—</b><small>Cena po sprawdzeniu u przewoźnika</small>':`${priceHeadline(P,f)}${f.priceUnknown||f.ret?.priceUnknown?'<small>Wizz Air: cena wybranej godziny jeszcze nieznana, liczymy najniższą cenę dnia</small>':f.priceType==='list'||f.ret?.priceType==='list'?'<small>Wizz Air: najtańszy lot dnia</small>':''}${priceInfo(P,f)}`}<button class="btn-grad" type="button" data-open-flight="plan" aria-expanded="${open}">${open?'Zwiń szczegóły':'Zobacz szczegóły'}</button>${alertButton(f)}</div>
  </div>`;
}
// Wizz Air podaje bez wyszukiwania tylko najtańszy lot dnia; cenę innego lotu albo dnia bez ceny pobiera tracker.
function alertButton(f){
  if(!f.from||!f.to) return '';
  return `<button class="btn-ghost fl-update" type="button" data-alert-fare="${esc(fareKey(f))}"><i class="fa-solid fa-bell" aria-hidden="true"></i> Powiadom o cenie</button>`;
}
function alertFromFare(f){
  return {from:f.from, to:f.to, day:f.day, back:f.ret?.day||'', airline:f.placeholder?'':f.airline, price:f.placeholder?null:fareTotal(f), label:`${f.fromLabel||f.from} → ${f.toLabel||f.to}`};
}
/* ---------- Alerty cenowe ---------- */
const ALERTS={list:[], loaded:false, draft:null};
const ALERT_EVERY={3:'co 3 godziny', 6:'co 6 godzin', 12:'co 12 godzin', 24:'raz dziennie', 72:'co 3 dni', 168:'raz w tygodniu'};
const alertModalEl=document.getElementById('alertModal'); const alertModal=new bootstrap.Modal(alertModalEl);
async function loadAlerts(){
  if(document.body.classList.contains('guest')){ ALERTS.list=[]; ALERTS.loaded=true; return; }
  try{ const r=await fetch('/api/alerts'); if(r.ok){ ALERTS.list=(await r.json()).alerts; ALERTS.loaded=true; } }
  catch(e){ console.warn('Alerty cenowe', e); }
  document.getElementById('favLink').classList.toggle('has-alert', ALERTS.list.some(a=>a.reached));
  renderAlertsBtn();
  if(S.sub==='ulubione') renderFavorites(); else if(S.sub==='trip') renderTripPage();
}
function openAlertDialog(a){
  if(document.body.classList.contains('guest')){ location.href=ONW.loginUrl(location.pathname); return; }
  ALERTS.draft=a;
  document.getElementById('alertInfo').textContent=`${a.label||a.from+' → '+a.to} · ${fmtDay(a.day)}${a.back?' – '+fmtDay(a.back):''}${a.airline?' · '+(AIRLINES[a.airline]?.name||a.airline):''}`;
  document.getElementById('alertPrice').value=a.price?Math.max(1,Math.floor(a.price*0.9)):'';
  document.getElementById('alertHint').textContent=a.price?`Obecnie najtaniej: ${a.price} zł${a.back?' w obie strony':''}. Proponujemy limit o 10% niższy.`:'Nie znamy jeszcze ceny tego lotu; pierwsze sprawdzenie nastąpi w ciągu kilku minut.';
  document.getElementById('alertErr').textContent='';
  alertModal.show();
}
document.getElementById('alertForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const a=ALERTS.draft, err=document.getElementById('alertErr'), save=document.getElementById('alertSave'); if(!a) return;
  err.textContent=''; save.disabled=true;
  try{
    const r=await fetch('/api/alerts',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from:a.from, to:a.to, day:a.day, back:a.back, airline:a.airline, label:a.label, maxPrice:document.getElementById('alertPrice').value, everyHours:+document.getElementById('alertEvery').value})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ err.textContent=body.error||'Nie udało się zapisać alertu.'; return; }
    alertModal.hide(); await loadAlerts();
  }catch(e2){ console.warn('Alert cenowy', e2); err.textContent='Nie udało się zapisać alertu.'; }
  finally{ save.disabled=false; }
});
async function removeAlert(id){
  try{ await fetch('/api/alerts/'+encodeURIComponent(id),{method:'DELETE'}); }catch(e){ console.warn('Alert cenowy', e); }
  await loadAlerts();
}
sessionUser.then(user=>{ if(user) loadAlerts(); }).catch(()=>{});
// Urządzenie, które wcześniej włączyło powiadomienia, odświeża swoją subskrypcję po zalogowaniu.
sessionUser.then(user=>{ if(user) window.PVPUSH?.resume(); }).catch(()=>{});

// Każdy lot ma własny przycisk: brakującą godzinę, cenę wybranej godziny albo nowszą cenę pobiera tracker tylko dla tego lotu.
function legUpdate(f){
  if(!f.from||!f.to) return '';
  // Wizz Air pokazuje automatycznej przeglądarce „brak lotów”, więc jego cenę sprawdza się na stronie przewoźnika,
  // a administrator może wczytać zapisaną stamtąd stronę (HAR).
  if(f.airline==='WIZZ'){
    // Cena wybranej godziny z rozkładu Wizz Air (wąskie okno czasu wokół odlotu); bez godziny nie ma o co pytać.
    const key=fareKey(f), busy=FL.updating.has(key); FL.byKey.set(key,f);
    const ask=f.departure&&f.priceType==='list'?`<button class="fl-leg-update" type="button" data-wizz-time="${esc(key)}" ${busy?'disabled aria-busy="true"':''}>${busy?'<span class="spin sm" aria-hidden="true"></span> Pytam Wizz Air…':'<i class="fa-solid fa-rotate" aria-hidden="true"></i> Pobierz cenę tej godziny'}</button>`:'';
    const note=FL.wizzNote?.get(key)?`<small class="text-soft">${esc(FL.wizzNote.get(key))}</small>`:'';
    return `<span class="fl-leg-tools">${ask}${f.bookingUrl?`<a class="fl-leg-update" href="${esc(f.bookingUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Sprawdź na wizzair.com</a>`:''}${note}</span>`;
  }
  if(!f.placeholder && f.airline!=='RYANAIR') return '';
  const key=fareKey(f); FL.byKey.set(key,f);
  const label=f.placeholder?'Pobierz lot i cenę':f.priceType==='list'&&f.times?.length?'Pobierz cenę tej godziny':!f.departure?'Pobierz godzinę lotu':'Zaktualizuj cenę';
  const busy=FL.updating.has(key);
  return `<button class="fl-leg-update" type="button" data-update-fare="${esc(key)}" ${busy?'disabled aria-busy="true"':''}>${busy?'<span class="spin sm" aria-hidden="true"></span> Aktualizuję…':`<i class="fa-solid fa-rotate" aria-hidden="true"></i> ${label}`}</button>`;
}
function fareUpdateButton(f){
  if(f.placeholder) return f.airlines?.length&&f.from&&f.to?`<button class="btn-ghost fl-update" type="button" data-update-fare="${esc(fareKey(f))}"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Pobierz cenę</button>`:'';
  if(!['WIZZ','RYANAIR'].includes(f.airline)) return '';
  return `<button class="btn-ghost fl-update" type="button" data-update-fare="${esc(fareKey(f))}"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Zaktualizuj cenę</button>`;
}
// Zapytanie o cenę jednej godziny lotu (Wizz Air albo Ryanair); serwer czeka na odpowiedź i zapisuje ją w bazie.
async function wizzTimePrice(P, f){
  const key=fareKey(f), name=f.airline==='RYANAIR'?'Ryanair':'Wizz Air'; FL.updating.add(key); (FL.wizzNote||(FL.wizzNote=new Map())).delete(key); runPlan(false);
  let note='';
  try{
    const r=await fetch(f.airline==='RYANAIR'?'/api/flights/ryanair-time':'/api/flights/wizz-time',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from:f.from, to:f.to, time:f.departure})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) note=body.error||`Nie udało się zapytać ${name}.`;
    else if(body.fresh) note='Tę godzinę sprawdzaliśmy w ciągu ostatnich 30 minut.';
    else if(body.unsold) note=`${name} nie sprzedaje już biletów na ten lot (wyprzedany albo sprzedaż zamknięta).`;
    else if(!body.stored) note=`${name} nie podał ceny tej godziny.`;
  }catch(e){ console.warn(name, e); note=`Nie udało się zapytać ${name}.`; }
  FL.updating.delete(key);
  if(note) FL.wizzNote.set(key, note);
  if(inPlan(P)) loadTripFlights(P);
}
// Aktualna cena jednego lotu, tylko na życzenie: wiersz tego lotu jest wyszarzony, reszta planu działa dalej.
// Wizz Air odpowiada od razu dla wybranej godziny; Ryanair sprawdza tracker, więc czekamy, aż skończy.
async function updateFare(P, f){
  if(document.body.classList.contains('guest')){ toast('Zaloguj się, aby sprawdzić aktualną cenę u przewoźnika.'); return; }
  if(['WIZZ','RYANAIR'].includes(f.airline) && f.departure && !f.placeholder) return wizzTimePrice(P,f);
  const key=fareKey(f); if(FL.updating.has(key)) return;
  FL.updating.add(key); (FL.wizzNote||(FL.wizzNote=new Map())).delete(key); runPlan(false);
  let note='';
  try{
    const r=await fetch('/api/flights/fare',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from:f.from, to:f.to, day:f.day, airline:f.placeholder?'':f.airline})});
    const body=await r.json().catch(()=>({}));
    if(r.status===202 || r.status===409){
      for(let i=0;i<120;i++){ await new Promise(res=>setTimeout(res,5000)); const st=await fetch('/api/flights/status').then(x=>x.json()).catch(()=>null); if(!st?.running) break; }
    } else if(r.status===503) note='Na tym serwerze nie da się teraz zapytać przewoźnika.';
    else if(r.ok && body.reason==='fresh') note='Tę cenę sprawdzaliśmy w ciągu ostatniej godziny.';
    else if(!r.ok) note=body.error||'Nie udało się zapytać przewoźnika.';
  }catch(e){ console.warn('Aktualizacja ceny', e); note='Nie udało się zapytać przewoźnika.'; }
  FL.updating.delete(key);
  if(note) FL.wizzNote.set(key, note);
  if(inPlan(P)) loadTripFlights(P);
}
function nearbyCheaper(P){
  const days=P.flights.days||[], date=P.date||ymdOf(0), cur=days.find(d=>d.day===date)?.cheapest;
  const near=days.filter(d=>d.day!==date && Math.abs(Date.parse(d.day)-Date.parse(date))<=2*86400000); if(!near.length) return null;
  const best=near.reduce((x,y)=>y.cheapest<x.cheapest?y:x);
  return cur==null||best.cheapest<cur ? {...best, saves:cur==null?null:cur-best.cheapest} : null;
}
// Wszystkie loty na wybrane dni z obu linii: wylot i powrót osobno. Domyślnie plan startuje z najbliższego
// lotniska, z którego da się polecieć do celu; preferowane lotnisko jest oznaczone i można je wybrać jednym kliknięciem.
// Odloty Wizz Air bez własnej ceny (priceUnknown) nie są wybierane domyślnie ani oznaczane jako najtańsze.
const cheapestOf=all=>{ const known=all.filter(f=>!f.priceUnknown), list=known.length?known:all; return list.length?list.reduce((a,b)=>b.pricePln<a.pricePln?b:a):null; };
const flightLeavesAfter=(out, ret)=>ret.day!==out.day || !!(ret.departure && out.arrival && ret.departure>out.arrival);
function flightChoice(P){
  const F=P.flights, outs=F.outbound?.length?F.outbound:F.options.map(o=>{ const {ret, returns, ...out}=o; return out; }), ins=F.inbound||[];
  const kmOf=code=>(F.originAirports||[]).find(a=>a.code===code)?.km ?? Infinity;
  const closest=outs.length?outs.reduce((a,b)=>kmOf(b.from)<kmOf(a.from)?b:a).from:null;
  const out=outs.find(f=>fareKey(f)===P.selOut) || cheapestOf(outs.filter(f=>f.from===closest)) || outs[0];
  let ret=null;
  if(P.round && out){
    const ok=ins.filter(r=>flightLeavesAfter(out,r));
    ret=ok.find(r=>fareKey(r)===P.selRet) || cheapestOf(ok.filter(r=>r.to===out.from)) || cheapestOf(ok);
  }
  return {outs, ins, closest, kmOf, out, ret};
}
// Ceny pochodzą z bazy; każda ma datę sprawdzenia. Świeża (do 45 min) jest „aktualna”, starsza mówi, ile ma lat.
const PRICE_STALE_MIN=180;
const priceAgeMin=f=>{ const t=Date.parse(f?.collectedAt||''); return Number.isFinite(t)?Math.max(0,Math.round((Date.now()-t)/60000)):null; };
function priceAge(f){
  const m=priceAgeMin(f); if(m==null) return '';
  if(m<45) return 'cena aktualna';
  if(m<60*36){ const h=Math.max(1,Math.round(m/60)); return `cena sprzed ${h} godz.`; }
  const d=Math.round(m/1440); return `cena sprzed ${d} ${d===1?'dnia':'dni'}`;
}
function flightPickRows(P, list, kind, picked, C){
  if(!list.length) return `<div class="empty-note">${stateIll(assetPaths.flightConnection,200,117)}${kind==='out'?'Brak lotów w tym dniu — wybierz inny dzień wylotu na pasku powyżej.':'Brak lotów powrotnych w tym dniu — wybierz inny dzień powrotu na pasku powyżej.'}</div>`;
  const known=list.filter(f=>!f.priceUnknown), best=known[0], cheap=Math.min(...known.map(f=>f.pricePln)), home=kind==='out'?'from':'to';
  const byTime=[...list].sort((a,b)=>(a.departure||'99').localeCompare(b.departure||'99') || a.pricePln-b.pricePln);
  return `<div class="fl-table" role="radiogroup" aria-label="${kind==='out'?'Wylot':'Powrót'}">${byTime.map(f=>{
    const key=fareKey(f), on=f===picked, x=airlineOf(f), km=C.kmOf(f[home]); FL.byKey.set(key,f);
    const marks=[f===best?'<span class="pc-badge">Najlepszy</span>':'', !f.priceUnknown&&f.pricePln===cheap?'<span class="pc-badge cheap">Najtańszy</span>':'', P.prefer&&f[home]===P.prefer?'<span class="pc-badge alt">Preferowane lotnisko</span>':'', f[home]===C.closest?'<span class="pc-badge near">Najbliższe lotnisko</span>':''].join('');
    const busy=FL.updating.has(key), age=priceAgeMin(f), note=FL.wizzNote?.get(key);
    const refresh=busy?'':(f.priceUnknown||age==null||age>=45)&&['WIZZ','RYANAIR'].includes(f.airline)?`<span class="fl-refresh" role="button" tabindex="0" data-row-refresh="${esc(key)}" title="Sprawdź aktualną cenę u przewoźnika"><i class="fa-solid fa-rotate" aria-hidden="true"></i> ${f.priceUnknown?'Pobierz cenę':'Odśwież cenę'}</span>`:'';
    return `<button type="button" class="fl-row ${on?'on':''} ${busy?'updating':''}" role="radio" aria-checked="${on}" ${busy?'aria-busy="true"':''} data-pick-flight="${kind}" data-key="${esc(key)}">
      <span class="fl-radio" aria-hidden="true"></span>
      <span class="fl-airline" style="--a:${x.color}">${AIRLINE_PLANE[f.airline]?`<i class="fa-solid fa-plane" style="color:${AIRLINE_PLANE[f.airline]}" aria-hidden="true"></i> `:''}${esc(x.name)}</span>
      <span class="fl-route"><b>${esc(f.from)} → ${esc(f.to)}</b><small>${esc(kind==='out'?f.fromLabel:f.toLabel)}${Number.isFinite(km)?` · ${km} km od startu`:''}</small></span>
      <span class="fl-when"><b>${clockOf(f.departure)||'—'}${f.arrival?' – '+arrivalOf(f):''}</b><small>${esc([f.flightNumber, durationOf(f)].filter(Boolean).join(' · '))}${f.times?.length>1?` · ${f.times.length} odloty`:''}${f.stops?' · '+changesText(f.stops):''}</small></span>
      <span class="fl-marks">${marks}</span>
      <span class="fl-price">${busy?`<b><span class="spin sm" aria-hidden="true"></span></b><small>Sprawdzam cenę u przewoźnika…</small>`:f.priceUnknown?`<b>—</b><small>${note?esc(note):'brak ceny w bazie'}</small>${refresh}`:`<b>${f.priceType==='list'&&f.airline==='WIZZ'?'od ':''}${eurPln(Math.round(f.pricePln), eurOf(f))}</b>${f.priceType==='list'?'<small>cena najtańszego lotu dnia</small>':''}<small class="fl-age ${(age||0)>=PRICE_STALE_MIN?'old':''}">${priceAge(f)}</small>${note?`<small class="fl-note">${esc(note)}</small>`:''}${refresh}`}</span></button>`;
  }).join('')}</div>`;
}
// Promień lotnisk może wykluczyć wszystkie lotniska z lotami do celu; wtedy proponujemy najbliższe takie lotnisko.
const RADIUS_STEPS=[100,150,200,300,400,600];
// Podpowiedzi do wyboru lotów w panelu obok listy, pogrupowane według wagi: najpierw to, co wymaga uwagi,
// potem okazje (inne dni), na końcu lotniska. Każda podpowiedź to krótki tytuł, jedno zdanie i ewentualnie przycisk.
function flightHints(P, C){
  const F=P.flights, first=F.first, groups={warn:[], save:[], info:[]}, date=P.date||ymdOf(0);
  const airport=code=>(F.originAirports||[]).find(a=>a.code===code);
  const label=code=>{ const a=airport(code); return a?`${a.city} (${a.code}, ${a.km} km)`:code; };
  const hint=(icon,title,body,action='')=>`<div class="fh-item"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><div class="fh-body"><b>${title}</b>${body}${action?`<div class="fh-action">${action}</div>`:''}</div></div>`;
  const dayBtn=d=>`<button class="btn-ghost" type="button" data-day="${d}">Pokaż ${fmtDay(d)}</button>`;
  const line=t=>`<span class="fh-line">${t}</span>`;
  // Ważne
  const preferFlies=P.prefer && C.outs.some(f=>f.from===P.prefer);
  if(P.prefer && C.closest && C.closest!==P.prefer && !preferFlies){
    const unknown=first?.preferred && !first.fare;
    groups.warn.push(hint('location-crosshairs','Preferowane lotnisko bez lotów',
      line(esc(unknown?`Z lotniska ${P.prefer} nie znamy jeszcze żadnego lotu do celu.`:airport(P.prefer)?`Z lotniska ${P.prefer} nie ma w tym dniu lotów do celu.`:`Lotnisko ${P.prefer} leży dalej niż wybrany promień.`))+
      line(esc(`Plan startuje z lotniska ${label(C.closest)}.`))));
  } else if(first && !first.fare){
    groups.warn.push(hint('calendar-xmark','Brak znanych lotów', line(esc(`Z ${first.preferred?'preferowanego lotniska':'najbliższego lotniska z lotami do celu'} ${first.fromLabel} nie znamy jeszcze żadnego lotu do celu.`))));
  }
  const out=C.out, ret=C.ret;
  if(out && ret && ret.to!==out.from) groups.warn.push(hint('triangle-exclamation','Powrót na inne lotnisko', line(esc(`Wylot z ${out.fromLabel}, powrót na ${ret.toLabel}.`))));
  // Okazje
  const b=nearbyCheaper(P);
  if(b) groups.save.push(hint('piggy-bank','Taniej o ±2 dni', line(`<b>${fmtDay(b.day)}</b> · <span>wylot od ${b.cheapest} zł</span>${b.saves?` <span class="fh-saves">−${b.saves} zł</span>`:''}`), dayBtn(b.day)));
  if(first?.fare && first.fare.day!==date){
    const f=first.fare;
    groups.save.push(hint('calendar-check','Pierwszy dostępny lot', line(`<b>${fmtDay(f.day)}${f.departure?' '+clockOf(f.departure):''}</b> · <span>${esc(airlineOf(f).name)}</span> · <span>${f.priceType==='list'?'od ':''}${Math.round(f.pricePln)} zł</span>`)+line(esc(`z lotniska ${first.fromLabel}`)), dayBtn(f.day)));
  }
  // Lotniska
  if(P.prefer && C.closest && C.closest!==P.prefer && preferFlies)
    groups.info.push(hint('location-crosshairs','Start z najbliższego lotniska', line(esc(`Plan startuje z lotniska ${label(C.closest)}.`))+line(esc(`Loty z ${P.prefer} też są na liście.`))));
  const near=(F.originAirports||[]).filter(a=>C.outs.some(f=>f.from===a.code));
  if(near.length) groups.info.push(hint('tower-control','Lotniska z lotami do celu', line(esc(`w ${radiusText()}`))+`<div class="fh-chips">${near.map(a=>`<span class="fh-chip ${a.code===C.closest?'near':''} ${a.code===P.prefer?'pref':''}"><b>${esc(a.code)}</b> ${esc(a.city)} · ${a.km} km</span>`).join('')}</div>`));
  const names={warn:['Ważne','circle-exclamation'], save:['Okazje','tags'], info:['Lotniska','plane-departure']};
  const html=Object.entries(groups).filter(([,list])=>list.length).map(([k,list])=>`<section class="fh-group fh-${k}"><h5><i class="fa-solid fa-${names[k][1]}" aria-hidden="true"></i> ${names[k][0]}</h5>${list.join('')}</section>`).join('');
  return html?`<aside class="fl-hints" aria-label="Podpowiedzi">${html}</aside>`:'';
}
// Podróż samolotem w trzech krokach: najpierw loty tam i z powrotem, potem dojazd na lotnisko, na końcu krótki plan.
// Szczegóły (przesiadki, peron, czas lotu, ceny składowe) pokazują się dopiero po „Zobacz szczegóły”.
function stepBar(P, f){
  const cur=P.flightStep||1, fetching=ASK_NOTES[P.fetch];
  // Wspólny kompaktowy pasek kroków (app.ui.js): wybory z kroków zostają w P, więc powrót do kroku ich nie gubi.
  const steps=wizardSteps(P).map(([n,name])=>({label:name, info:n<=cur?stepInfo(P,f,n):''}));
  return `<div class="fl-stepbar">${PVUI.stepper(steps, cur, {attr:'data-flight-step', extra:fetching?`<span class="fl-fetching"><span class="spin sm" aria-hidden="true"></span> ${esc(fetching)}</span>`:''})}</div>`;
}
// Gdy wylot jest z innego lotniska niż powrót, trzeba o tym wiedzieć przed wyborem dojazdu.
function airportMismatch(out, ret){
  if(!out||!ret||ret.to===out.from) return '';
  return `<div class="fl-mismatch" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> <span>Wylatujesz z lotniska <b>${esc(out.fromLabel)}</b>, a wracasz na <b>${esc(ret.toLabel)}</b>. Powrót do domu będzie z innego lotniska niż wyjazd.</span></div>`;
}
function chosenFlights(f){
  const leg=(x,label)=>`<span class="fl-chosen-leg"><b>${label}</b> ${esc(x.from)} ${clockOf(x.departure)||''} → ${esc(x.to)} ${arrivalOf(x)||''} · ${fmtDay(x.day)} · ${esc(airlineOf(x).name)}</span>`;
  return `<div class="fl-chosen">${leg(f,'Wylot')}${f.ret?leg(f.ret,'Powrót'):''}<button type="button" class="btn-ghost" data-flight-step="1">Zmień loty</button></div>`;
}
// Koszt wybranych lotów przy przycisku „Dalej”: wylot + powrót, a przy kilku osobach także razem.
function flightCost(P, C){
  const n=Math.max(1,P.people||1), part=(f,label)=>f&&!f.priceUnknown?{label, value:Math.round(f.pricePln)}:f?{label, value:null}:null;
  const parts=[part(C.out,'wylot'), part(C.ret,'powrót')].filter(Boolean); if(!parts.length) return '';
  const sum=parts.every(p=>p.value!=null)?parts.reduce((s,p)=>s+p.value,0):null;
  return `<div class="fl-cost"><small>Koszt lotów${n>1?' na osobę':''}</small><span>${parts.map(p=>`${p.label} <b>${p.value!=null?eurPln(p.value):'—'}</b>`).join(' + ')}${parts.length>1&&sum!=null?` = <b>${eurPln(sum)}</b>`:''}</span>${n>1&&sum!=null?`<small>za ${peopleText(n)}: <b>${sum*n} zł</b></small>`:''}</div>`;
}
function stepNav(back, next, label, middle=''){
  return `<div class="fl-nav">${back?`<button type="button" class="btn-ghost" data-flight-step="${back}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Wstecz</button>`:'<span></span>'}${middle}${next?`<button type="button" class="btn-grad btn-next" data-flight-step="${next}">${label} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`:''}</div>`;
}
// Zapisany plan: gdy jego lot jest na liście, od razu pokazujemy krok „Plan podróży” z tymi samymi wyborami.
function applyRestore(P){
  const R=P.restore; if(!R || !P.flights) return;
  const F=P.flights, outs=F.outbound?.length?F.outbound:F.options||[];
  if(outs.some(f=>fareKey(f)===R.out)){
    P.selOut=R.out; if(R.ret && (F.inbound||[]).some(f=>fareKey(f)===R.ret)) P.selRet=R.ret;
    P.flightStep=R.xfer?4:3; P.accessWanted=R.access||null; P.xferPick=R.xfer||null; P.saved=R.tid||null; P.restore=null;
  } else if(!ASK_NOTES[P.fetch]){ P.restore=null; P.restoreMissed=true; }
}
function tripFlights(P){
  applyRestore(P);
  const C=flightChoice(P);
  if(!C.out) return flightNote(P);
  const offer={...C.out, ret:C.ret||null, returns:[]};
  if(P.accessWanted){ (P.accessPick||(P.accessPick=new Map())).set(offerKey(offer), P.accessWanted); P.accessWanted=null; }
  ensureAccessAll(P,[offer]); // liczy się w tle już przy wyborze lotów
  const step=P.flightStep||1, day=d=>fmtDay(d);
  P.destAirport=offer.to; airportTransfer(offer.to,P);
  if(step===1){
    const ready=!P.round || !!C.ret;
    // Koszt wybranych lotów jako karta w prawej kolumnie (pod podpowiedziami); bez kolumny — przy przycisku „Dalej”.
    const cost=ready?flightCost(P,C):'', side=flightHints(P,C)||(cost?'<aside class="fl-hints" aria-label="Podpowiedzi"></aside>':'');
    const hints=cost?side.replace(/<\/aside>$/, `<section class="fh-group fh-cost"><h5><i class="fa-solid fa-wallet" aria-hidden="true"></i> ${(P.people||1)>1?'Koszt lotów na osobę':'Koszt lotów'}</h5>${cost}</section></aside>`):side;
    const missed=P.restoreMissed?'<div class="fl-mismatch" role="status"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> <span>Zapisanego lotu nie ma już w rozkładzie. Wybierz inny lot.</span></div>':'';
    return stepBar(P,offer)+missed+`<div class="fl-step1 ${hints?'has-hints':''}"><div class="fl-step1-main">`+
      `<div class="fl-fresh"><span><i class="fa-solid fa-database" aria-hidden="true"></i> Ceny zapisane w bazie — przy każdej widać, kiedy była sprawdzona.</span>${document.body.classList.contains('guest')?'':'<button type="button" class="btn-ghost" data-ask-airlines><i class="fa-solid fa-rotate" aria-hidden="true"></i> Sprawdź aktualne ceny wszystkich lotów</button>'}</div>`+
      `<div class="fl-board"><h4 class="fl-board-title"><i class="fa-solid fa-plane-departure" aria-hidden="true"></i> Wylot · ${day(C.out.day)} <small>${C.outs.length} lotów</small></h4>${flightPickRows(P,C.outs,'out',C.out,C)}`+
      (P.round?`<h4 class="fl-board-title"><i class="fa-solid fa-plane-arrival" aria-hidden="true"></i> Powrót · ${day(P.round.back)} <small>${C.ins.length} lotów</small></h4>${flightPickRows(P,C.ins.filter(r=>flightLeavesAfter(C.out,r)),'ret',C.ret,C)}`:'')+
      `</div>`+(ready?stepNav(0,2,'Dalej: dojazd na lotnisko'):'')+`</div>${hints}</div>`;
  }
  const options=P.access.get(offerKey(offer));
  if(step===2){
    const o=pickedAccess(P,offer);
    return stepBar(P,offer)+chosenFlights(offer)+airportMismatch(offer,offer.ret)+
      (options==null?searching('Liczę dojazd na lotnisko…'):options.length?compareHtml(P,offer,options,o)+(o?accessDetails(P,offer,o):''):'<div class="empty-note">Nie znaleźliśmy dojazdu na lotnisko wybranymi środkami transportu. Zaznacz więcej opcji.</div>')+
      stepNav(1,options?.length?3:0,destIsAirport(P,offer.to)?'Dalej: z lotniska do centrum':'Dalej: na miejscu');
  }
  if(step===3) return stepBar(P,offer)+chosenFlights(offer)+cityStep(offer,P)+(P.xferPick?stepNav(2,4,'Dalej: plan podróży'):stepNav(2,0,'')+'<div class="empty-note cs-need">'+stateIll(assetPaths.airportTransfer,200,117)+'Wybierz sposób dojazdu albo „Pomiń — ktoś mnie odbierze”, aby zobaczyć cały plan podróży.</div>');
  return stepBar(P,offer)+planSummaryCard(offer,P)+`<div class="plan-extra">${costSummary(tripCosts(P,offer))}${weatherTimeline(planWeatherPoints(P,offer), ()=>{ if(inPlan(P)) runPlan(false); })}</div>`+(S.multi&&S.multi.cur!=='save'?multiLegBar(P,'flight'):tripSaveBar(P,offer,airportOptions(P,offer)))+stepNav(3,0,'');
}
/* ---------- Dojazd na lotnisko: kroki, trasa na mapie i Mapy Google ---------- */
function accessLinks(P, f, o){
  const a=P.origin?.points?.[0], b=f.airport?[f.airport.lat,f.airport.lon]:null;
  const g=a&&b?`https://www.google.com/maps/dir/?api=1&origin=${a[0].toFixed(5)},${a[1].toFixed(5)}&destination=${b[0].toFixed(5)},${b[1].toFixed(5)}&travelmode=${o.id==='car'?'driving':'transit'}`:'';
  const map=o.route?`<button class="btn-ghost" type="button" data-route="${S.planRoutes.push(o.route)-1}"><i class="fa-solid fa-map" aria-hidden="true"></i> Trasa na mapie</button>`:'';
  return map||g?`<div class="acc-links">${map}${g?`<a class="btn-ghost" href="${esc(g)}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> Google Maps</a>`:''}</div>`:'';
}
// Wybrany dojazd: na ekranie jedna linia z przyciskami; trasa krok po kroku (i powrót) otwiera się w oknie.
function accessDetails(P, f, o){
  const steps=(o.steps?.length?stepsHtml(o.steps):'')
    +(o.back?.steps?.length?`<h5 class="acc-back"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Powrót z lotniska ${esc(f.ret?.toLabel||'')} do domu</h5>${stepsHtml(o.back.steps)}`:'');
  return `<div class="acc-detail acc-detail-row"><span class="acc-detail-what"><span class="acc-seq">${modeChips(mainModes(o.steps))}</span> <b>${esc(o.title)}</b></span>
    <div class="acc-links">${infoButton('Trasa krok po kroku',`${o.title} — krok po kroku`,steps,{icon:'list-ol'})}${accessLinks(P,f,o).replace(/^<div class="acc-links">|<\/div>$/g,'')}</div></div>`;
}
/* ---------- Z lotniska do centrum: jak dojść do miejsca odjazdu ---------- */
function walkTo(d, o){
  const from=d?.airport?.lat!=null?`${d.airport.lat},${d.airport.lon}`:'';
  if(o.board?.at && from) return `<a class="cs-walk" href="${esc(`https://www.google.com/maps/dir/?api=1&origin=${from}&destination=${o.board.at[0]},${o.board.at[1]}&travelmode=walking`)}" target="_blank" rel="noopener"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> Jak dojść do odjazdu (mapa)</a>`;
  const q=[o.board?.name||o.name, d?.airport?.name||''].filter(Boolean).join(', ');
  return q?`<a class="cs-walk" href="${esc(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`)}" target="_blank" rel="noopener"><i class="fa-solid fa-map-pin" aria-hidden="true"></i> Gdzie to jest (mapa)</a>`:'';
}
/* ---------- Koszt całej podróży, po częściach, dla wybranej liczby osób ---------- */
// Bilety (lot, autobus, pociąg, dojazd do centrum) płaci każdy; paliwo i taksówkę płaci się za auto:
// do 5 osób w samochodzie, do 4 w taksówce.
const CAR_SEATS=5, TAXI_SEATS=4;
const peopleText=n=>`${n} ${n===1?'osobę':n%10>=2&&n%10<=4&&(n%100<10||n%100>=20)?'osoby':'osób'}`;
function tripCosts(P, f){
  const n=Math.max(1,P.people||1), o=pickedAccess(P,f), xo=chosenXfer(P,f), both=!!f.ret, p=o?.parts||{}, rows=[];
  const add=(group,icon,label,value,note='')=>rows.push({group,icon,label,value:value==null?null:Math.round(value*100)/100,note});
  const each=(price,extra='')=>[price==null?null:price*n, [n>1&&price!=null?`${n} × ${zl(price)}`:'', extra].filter(Boolean).join(' · ')];
  if(!f.placeholder){
    add('Loty','plane-departure',`Wylot ${f.from} → ${f.to} · ${airlineOf(f).name}`,...each(f.pricePln,f.priceUnknown?'cena najtańszego lotu dnia':''));
    if(f.ret && !f.ret.placeholder) add('Loty','plane-arrival',`Powrót ${f.ret.from} → ${f.ret.to} · ${airlineOf(f.ret).name}`,...each(f.ret.pricePln,f.ret.priceUnknown?'cena najtańszego lotu dnia':''));
  }
  const g=`Dojazd na lotnisko${both?' i z powrotem':''}`;
  if(p.bus) add(g,'bus','Autobus ZTM',...each(p.bus));
  if(p.pks) add(g,'bus-simple','Autobus podmiejski',...each(p.pks,p.pksEstimated?'szacunek':''));
  if(p.train) add(g,'train','Pociąg',...each(p.train,'szacunek ceny normalnej'));
  if(p.car){ const cars=Math.ceil(n/CAR_SEATS); add(g,'car','Samochód (paliwo)',p.car*cars,[cars>1?`${cars} auta × ${zl(p.car)}`:`do ${CAR_SEATS} osób w aucie`,'bez parkingu'].join(' · ')); }
  if(o && o.cost==null) add(g,'route',o.title,null,'cena nieznana');
  const x=`Lotnisko ↔ centrum${both?' (tam i z powrotem)':''}`, times=both?2:1;
  if(xo==='skip') add(x,'car-side','Odbiór z lotniska',0);
  else if(xo && xo.kind==='taxi'){ const cabs=Math.ceil(n/TAXI_SEATS); add(x,'taxi',xo.name||'Taksówka',xo.fare?.pln!=null?xo.fare.pln*times*cabs:null,xo.fare?.pln!=null?`${cabs>1?`${cabs} taksówki × `:''}${times>1?'2 × ':''}${zl(xo.fare.pln)} · do ${TAXI_SEATS} osób`:'cena nieznana'); }
  else if(xo) add(x,XMODE[xo.kind]?.[0]||'bus',xo.name||xo.line,xo.fare?.pln!=null?xo.fare.pln*times*n:null,xo.fare?.pln!=null?`${times*n>1?`${times*n} × `:''}${zl(xo.fare.pln)}`:'cena nieznana');
  const total=Math.round(rows.reduce((s,r)=>s+(r.value||0),0));
  return {rows, total, people:n, perPerson:Math.round(total/n), missing:rows.some(r=>r.value==null)};
}
function costCard(c, {head=true}={}){
  if(!c?.rows?.length) return '';
  const n=c.people||1, groups=[...new Set(c.rows.map(r=>r.group))];
  return `<section class="cost-card">${head?`<h4><i class="fa-solid fa-wallet" aria-hidden="true"></i> Koszt podróży za ${peopleText(n)}</h4>`:''}
    ${groups.map(g=>`<div class="cost-group"><small>${esc(g)}</small>${c.rows.filter(r=>r.group===g).map(r=>`<div class="cost-row"><span><i class="fa-solid fa-${esc(r.icon)}" aria-hidden="true"></i>${esc(r.label)}${r.note?` <em>${esc(r.note)}</em>`:''}</span><b>${r.value==null?'—':r.value===0?'0 zł':`${zl(r.value)}`}</b></div>`).join('')}</div>`).join('')}
    <div class="cost-total"><span>Razem</span><span>${c.missing?'od ':'ok. '}${c.total} zł</span></div>
    ${n>1?`<div class="cost-per"><span>Na osobę</span><span>ok. ${Math.round(c.total/n)} zł</span></div>`:''}
    <small class="cost-note">Bilety autobusowe i kolejowe to szacunek ceny normalnej; samochód to koszt paliwa (do ${CAR_SEATS} osób w aucie), taksówka do ${TAXI_SEATS} osób.</small></section>`;
}
// Planer: na ekranie tylko suma i cena na osobę; pozycje i założenia (paliwo, bilety) w oknie „Szczegóły kosztów”.
function costSummary(c){
  if(!c?.rows?.length) return '';
  const n=c.people||1;
  return `<section class="cost-card cost-short"><h4><i class="fa-solid fa-wallet" aria-hidden="true"></i> Koszt podróży za ${peopleText(n)}</h4>
    <div class="cost-total"><span>Razem</span><span>${c.missing?'od ':'ok. '}${c.total} zł</span></div>
    ${n>1?`<div class="cost-per"><span>Na osobę</span><span>ok. ${Math.round(c.total/n)} zł</span></div>`:''}
    ${c.missing?'<small class="cost-note">Części ceny jeszcze nie znamy, więc suma jest dolną granicą.</small>':''}
    <div class="pv-info-row">${infoButton('Szczegóły kosztów',`Koszt podróży za ${peopleText(n)}`,costCard(c,{head:false}),{icon:'receipt'})}</div></section>`;
}
/* ---------- Pogoda po drodze: start, lotniska, cel, powrót — na dzień, w którym tam jesteś ---------- */
function planWeatherPoints(P, f){
  const o=pickedAccess(P,f), pt=x=>Array.isArray(x)?x:x?[x.lat,x.lon]:null, out=[];
  const air=code=>airportPoint(P,code)||(code===f.from&&f.airport?[f.airport.lat,f.airport.lon]:null);
  const add=(icon,label,place,point,day,time)=>{ const p=pt(point); if(p && day) out.push({icon,label,place,lat:Math.round(p[0]*1e4)/1e4,lon:Math.round(p[1]*1e4)/1e4,day,time:time||''}); };
  const home=P.origin?.points?.[0], dest=P.dest?.points?.[0], d=airportOptions(P,f), centre=d?.target?[d.target.lat,d.target.lon]:dest;
  add('house','Start',P.from,home,o?.leave?dayOfTs(o.leave):f.day,o?.leave?fmtClock(o.leave):'');
  add('plane-departure','Wylot',f.fromLabel,air(f.from),f.day,clockOf(f.departure));
  add('plane-arrival','Przylot',f.toLabel,air(f.to)||centre,(f.arrival||'').slice(0,10)||f.day,arrivalOf(f));
  const cityName=String(d?.target?.label||P.to||'').replace(/\s*\([^)]*\)/g,'').trim();
  add('location-dot','Na miejscu',cityName,centre,(f.arrival||'').slice(0,10)||f.day,'');
  if(f.ret){
    add('plane-departure','Powrót',f.ret.fromLabel,air(f.ret.from)||centre,f.ret.day,clockOf(f.ret.departure));
    add('house','W domu',P.from,home,(f.ret.arrival||'').slice(0,10)||f.ret.day,arrivalOf(f.ret));
  }
  return out;
}
// Godzina z karty („22:45”, „~00:49”) → prognoza na tę pełną godzinę (od pół godziny w górę).
function hourAt(hours, time){
  const m=/(\d{1,2}):(\d{2})/.exec(time||''); if(!m || !Array.isArray(hours) || !hours.length) return null;
  const want=Math.min(23, Number(m[1])+(Number(m[2])>=30?1:0));
  return hours.reduce((best,h)=>Math.abs(h[0]-want)<Math.abs(best[0]-want)?h:best, hours[0]);
}
function weatherTimeline(points, rerender){
  if(CFG.weather===false || !points?.length) return '';
  const name=d=>new Date(d+'T12:00:00Z').toLocaleDateString(document.documentElement.lang==='en'?'en-GB':'pl-PL',{weekday:'short', timeZone:'UTC'});
  const cards=points.map(p=>{
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}|${p.day}|${p.day}`;
    let w=TWX.get(key);
    if(!w){
      TWX.set(key,{loading:true});
      fetch('/api/weather?'+new URLSearchParams({lat:p.lat, lon:p.lon, from:p.day, to:p.day})).then(r=>r.ok?r.json():null)
        .then(x=>{ TWX.set(key,x||{error:true}); rerender(); }).catch(()=>TWX.set(key,{error:true}));
      w=TWX.get(key);
    }
    const day=w?.days?.[0], hr=day&&hourAt(day.hours, p.time);
    const wx=w?.loading?'<span class="spin sm" aria-hidden="true"></span>':day?(()=>{ const code=hr?.[3]??day.code, [desc]=wmo(code), rain=hr?hr[2]:day.rainChance;
      return `<div class="wtl-wx" title="${esc(desc)}"><img class="twx-svg" src="${weatherIcon(code)}" alt="" aria-hidden="true" width="26" height="26"><strong>${Math.round(hr?hr[1]:day.max)}°</strong><small>${hr?`${Math.round(day.min)}–${Math.round(day.max)}°`:`${Math.round(day.min)}°`}</small>${rain!=null?`<small class="wtl-rain"><i class="fa-solid fa-droplet" aria-hidden="true"></i> ${rain}%</small>`:''}</div>`; })()
      :w?.availableFrom?`<small>prognoza od ${fmtDay(w.availableFrom)}</small>`:'<small>brak prognozy</small>';
    return `<div class="wtl-item"><i class="fa-solid fa-${esc(p.icon)}" aria-hidden="true"></i><small>${esc(p.label)} · ${esc(name(p.day))} ${fmtDay(p.day)}${p.time?' '+esc(p.time):''}</small><b>${esc(p.place)}</b>${wx}</div>`;
  }).join('');
  return `<section class="wtl"><h4><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> Pogoda po drodze</h4><div class="wtl-line">${cards}</div></section>`;
}
// Krótki plan: główne środki transportu i najważniejsze godziny; reszta po „Zobacz szczegóły”.
function planSummaryCard(f, P){
  const o=pickedAccess(P,f), open=P.planOpen!==false; FL.byKey.set(fareKey(f),f);
  const clock=v=>v?v.slice(11,16):'—', when=ts=>ts?`${fmtDay(dayOfTs(ts))} ${fmtClock(ts)}`:'—';
  const point=(icon,label,place,time)=>`<div class="ps-point"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><small>${label}</small><b>${esc(time)}</b><span>${esc(place)}</span></div>`;
  const points=[point('house','Wyjście',P.from,when(o?.leave)), point('plane-departure','Wylot',f.fromLabel,`${fmtDay(f.day)} ${clock(f.departure)}`), point('plane-arrival','Przylot',f.toLabel,arrivalOf(f)||'—')];
  const xo=chosenXfer(P,f);
  if(xo==='skip') points.push(point('car-side','Odbiór','ktoś odbiera z lotniska','z lotniska'));
  else if(xo) points.push(point(XMODE[xo.kind]?.[0]||'bus','Do centrum',xo.name||xo.line,xo.minutes!=null?`ok. ${fmtDuration(xo.minutes)}`:'—'));
  if(f.ret) points.push(point('plane-departure','Powrót',f.ret.fromLabel,`${fmtDay(f.ret.day)} ${clock(f.ret.departure)}`), point('plane-arrival','Lądowanie',f.ret.toLabel,arrivalOf(f.ret)||'—'));
  // Linki do zakupu: jasno, że to strona zewnętrzna (przewoźnik albo Google Flights), a zakup jest tam, nie w aplikacji.
  const book=[f, f.ret].filter(x=>x?.bookingUrl).map((x,i)=>`<a class="btn-ghost fl-book" href="${esc(x.bookingUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${x.airline==='RYANAIR'?'Kup bilet na ryanair.com':x.airline==='WIZZ'?'Kup bilet na wizzair.com':`Sprawdź w Google Flights (${esc(airlineOf(x).name)})`}${f.ret?(i?' (powrót)':' (wylot)'):''}</a>`).join('')
    +([f, f.ret].some(x=>x?.bookingUrl)?'<small class="fl-book-note">Otwiera stronę przewoźnika. Tam kupujesz bilet i sprawdzasz aktualną cenę.</small>':'');
  const details=open?`<div class="trip-open plan-details">
      <div class="fl-incl"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> W cenie: mała torba pod siedzenie</div>
      ${o?journeyLine(P,f,o):searching('Liczę dojazd na lotnisko…')}
    </div>`:'';
  return `<div class="fl-card plan-fl plan-short ${open?'open':''}">
    <div class="fl-legs">
      ${journeyRow(P,f)}
      <div class="ps-points">${points.join('<i class="fa-solid fa-chevron-right ps-sep" aria-hidden="true"></i>')}</div>
      ${airportMismatch(f,f.ret)}
      ${details}
    </div>
    <div class="fl-pricebox">${priceHeadline(P,f)}<button class="btn-ghost ps-more" type="button" data-open-flight="plan" aria-expanded="${open}">${open?'Zwiń szczegóły':'Zobacz szczegóły'}</button>${book}${alertButton(f)}${o?`<div class="plan-save-row">${planEditMenu()}</div>`:''}</div>
  </div>`;
}
function flightNote(P){
  if(P.flights===undefined) return searching('Szukam lotów…');
  if(P.flights===null) return '<div class="empty-note">Dane o lotach są chwilowo niedostępne.</div>';
  if(ASK_NOTES[P.fetch]) return searching(ASK_NOTES[P.fetch]);
  // Brak lotów w tym dniu: krótka informacja i propozycje innego dnia, bez przykładowego planu.
  const date=P.date||ymdOf(0), F=P.flights, days=F.days||[], best=days.length?days.reduce((x,y)=>y.cheapest<x.cheapest?y:x):null, next=F.next;
  const opts=[];
  if(next) opts.push(`<button type="button" class="fl-none-opt" data-day="${next.day}"><small>Najbliższy lot</small><b>${fmtDay(next.day)}${next.departure?' '+clockOf(next.departure):''}</b><span>${esc(next.from)} → ${esc(next.to)} · ${esc(airlineOf(next).name)} · ${next.priceType==='list'?'od ':''}${Math.round(next.pricePln)} zł</span></button>`);
  if(best && best.day!==next?.day && best.day!==date) opts.push(`<button type="button" class="fl-none-opt" data-day="${best.day}"><small>Najtaniej w pobliskich dniach</small><b>${fmtDay(best.day)}</b><span>wylot od ${best.cheapest} zł</span></button>`);
  const o=F.outside; if(o){ const need=RADIUS_STEPS.find(r=>r>=o.km)||600; opts.push(`<button type="button" class="fl-none-opt" data-radius="${need}"><small>Dalsze lotnisko</small><b>${esc(o.city)} (${esc(o.code)})</b><span>${o.km} km · pokaż lotniska do ${need} km</span></button>`); }
  return `<div class="fl-none"><i class="fa-solid fa-calendar-xmark" aria-hidden="true"></i><div class="fl-none-body"><b>Brak lotów ${fmtDay(date)}${P.round?` z powrotem ${fmtDay(P.round.back)}`:''}</b><span>${opts.length?(next&&P.scanned?'Pierwszy lot na tej trasie:':'Wybierz inny dzień:'):P.scanned?'W ciągu roku nie ma lotów do tego celu z lotnisk w pobliżu. Spróbuj większego promienia lotnisk.':'Nie znamy jeszcze lotów do tego celu z lotnisk w pobliżu. Wybierz inny dzień albo większy promień lotnisk.'}</span>${opts.length?`<div class="fl-none-opts">${opts.join('')}</div>`:''}</div></div>`;
}
function bestText(best, P, R){
  const lead=P.by?`Wyjdź najpóźniej o ${fmtClock(R.chosen.leave)}`:'Najszybciej';
  if(best==='walk') return `Najlepiej pieszo: ok. ${fmtDuration(walkMinutes(P.km))}.`;
  if(best==='transit'){ const {o}=R.chosen; return `${lead}: ${transitName(o)} ${o.legs.map(l=>l.short).join(' › ')}, przyjazd ${fmtClock(o.arr)}.`; }
  if(best==='rail'){ const {r}=R.chosen; return `${lead}: ${r.access?transitName(r.access)+' + pociąg':'pociąg'} ${railParts(r).map(p=>p.t.label).join(' › ')}, wyjście ${fmtClock(r.leave)}, przyjazd ${fmtClock(r.doorArr)}.`; }
  if(best==='flight'){
    // Łączny koszt = lot (+ powrót) + szacunek dojazdu na lotnisko; pokazujemy, z czego się składa, żeby nie mylił się z ceną lotu.
    const f=P.flights.options.reduce((x,y)=>y.totalPln<x.totalPln?y:x), n=nearbyCheaper(P);
    const flight=Math.round((f.pricePln||0)+(f.ret?.pricePln||0)), ground=Math.max(0, f.totalPln-flight);
    return `Najtaniej łącznie z dojazdem na lotnisko: ${airlineOf(f).name} z ${f.fromLabel}, ${fmtDay(f.day)}: lot ${flight} zł + dojazd ok. ${ground} zł = ok. ${f.totalPln} zł${f.ret?' w obie strony':''}.`+(n?` W dniach ±2 tańszy lot: ${fmtDay(n.day)}, od ${n.cheapest} zł.`:'');
  }
  return 'Brak połączeń komunikacją. Najlepiej dojechać samochodem.';
}
function tripSection(title, html, icon){ return `<div class="trip-sec" data-sec="${icon}"><h3 class="trip-title"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${esc(title)}</h3>${html}</div>`; }
function wantsFlights(P){ return P.km!=null && P.km>=FLIGHT_MIN_KM && P.allowed.has('plane'); }
function dayOfTs(ts){ return new Date(ts*1000).toLocaleDateString('sv-SE',{timeZone:TZ}); }
function dayOfPlan(ts){ return dayInfo(Math.round((ts-todayMidnight())/86400-0.5)); }
function stageEstimate(P, R){
  if(!usesTransit(P) || !GT.loaded) return '';
  const notes=[R.chosen.leave, R.backAt].filter(Boolean).map(dayOfPlan).map(day=>({day, agencies:estimatedAgencies(day).filter(agency=>P.allowed.has(agency==='pks'?'pks':'bus'))})).filter(x=>x.agencies.length);
  return [...new Map(notes.map(x=>[x.day.ymd,x])).values()].map(x=>estimateNote(x.agencies,x.day)).join('');
}
// Pogoda w miejscu docelowym: na czas pobytu, a przy podróży w jedną stronę lub jednodniowej na tydzień od wyjazdu.
// Open-Meteo prognozuje 16 dni naprzód; dalsze dni dostają informację, od kiedy prognoza będzie dostępna.
const TWX=new Map();
function tripWeather(P){
  const p=P.dest?.points?.[0], pt=Array.isArray(p)?{lat:p[0], lon:p[1]}:p;
  if(CFG.weather===false || S.agency!=='podroz' || !pt || P.km==null || P.km<20) return '';
  const from=P.date||ymdOf(0), back=P.round?.back||from, to=addDays(from,13);
  const key=`${pt.lat.toFixed(2)},${pt.lon.toFixed(2)}|${from}|${to}`, w=TWX.get(key);
  if(!w){
    TWX.set(key,{loading:true});
    fetch('/api/weather?'+new URLSearchParams({lat:pt.lat, lon:pt.lon, from, to})).then(r=>r.ok?r.json():null)
      .then(d=>{ TWX.set(key,d||{error:true}); if(P.onWx) P.onWx(); else if(inPlan(P)) runPlan(false); })
      .catch(e=>{ console.warn('Pogoda w celu', e); TWX.set(key,{error:true}); });
  }
  const head=`<div class="twx-head"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> <b>Pogoda: ${esc(P.to)}</b> <small>2 tygodnie od wyjazdu${back!==from?' · pobyt zaznaczony':''}</small></div>`;
  if(!w || w.loading) return `<div class="trip-wx">${head}<div class="twx-note"><span class="spin sm" aria-hidden="true"></span> Sprawdzam prognozę…</div></div>`;
  if(w.error) return '';
  const name=d=>new Date(d+'T12:00:00Z').toLocaleDateString(document.documentElement.lang==='en'?'en-GB':'pl-PL',{weekday:'short', timeZone:'UTC'});
  const days=(w.days||[]).map(d=>{ const [desc,ico]=wmo(d.code); return `<div class="twx-day ${d.day===from?'start':''} ${d.day===back?'end':''} ${d.day>=from&&d.day<=back?'stay':''}" title="${esc(desc)}"><small>${esc(name(d.day))} ${fmtDay(d.day)}</small><span class="twx-ico" aria-hidden="true">${ico}</span><b>${d.max!=null?Math.round(d.max)+'°':'—'}</b><small>${d.min!=null?Math.round(d.min)+'°':''}</small>${d.rainChance!=null?`<small class="twx-rain"><i class="fa-solid fa-droplet" aria-hidden="true"></i> ${d.rainChance}%</small>`:''}</div>`; }).join('');
  const later=w.availableFrom?`<div class="twx-note">${w.days?.length?'Dalsze dni':'Prognoza na te dni'}: dostępna od ${fmtDay(w.availableFrom)} (16 dni przed).</div>`:'';
  return `<div class="trip-wx">${head}${days?`<div class="twx-days">${days}</div>`:''}${later}</div>`;
}
// Dane lotniska docelowego z bazy lotnisk (współrzędne, strefa czasowa, opis dojazdu), używane w kroku 4.
const XFER=new Map();
function airportTransfer(code, P){
  if(!code) return null;
  if(!XFER.has(code)){
    XFER.set(code,undefined);
    fetch('/api/airport-transfers?codes='+encodeURIComponent(code)).then(r=>r.ok?r.json():null)
      .then(d=>{ XFER.set(code,d?.transfers?.find(t=>t.code===code)||null); if(inPlan(P)) runPlan(false); })
      .catch(e=>{ console.warn('Dojazd z lotniska', e); XFER.set(code,null); });
  }
  return XFER.get(code);
}
const XMODE={rail:['train','Pociąg / metro'], bus:['bus','Autobus'], taxi:['taxi','Taksówka'], tram:['train-tram','Tramwaj'], metro:['train-subway','Metro'], ferry:['ferry','Prom'], plane:['plane','Samolot']};
// Krok 4 „Na miejscu”: wszystkie sposoby dojazdu z lotniska (do centrum, gdy celem jest samo lotnisko) z ceną, czasem
// i miejscem odjazdu; poniżej mapa komunikacji miasta z pojazdami na żywo i planer przejazdów po mieście.
// Rozkłady i pojazdy: Transitous (otwarte dane GTFS, opóźnienia tam, gdzie przewoźnik je publikuje), pytany przez serwer.
const XOPT=new Map();
function airportOptions(P, f){
  const p=P.dest?.points?.[0], pt=Array.isArray(p)?{lat:p[0], lon:p[1]}:p, time=f.arrival||'';
  if(!time) return null;
  const key=[f.to,time,pt?pt.lat.toFixed(3):'',pt?pt.lon.toFixed(3):''].join('|');
  if(!XOPT.has(key)){
    XOPT.set(key,{loading:true});
    const q={code:f.to, time, label:P.to||''}; if(pt){ q.lat=pt.lat; q.lon=pt.lon; }
    fetch('/api/airport-transfers/options?'+new URLSearchParams(q)).then(r=>r.ok?r.json():null)
      .then(d=>{ const v=d||{error:true}; XOPT.set(key,v); if(inPlan(P)) runPlan(false); retryOptions(P,key,v); })
      .catch(e=>{ console.warn('Dojazd z lotniska', e); const v={error:true}; XOPT.set(key,v); retryOptions(P,key,v); });
  }
  return XOPT.get(key);
}
// Nieudana odpowiedź (np. chwilowo niedostępne wyszukiwanie adresu) nie zostaje na stałe: raz próbujemy sami po 10 s.
const XOPT_RETRIED=new Set();
function retryOptions(P, key, v){
  if(!(v.error || v.note==='centre-unknown') || XOPT_RETRIED.has(key)) return;
  XOPT_RETRIED.add(key);
  setTimeout(()=>{ if(XOPT.get(key)===v){ XOPT.delete(key); if(inPlan(P)) runPlan(false); } }, 10000);
}
// Celem jest samo lotnisko (np. „Barcelona El Prat”), więc krok 4 to dojazd do centrum.
function destIsAirport(P, code){
  const t=XFER.get(code), p=P.dest?.points?.[0], pt=Array.isArray(p)?p:p?[p.lat,p.lon]:null;
  if(t && pt) return hav(pt,[t.airportLat,t.airportLon])<3000;
  return /lotnisk|airport|aeropuert|aeroport|flughafen/i.test(P.to||'');
}
function wizardSteps(P){
  const code=P.destAirport, third=code&&destIsAirport(P,code)?'Z lotniska do centrum':'Na miejscu';
  return [[1,'Loty','plane'],[2,'Dojazd na lotnisko','route'],[3,third,'map-location-dot'],[4,'Plan podróży','flag-checkered']];
}
// Krótka informacja pod krokiem: co zostało wybrane (lot i godzina, dojazd i wyjście, dojazd do centrum).
function stepInfo(P, f, n){
  if(!f) return '';
  if(n===1) return `${f.from} ${clockOf(f.departure)||''} · ${fmtDay(f.day)}${f.ret?` · powrót ${fmtDay(f.ret.day)} ${clockOf(f.ret.departure)||''}`:''}`;
  if(n===2){ const o=pickedAccess(P,f); return o?`${o.title.replace(/ \+ samolot$/,'')}${o.leave?` · wyjście ${fmtDay(dayOfTs(o.leave))} ${fmtClock(o.leave)}`:''}`:''; }
  if(n===3){ if(P.xferPick==='skip') return 'odbiór z lotniska'; const o=P.xferPick&&airportOptions(P,f)?.options?.find(x=>x.id===P.xferPick); return o?`${o.name||o.line}${o.minutes!=null?` · ok. ${fmtDuration(o.minutes)}`:''}`:''; }
  if(n===4) return P.saved?'zapisano':`razem ${fareTotal(f)} zł + dojazdy`;
  return '';
}
// Rozwinięte „Trasa krok po kroku” zostają rozwinięte, gdy plan odświeża się (np. co minutę z danymi na żywo).
const CS_OPEN=new Set();
document.addEventListener('toggle', e=>{ const d=e.target; if(!d.classList?.contains('cs-more')) return; const id=d.closest('[data-cs-id]')?.dataset.csId; if(id){ if(d.open) CS_OPEN.add(id); else CS_OPEN.delete(id); } }, true);
const CS_SORTS=[['price','Najtaniej'],['time','Najszybciej'],['dep','Najwcześniej']];
const lineChip=(l)=>{ const [ic]=XMODE[l.kind]||XMODE.bus; const st=l.color?` style="--lc:${esc(l.color)};--lt:${esc(l.textColor||'#fff')}"`:''; return `<span class="cs-chip ${l.color?'own':esc(l.kind)}"${st}><i class="fa-solid fa-${ic}" aria-hidden="true"></i> ${esc(l.line||'')}</span>`; };
// Krok po kroku: wspólna oś podróży (assets/app.transport.js) — ta sama dla dojazdów z lotniska i przejazdów po mieście.
function csSteps(steps){ return PVT.journeyTimeline(PVT.stepsToEvents(steps, L2), {t:L2, dense:true}); }
function fareText(fr){
  if(!fr) return '<span class="cs-price none">cena: sprawdź u przewoźnika</span>';
  return `<span class="cs-price">${fr.pln!=null?`<b>${fr.pln===0?'bezpłatnie':'ok. '+fr.pln+' zł'}</b>`:''}<small>${esc(fr.text)}${fr.curated&&fr.checked?` · orientacyjnie, stan ${esc(fr.checked)}`:''}</small></span>`;
}
function cityStep(f, P){
  const d=airportOptions(P,f), city=XFER.get(f.to)?.city||f.toLabel||f.to;
  const head=`<div class="cs-head"><h4><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> ${destIsAirport(P,f.to)?`Z lotniska ${esc(f.to)} do centrum`:`Z lotniska ${esc(f.to)} do celu`}${d?.target?.label?`: ${esc(d.target.label)}`:''}</h4><small>przylot ${fmtDay(f.day)} ${esc(arrivalOf(f)||'')}${d?.wanted?` · połączenia od ${esc(d.wanted.clock)} (30 min na wyjście z lotniska)`:''}</small></div>`;
  let body='';
  if(!d || d.loading) body=searching('Szukam wszystkich sposobów dojazdu…');
  else if(d.error || !d.options?.length) body=`<div class="empty-note">${d.error?'Nie udało się pobrać sposobów dojazdu.':d.note==='centre-unknown'?'Nie udało się ustalić centrum miasta.':'Nie znaleźliśmy połączeń w otwartych rozkładach.'} ${d.hint?.route?esc(d.hint.route):''} <button type="button" class="btn-ghost" data-cs-retry><i class="fa-solid fa-rotate" aria-hidden="true"></i> Spróbuj ponownie</button></div>`;
  else {
    // Odjazdy liczone od godziny po przylocie, więc 00:13 po północy jest później niż 23:13.
    const from=d.wanted?.clock||'00:00', mins=t=>(+t.slice(0,2)*60+ +t.slice(3,5)-(+from.slice(0,2)*60+ +from.slice(3,5))+1440)%1440;
    const opts=d.options, priced=opts.filter(o=>o.fare?.pln!=null), timed=opts.filter(o=>o.minutes!=null), first=o=>o.departures?.length?mins(o.departures[0]):9999;
    const cheapest=priced.length?priced.reduce((a,b)=>b.fare.pln<a.fare.pln?b:a):null, fastest=timed.length?timed.reduce((a,b)=>b.minutes<a.minutes?b:a):null;
    const ridden=opts.filter(o=>o.departures?.length), soonest=ridden.length?ridden.reduce((a,b)=>first(b)<first(a)?b:a):null;
    const sort=P.csSort||'price', key={price:o=>o.fare?.pln??1e6, time:o=>o.minutes??1e6, dep:o=>o.kind==='taxi'?-1:first(o)}[sort];
    const list=[...opts].sort((a,b)=>{ const x=key(a), y=key(b); return x<y?-1:x>y?1:(a.minutes??1e6)-(b.minutes??1e6); });
    const card=o=>{
      const [ic,modeName]=XMODE[o.kind]||XMODE.bus, badges=[];
      if(o===cheapest) badges.push('<span class="cs-badge cheap"><i class="fa-solid fa-piggy-bank" aria-hidden="true"></i> Najtaniej</span>');
      if(o===fastest) badges.push('<span class="cs-badge fast"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Najszybciej</span>');
      if(o===soonest) badges.push('<span class="cs-badge soon"><i class="fa-solid fa-clock" aria-hidden="true"></i> Najbliższy odjazd</span>');
      if(o.kind!=='taxi' && o.transfers===0) badges.push('<span class="cs-badge direct"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Bez przesiadek</span>');
      const picked=P.xferPick===o.id;
      const there=d.target?`${d.target.lat},${d.target.lon}`:'', board=o.board?.at?`${o.board.at[0]},${o.board.at[1]}`:'';
      const gmaps=there&&board?`https://www.google.com/maps/dir/?api=1&origin=${board}&destination=${there}&travelmode=transit`:'';
      const title=o.kind==='taxi'?(o.name||'Taksówka'):(o.name||`${modeName} ${o.line}`);
      const listed=o.timetable===false && o.kind!=='taxi'; // znany z listy lotniska i cennika, ale nie z otwartych rozkładów
      const facts=[o.minutes!=null?`<span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${o.kind==='taxi'||listed?'ok. ':''}${fmtDuration(o.minutes)}</span>`:'', o.kind==='taxi'?(o.km!=null?`<span>${o.km} km</span>`:''):o.transfers==null?'':`<span>${o.transfers?`${o.transfers} ${o.transfers===1?'przesiadka':'przesiadki'}`:'bez przesiadek'}</span>`, o.walkMin?`<span><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${o.walkMin} min pieszo</span>`:''].filter(Boolean).join('');
      const where=o.kind==='taxi'
        ?`<div class="cs-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span>Postój taksówek przed terminalem przylotów · do: <b>${esc(o.alight||'')}</b></span></div>`
        :listed?`<div class="cs-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span>${o.board?.name?`Gdzie iść: <b>${esc(o.board.name)}</b>`:'Miejsce odjazdu: zobacz na mapie'}${walkTo(d,o)}</span></div>`
        :`<div class="cs-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span>Gdzie iść: <b>${esc(o.board.name)}</b>${o.board.walkMin?` · ${o.board.walkMin} min pieszo od terminalu`:''}<small>wysiadasz: ${esc(o.alight)}</small>${walkTo(d,o)}</span></div>`;
      const deps=o.departures?.length?`<div class="cs-deps"><small>Odjazdy</small>${o.departures.map(t=>`<b>${esc(t)}</b>`).join('')}</div>`
        :listed?'<div class="cs-deps listed"><small>Rozkład</small> u przewoźnika — tej linii nie ma w otwartych rozkładach</div>':'';
      const note=o.fare?.note?`<div class="cs-note">${esc(o.fare.note)}</div>`:'';
      return `<article class="cs-opt ${o===cheapest?'is-cheap':''} ${o===fastest?'is-fast':''} ${picked?'picked':''}" data-cs-id="${esc(o.id)}">
        ${badges.length?`<div class="cs-badges">${badges.join('')}</div>`:''}
        <div class="cs-title"><span class="cs-mode ${esc(o.kind)}"><i class="fa-solid fa-${ic}" aria-hidden="true"></i></span><div><b>${esc(title)}</b><small>${o.lines.length?o.lines.map(lineChip).join('<i class="fa-solid fa-chevron-right xfer-sep" aria-hidden="true"></i>'):esc(modeName)}${o.agency?` · ${esc(o.agency)}`:''}</small></div></div>
        <div class="cs-facts">${facts}</div>
        ${fareText(o.fare)}
        ${where}${deps}${note}
        ${o.steps?.length?`<details class="cs-more"${CS_OPEN.has(o.id)?' open':''}><summary>Trasa krok po kroku</summary>${csSteps(o.steps)}</details>`:''}
        <div class="cs-links"><button type="button" class="cs-pick ${picked?'on':''}" data-cs-pick="${esc(o.id)}" aria-pressed="${picked}">${picked?'<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Wybrano':'<i class="fa-regular fa-circle" aria-hidden="true"></i> Wybierz'}</button>${o.ticketUrl?`<a href="${esc(o.ticketUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-ticket" aria-hidden="true"></i> Bilety</a>`:''}${gmaps?`<a href="${esc(gmaps)}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> Google Maps</a>`:''}</div>
      </article>`;
    };
    const tabs=`<div class="cs-sort" role="group" aria-label="Kolejność">${CS_SORTS.map(([v,l])=>`<button type="button" class="${v===sort?'on':''}" data-cs-sort="${v}" aria-pressed="${v===sort}">${l}</button>`).join('')}<small>${opts.length} ${opts.length===1?'sposób':opts.length<5?'sposoby':'sposobów'} dojazdu</small></div>`;
    const hint=d.hint?.walk?`<div class="cs-hint"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${esc(d.hint.walk)}</div>`:'';
    body=tabs+hint+`<div class="cs-grid">${list.map(card).join('')}${skipCard(P)}</div><small class="cs-src">Rozkłady: Transitous (otwarte dane GTFS) · ceny z listy lotnisk i cennika, orientacyjne, przeliczone na złote po kursie NBP — sprawdź u przewoźnika przed podróżą.</small>`;
    CITY.options=new Map(opts.map(o=>[o.id,o]));
  }
  if(d && !d.loading && (d.error || !d.options?.length)) body+=`<div class="cs-grid">${skipCard(P)}</div>`;
  return `<div class="city-step">${head}${body}</div>`;
}
// Ktoś odbiera z lotniska: krok można pominąć, a plan i tak da się zapisać.
function skipCard(P){
  const on=P.xferPick==='skip';
  return `<article class="cs-opt cs-skip ${on?'picked':''}"><div class="cs-title"><span class="cs-mode car"><i class="fa-solid fa-car-side" aria-hidden="true"></i></span><div><b>Pomiń — ktoś mnie odbierze</b><small>Bez dojazdu komunikacją z lotniska</small></div></div>
    <div class="cs-links"><button type="button" class="cs-pick ${on?'on':''}" data-cs-pick="skip" aria-pressed="${on}">${on?'<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Wybrano':'<i class="fa-regular fa-circle" aria-hidden="true"></i> Wybierz'}</button></div></article>`;
}
// Na końcu planu: wybrany sposób dojazdu i dwa zapisy — w ulubionych (plan, jeszcze niepewny) albo jako moja podróż.
function tripSaveBar(P, f, d){
  const pick=P.xferPick, opt=pick&&pick!=='skip'?d?.options?.find(o=>o.id===pick):null;
  const chosen=pick==='skip'?'ktoś mnie odbierze z lotniska':opt?`${opt.name||((XMODE[opt.kind]||XMODE.bus)[1]+' '+opt.line)}${opt.minutes!=null?` · ok. ${fmtDuration(opt.minutes)}`:''}${opt.fare?.pln!=null?` · ok. ${opt.fare.pln} zł`:''}`:'';
  const saved=P.saved && FAV.items.find(x=>x.type==='trip' && x.tid===P.saved);
  const ready=!!chosen;
  const done=savedNote(P);
  return `<div class="cs-save">
    <div class="cs-choice"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Zapisz plan w ulubionych albo jako swoją podróż.</div>
    ${planStayBox('flight',P,{f,d})}
    ${tripTitleField(P)}
    <div class="cs-save-btns">
      <button type="button" class="btn-ghost" data-trip-save="planned" ${ready?'':'disabled'}><i class="fa-regular fa-bookmark" aria-hidden="true"></i> Zapisz w ulubionych</button>
      <button type="button" class="${done?'btn-ghost':'btn-grad'}" data-trip-save="booked" ${ready?'':'disabled'}><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> Zapisz moją podróż</button>
    </div>${SAVE_NOTE}${done}
  </div>`;
}

/* ---------- Mapa komunikacji miasta i planer przejazdów (jeden trwały panel, przenoszony do kroku 4) ---------- */
const CITY={el:null, map:null, base:[], baseKey:null, want:null, code:null, zone:'', live:true, timer:null, anim:null, vehicles:[], vLayer:null, route:null, ends:{from:null,to:null}, endMarks:{}, pick:null, options:new Map(), fetching:false, lastBox:''};
const VCOLORS={rail:'#2a5bd7', metro:'#c2185b', tram:'#e8590c', bus:'#1a7f4b', ferry:'#0288d1', plane:'#555', taxi:'#b26b00'};
function cityPanel(){
  if(CITY.el) return CITY.el;
  const el=document.createElement('section'); el.className='city-panel';
  // Układ jak w docs/TRANSPORT_REDESIGN.md: panel wyszukiwania i wyników po lewej, mapa po prawej (na komputerze obok siebie,
  // na telefonie mapa otwiera się na cały ekran z podsumowaniem wybranej trasy u dołu).
  el.innerHTML=`<div class="cp-head"><h4><i class="fa-solid fa-train-subway" aria-hidden="true"></i> <span class="cp-title">${L2('Komunikacja w mieście','City transport')}</span></h4>
      <button type="button" class="cp-map-toggle" data-cp-map aria-expanded="true"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> <span>${L2('Ukryj mapę','Hide map')}</span></button>
      <label class="cp-live"><input type="checkbox" checked data-cp-live> ${L2('Pojazdy na mapie','Vehicles on the map')}</label><span class="cp-status" aria-live="polite"></span></div>
    <div class="cp-body">
      <aside class="cp-plan">
        <h5><i class="fa-solid fa-route" aria-hidden="true"></i> ${L2('Zaplanuj przejazd po mieście','Plan a trip in the city')}</h5>
        <form class="cp-form" autocomplete="off">
          <div class="cp-ends">
            <label><span class="cp-lbl"><i class="fa-regular fa-circle-dot" aria-hidden="true"></i> ${L2('Skąd','From')}</span><span class="cp-field"><input name="from" placeholder="np. adres hotelu, Sagrada Família" required><button type="button" class="cp-pin" data-cp-here title="${L2('Moja lokalizacja','My location')}" aria-label="${L2('Użyj mojej lokalizacji jako „Skąd”','Use my location as “From”')}"><i class="fa-solid fa-location-arrow" aria-hidden="true"></i></button><button type="button" class="cp-pin" data-cp-pick="from" title="${L2('Wskaż na mapie','Pick on the map')}" aria-label="${L2('Wskaż „Skąd” na mapie','Pick “From” on the map')}"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i></button></span></label>
            <label><span class="cp-lbl"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${L2('Dokąd','To')}</span><span class="cp-field"><input name="to" placeholder="np. Park Güell" required><button type="button" class="cp-pin" data-cp-pick="to" title="${L2('Wskaż na mapie','Pick on the map')}" aria-label="${L2('Wskaż „Dokąd” na mapie','Pick “To” on the map')}"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i></button></span></label>
            <button type="button" class="cp-swap" data-cp-swap title="${L2('Zamień','Swap')}" aria-label="${L2('Zamień skąd i dokąd','Swap from and to')}"><i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i></button>
          </div>
          <div class="cp-when"><label>${L2('Kiedy (czas lokalny)','When (local time)')}<input type="datetime-local" name="when"></label><label class="cp-arrive"><input type="checkbox" name="arrive"> ${L2('przyjazd na','arrive by')}</label></div>
          <button class="btn-grad cp-go" type="submit"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> ${L2('Szukaj połączeń','Find connections')}</button>
          <small class="cp-err" role="alert"></small>
        </form>
        <div class="cp-results" aria-live="polite"></div>
      </aside>
      <div class="cp-map-wrap"><div class="cp-map"></div>
        <button type="button" class="cp-map-close" data-cp-map-close aria-label="${L2('Zamknij mapę i wróć do listy','Close the map and go back to the list')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${L2('Zamknij mapę','Close map')}</button>
        <div class="cp-summary" aria-live="polite" hidden></div>
        <div class="cp-legend">${[['metro','Metro'],['rail','Kolej'],['tram','Tramwaj'],['bus','Autobus'],['ferry','Prom']].map(([k,l])=>`<span><b class="cp-veh-l" style="background:${VCOLORS[k]}"><i class="fa-solid fa-${XMODE[k][0]}" aria-hidden="true"></i></b>${l}</span>`).join('')}<span><b class="cp-veh-l live" style="background:#888"><i class="fa-solid fa-bus" aria-hidden="true"></i></b>${L2('na żywo','live')}</span></div></div>
    </div>
    <small class="cp-src">${L2('Pojazdy i rozkłady: Transitous (otwarte dane GTFS). Pozycje wynikają z rozkładu; „na żywo” oznacza, że przewoźnik publikuje opóźnienia.','Vehicles and timetables: Transitous (open GTFS data). Positions follow the timetable; “live” means the operator publishes delays.')}</small>`;
  CITY.el=el;
  el.querySelector('[data-cp-live]').addEventListener('change', e=>{ CITY.live=e.target.checked; if(CITY.live) loadVehicles(true); else clearVehicles(); });
  el.querySelector('.cp-form').addEventListener('submit', e=>{ e.preventDefault(); cityPlan(); });
  el.querySelector('.cp-form').addEventListener('input', e=>{ if(e.target.name==='from'||e.target.name==='to') CITY.ends[e.target.name]=null; });
  // Podpowiedzi adresów w tym mieście (z tolerancją literówek); wybrana podpowiedź to od razu punkt na mapie.
  for(const which of ['from','to']){ const input=el.querySelector('.cp-form').elements[which]; attachSuggest(input, {streets:true, local:()=>[], near:()=>{ const c=CITY.want?.centre; return c?.lat!=null?[c.lat,c.lon]:null; }, onPick:it=>{ if(it.point){ CITY.ends[which]={at:it.point, label:it.label}; drawEnds(); } }}); }
  el.addEventListener('click', e=>{
    if(e.target.closest('[data-cp-map]')){ setCityMap(el.classList.contains('map-hidden')); return; }
    const pk=e.target.closest('[data-cp-pick]'); if(pk){ setCityMap(true); CITY.pick=pk.dataset.cpPick; el.classList.add('picking'); setCityStatus(`Kliknij na mapie miejsce „${CITY.pick==='from'?'Skąd':'Dokąd'}”.`); return; }
    if(e.target.closest('[data-cp-swap]')){ const f=el.querySelector('.cp-form'), a=f.from.value; f.from.value=f.to.value; f.to.value=a; [CITY.ends.from,CITY.ends.to]=[CITY.ends.to,CITY.ends.from]; drawEnds(); return; }
    const sv=e.target.closest('[data-cp-save]'); if(sv){ saveLocalTrip(+sv.dataset.cpSave); return; }
    if(e.target.closest('[data-cp-save-walk]')){ saveLocalTrip('walk'); return; }
    const it=e.target.closest('[data-cp-trip]'); if(it){ selectCityTrip(+it.dataset.cpTrip); return; }
    const sh=e.target.closest('[data-cp-show]'); if(sh){ selectCityTrip(+sh.dataset.cpShow); setCityMap(true); return; }
    const dt=e.target.closest('[data-cp-detail]'); if(dt){ openCityTripDetails(+dt.dataset.cpDetail); return; }
    if(e.target.closest('[data-cp-map-close]')){ setCityMap(false); return; }
    if(e.target.closest('[data-cp-here]')){ cityHere(); return; }
  });
  return el;
}
// Na stronach komunikacji miejskiej mapa jest domyślnie schowana (planer i wyniki są ważniejsze); otwiera ją przycisk
// „Pokaż mapę”, wskazanie punktu na mapie albo wybór linii. W planie podróży mapa jest widoczna jak wcześniej.
// Na telefonie (<768 px) na stronie komunikacji mapa otwiera się na cały ekran (lista wraca przyciskiem „Lista”,
// z zachowaniem miejsca przewinięcia); na komputerze i tablecie mapa stoi obok wyników.
const phoneWidth=()=>window.matchMedia?.('(max-width:767px)').matches;
function setCityMap(on){
  const el=CITY.el; if(!el) return;
  const inTx=!!el.closest('#cityTxPage'), full=on && inTx && phoneWidth();
  if(full && !el.classList.contains('map-full')) CITY.listScroll=window.scrollY;
  const leaving=!full && el.classList.contains('map-full');
  el.classList.toggle('map-hidden', !on);
  if(full) fitCityMapToBars();
  el.classList.toggle('map-full', full);
  document.body.classList.toggle('cp-map-open', full);
  if(leaving && CITY.listScroll!=null){ const y=CITY.listScroll; CITY.listScroll=null; setTimeout(()=>window.scrollTo(0,y),0); }
  if(CTX.on && inTx) CITY.txMapOpen=phoneWidth()?false:on;
  const b=el.querySelector('[data-cp-map]'); b.setAttribute('aria-expanded', String(on));
  b.querySelector('span').textContent=on?L2('Ukryj mapę','Hide map'):L2('Pokaż mapę','Show map');
  if(!on){ setCityStatus(''); return; }
  setTimeout(()=>{ if(!CITY.map) return; CITY.map.invalidateSize(); if(CITY.route) CITY.map.fitBounds(CITY.route.getBounds(),{padding:[30,30], maxZoom:16}); loadVehicles(true); },0);
}
// Pełnoekranowa mapa zajmuje dokładnie miejsce między górnym a dolnym paskiem (ich wysokość zależy od telefonu i aplikacji).
function fitCityMapToBars(){
  const top=document.querySelector('.topbar')?.getBoundingClientRect().bottom||56;
  const nav=document.querySelector('.bottom-nav'), navTop=nav&&getComputedStyle(nav).display!=='none'?nav.getBoundingClientRect().top:window.innerHeight;
  CITY.el.style.setProperty('--cp-top', Math.max(0,Math.round(top))+'px');
  CITY.el.style.setProperty('--cp-bottom', Math.max(0,Math.round(window.innerHeight-navTop))+'px');
}
// Esc zamyka pełnoekranową mapę.
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && CITY.el?.classList.contains('map-full')) setCityMap(false); });
// Wybór trasy: zaznacza kartę, rysuje trasę na mapie i odświeża podsumowanie na mapie (jedno źródło stanu: CITY.sel).
function selectCityTrip(i){
  const t=CITY.trips?.[i]; if(!t) return;
  CITY.sel=i;
  CITY.el.querySelectorAll('.cp-trip').forEach(x=>{ const on=+x.dataset.cpCard===i; x.classList.toggle('on',on); x.querySelector('[data-cp-trip]')?.setAttribute('aria-pressed',String(on)); });
  drawShape(t.shape); renderCitySummary();
}
function renderCitySummary(){
  const box=CITY.el?.querySelector('.cp-summary'); if(!box) return;
  const t=CITY.trips?.[CITY.sel];
  box.hidden=!t; box.innerHTML=t?PVT.mapSummary(t, CITY.sel, {t:L2}):'';
}
function openCityTripDetails(i){
  if(CITY.el.classList.contains('map-full')) setCityMap(false);
  const card=CITY.el.querySelector(`[data-cp-card="${i}"]`); if(!card) return;
  const d=card.querySelector('details'); if(d) d.open=true;
  setTimeout(()=>card.scrollIntoView({block:'nearest', behavior:'smooth'}),50);
}
// „Moja lokalizacja” jako punkt startu: tylko gdy urządzenie pozwala; adres z odwrotnego geokodowania, inaczej opis punktu.
function cityHere(){
  const err=CITY.el.querySelector('.cp-err'); err.textContent='';
  if(!navigator.geolocation){ err.textContent=L2('To urządzenie nie podaje lokalizacji. Wpisz adres.','This device does not share its location. Type an address.'); return; }
  const btn=CITY.el.querySelector('[data-cp-here]'); btn.disabled=true;
  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude, lon=pos.coords.longitude;
    let label=L2('Moja lokalizacja','My location');
    try{ const r=await fetch('/api/geocode/reverse?'+new URLSearchParams({lat:lat.toFixed(5), lon:lon.toFixed(5)})); const place=r.ok?(await r.json())?.place:null; if(place?.label) label=place.label; }catch{}
    btn.disabled=false; setEnd('from',[lat,lon],label);
  }, e=>{ btn.disabled=false; err.textContent=e?.code===1?L2('Przeglądarka nie zezwala na lokalizację. Wpisz adres.','Your browser blocks location. Type an address.'):L2('Nie udało się ustalić położenia. Wpisz adres.','Could not find your position. Type an address.'); },
  {enableHighAccuracy:true, timeout:15000, maximumAge:60000});
}
// Obrót telefonu albo zmiana szerokości okna: pełnoekranowa mapa tylko na wąskim ekranie.
window.addEventListener('resize', ()=>{ const el=CITY.el; if(!el?.classList.contains('map-full')) return; if(!phoneWidth()) setCityMap(true); else fitCityMapToBars(); });
const cityMapShown=()=>!!CITY.map && !CITY.el?.classList.contains('map-hidden');
function setCityStatus(text){ const s=CITY.el?.querySelector('.cp-status'); if(s) s.textContent=text; }
function localNow(zone){ try{ return new Date().toLocaleString('sv-SE',{timeZone:zone}).slice(0,16).replace(' ','T'); }catch{ return ''; } }
// Po każdym odświeżeniu planu panel trafia z powrotem do kroku 4; poza nim mapa przestaje pytać o pojazdy.
function mountCity(slot=document.querySelector('.city-slot')){
  if(!slot || !CITY.want){ stopVehicles(); return; }
  const el=cityPanel(); slot.appendChild(el);
  const w=CITY.want, fresh=CITY.code!==w.code;
  if(!CITY.map){
    CITY.map=L.map(el.querySelector('.cp-map'),{zoomControl:true, maxZoom:19, preferCanvas:true}); CITY.map.attributionControl.setPrefix(false);
    CITY.vLayer=L.layerGroup().addTo(CITY.map);
    CITY.map.on('moveend', ()=>{ clearTimeout(CITY.moveT); CITY.moveT=setTimeout(()=>loadVehicles(false),500); });
    CITY.map.on('click', e=>{ if(!CITY.pick) return; setEnd(CITY.pick,[e.latlng.lat,e.latlng.lng],`Punkt na mapie (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`); CITY.pick=null; CITY.el.classList.remove('picking'); setCityStatus(''); });
  }
  pickBaseLayer(CITY.map, CITY);
  if(fresh && w.centre){
    CITY.code=w.code; CITY.zone=w.zone; CITY.ends={from:null,to:null}; CITY.trips=null; CITY.sel=null; renderCitySummary(); clearRoute(); drawEnds();
    el.querySelector('.cp-title').textContent=`${L2('Komunikacja','Transport')}: ${w.city}`;
    el.querySelector('.cp-results').innerHTML='';
    const form=el.querySelector('.cp-form'); form.reset();
    form.from.placeholder=w.fromHint||'np. adres hotelu, Sagrada Família'; form.to.placeholder=w.toHint||'np. Park Güell';
    const today=localNow(w.zone).slice(0,10); form.when.value=today>=w.day&&(!w.back||today<=w.back)?localNow(w.zone):`${w.day}T12:00`;
    CITY.map.setView([w.centre.lat,w.centre.lon],14);
    if(w.airport) setEnd('from',[w.airport.lat,w.airport.lon],`Lotnisko ${w.code}`,true);
    else if(w.home) setEnd('from',[w.home.lat,w.home.lon],w.home.label,true);
  } else if(!CITY.code) CITY.map.setView([w.centre?.lat||RZ_CENTER[0], w.centre?.lon||RZ_CENTER[1]],13);
  // Strona komunikacji: na tablecie i komputerze mapa od razu obok wyników; na telefonie po „Pokaż mapę” (pełny ekran).
  setCityMap(slot.closest('#cityTxPage') ? (CITY.txMapOpen ?? !phoneWidth()) : true);
  setTimeout(()=>CITY.map.invalidateSize(),0);
  startVehicles();
}
function setEnd(which, at, label, quiet){
  CITY.ends[which]={at,label}; const f=CITY.el.querySelector('.cp-form'); f[which].value=label; drawEnds();
  if(!quiet && CITY.ends.from && CITY.ends.to) cityPlan();
}
function drawEnds(){
  for(const k of ['from','to']){ CITY.endMarks[k]?.remove(); CITY.endMarks[k]=null; const e=CITY.ends[k]; if(!e) continue;
    CITY.endMarks[k]=L.marker(e.at,{icon:L.divIcon({className:'cp-end '+k, html:`<span>${k==='from'?'A':'B'}</span>`, iconSize:[26,26], iconAnchor:[13,13]})}).bindTooltip(esc(e.label)).addTo(CITY.map); }
}
function clearRoute(){ CITY.route?.remove(); CITY.route=null; }
function drawShape(shape, fit=true){
  clearRoute(); if(!shape?.length) return;
  const g=L.featureGroup();
  for(const s of shape){ const walk=s.kind==='walk';
    L.polyline(s.points,{color:'#fff', weight:walk?5:9, opacity:.9}).addTo(g);
    L.polyline(s.points,{color:walk?'#555':(s.color||VCOLORS[s.kind]||'#333'), weight:walk?3:6, dashArray:walk?'4 7':null, opacity:1}).addTo(g); }
  CITY.route=g.addTo(CITY.map); if(fit && cityMapShown()) CITY.map.fitBounds(g.getBounds(),{padding:[30,30], maxZoom:16});
}
async function placeOf(which){
  const f=CITY.el.querySelector('.cp-form'), text=f[which].value.trim(), known=CITY.ends[which];
  if(known && known.label===text) return known.at;
  if(text.length<2) return null;
  const city=CITY.want?.city||'';
  const q=city&&!text.toLowerCase().includes(city.toLowerCase())?`${text}, ${city}`:text;
  const lookup=scope=>fetch('/api/geocode?'+new URLSearchParams({q, ...(scope?{scope}:{})})).then(r=>r.ok?r.json():null).catch(()=>null);
  // W Polsce najpierw dokładny adres w kraju (z numerem domu), potem świat; za granicą odwrotnie.
  const order=CITY.zone==='Europe/Warsaw'?['','world']:['world',''];
  let at=null;
  for(const scope of order){ at=(await lookup(scope))?.places?.[0]?.points?.[0]||null; if(at) break; }
  if(!at){ // literówka w nazwie ulicy: podpowiedzi tolerują drobne błędy
    const c=CITY.want?.centre, near=c?.lat!=null?'&near='+c.lat.toFixed(4)+','+c.lon.toFixed(4):'';
    const sg=await fetch('/api/streets?q='+encodeURIComponent(text)+near).then(r=>r.ok?r.json():null).catch(()=>null);
    at=sg?.places?.find(x=>x.point)?.point||null;
  }
  if(!at) return null;
  CITY.ends[which]={at, label:text}; drawEnds(); return at;
}
async function cityPlan(){
  const el=CITY.el, out=el.querySelector('.cp-results'), f=el.querySelector('.cp-form');
  el.querySelector('.cp-err').textContent='';
  out.innerHTML=searching(L2('Szukam połączeń…','Finding connections…'));
  const [a,b]=[await placeOf('from'), await placeOf('to')];
  if(!a||!b){ out.innerHTML=`<div class="empty-note">Nie znaleźliśmy miejsca „${esc(!a?f.from.value:f.to.value)}”. Wpisz inaczej albo wskaż je na mapie.</div>`; return; }
  const q={from:`${a[0]},${a[1]}`, to:`${b[0]},${b[1]}`, zone:CITY.zone, time:f.when.value||''}; if(f.arrive.checked) q.arriveBy='1';
  let d=await fetch('/api/transit/plan?'+new URLSearchParams(q)).then(r=>r.json()).catch(()=>null);
  if(!d || d.error){ out.innerHTML=`<div class="empty-note">${esc(d?.error||'Planer jest chwilowo niedostępny.')}</div>`; return; }
  // Rozkłady miast są publikowane na kilka tygodni naprzód: dalszy dzień liczymy z tego samego dnia tygodnia w najbliższym tygodniu.
  let proxy='';
  const want=(q.time||'').slice(0,10), today=localNow(CITY.zone).slice(0,10);
  if(!d.trips.length && want>today){
    const wd=new Date(want+'T12:00:00Z').getUTCDay(), base=new Date(today+'T12:00:00Z'); let k=1; while(new Date(base.getTime()+k*86400000).getUTCDay()!==wd) k++;
    const day=new Date(base.getTime()+k*86400000).toISOString().slice(0,10);
    if(day<want){ const d2=await fetch('/api/transit/plan?'+new URLSearchParams({...q, time:day+q.time.slice(10)})).then(r=>r.json()).catch(()=>null);
      if(d2?.trips?.length){ proxy=day; d={...d2, trips:d2.trips.map(t=>({...t, dep:{...t.dep, day:want}, arr:{...t.arr, day:want}, proxy:day}))}; } }
  }
  CITY.trips=d.trips;
  // Pieszo: czas z planera (gdy podał) albo szacunek z odległości, z trasą w Google Maps i zapisem do planu.
  const walkMin=d.walk?.minutes ?? Math.max(1, Math.round(hav(a,b)*WALK_FACTOR/1000/WALK_KMH*60));
  CITY.walk={minutes:walkMin, estimated:!d.walk};
  const walkHtml=`<div class="cp-walk"><div><b><i class="fa-solid fa-person-walking" aria-hidden="true"></i> Pieszo ok. ${fmtDuration(walkMin)}</b><small>${d.walk?'trasa piesza':'szacunek z odległości'} · ${fmtKm(hav(a,b)*WALK_FACTOR/1000)}</small></div>
    <div class="cp-walk-btns">${linkBtn(gDir(a,b,'walking'),'diamond-turn-right','Wskazówki (Google Maps)')}${CITY.want?.canSave?'<button type="button" class="btn-ghost cp-save" data-cp-save-walk><i class="fa-solid fa-plus" aria-hidden="true"></i> Dodaj do planu</button>':''}</div></div>`;
  if(!d.trips.length){ CITY.sel=null; renderCitySummary(); out.innerHTML=walkHtml+`<div class="empty-note">${stateIll(assetPaths.noResults)}${L2('Brak połączeń komunikacją w otwartych rozkładach.','No public transport connections in the open timetables.')}</div>`; if(d.walk) drawShape(d.walk.shape); return; }
  // Karty tras (assets/app.transport.js): zwinięte — godziny, czas, przesiadki, linie, stan na żywo; rozwinięte — oś podróży.
  const fastest=Math.min(...d.trips.map(t=>t.minutes)), fewest=Math.min(...d.trips.map(t=>t.transfers));
  const iFast=d.trips.findIndex(x=>x.minutes===fastest), iFew=d.trips.findIndex(x=>x.transfers===fewest&&x.minutes!==fastest);
  CITY.sel=0;
  out.innerHTML=(proxy?`<div class="cs-hint"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> <span>Rozkład na ${esc(fmtDay(want))} nie jest jeszcze opublikowany — pokazujemy połączenia z ${esc(fmtDay(proxy))} (ten sam dzień tygodnia).</span></div>`:'')
    +`<div class="cp-count">${d.trips.length} ${L2(d.trips.length===1?'połączenie':d.trips.length<5?'połączenia':'połączeń', d.trips.length===1?'connection':'connections')}</div>`
    +d.trips.map((t,i)=>PVT.routeCard(t,i,{t:L2, selected:i===0, fastest:i===iFast, fewest:i===iFew, canSave:!!CITY.want?.canSave, navUrl:gDir(a,b,'transit')})).join('')
    +walkHtml+PVT.freshness(d.fetchedAt, CITY.zone, d.source||'Transitous', L2);
  renderCitySummary();
  drawShape(d.trips[0].shape);
}
/* Pojazdy: serwer podaje, gdzie każdy będzie przez najbliższe 3 minuty; przeglądarka przesuwa kropki co sekundę. */
function startVehicles(){ if(!CITY.timer){ CITY.timer=setInterval(()=>loadVehicles(false),60000); CITY.anim=setInterval(moveVehicles,1000); } loadVehicles(false); }
function stopVehicles(){ clearInterval(CITY.timer); clearInterval(CITY.anim); CITY.timer=CITY.anim=null; }
function clearVehicles(){ CITY.vLayer?.clearLayers(); CITY.vehicles=[]; setCityStatus(''); }
async function loadVehicles(force){
  if(!CITY.map || !CITY.live || !CITY.el?.isConnected || !CITY.map.getContainer().offsetParent || document.hidden || CITY.fetching) return;
  const z=CITY.map.getZoom(), b=CITY.map.getBounds();
  if(z<12){ clearVehicles(); setCityStatus('Przybliż mapę, by zobaczyć pojazdy.'); return; }
  const q={min:`${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)}`, max:`${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`, zoom:Math.round(z)};
  const key=JSON.stringify(q)+Math.floor(Date.now()/60000); if(!force && key===CITY.lastBox) return; CITY.lastBox=key;
  CITY.fetching=true;
  try{
    let d=await fetch('/api/transit/vehicles?'+new URLSearchParams(q)).then(r=>r.ok?r.json():null);
    if(!d){ setCityStatus('Pojazdy chwilowo niedostępne.'); return; }
    if(d.tooWide){ clearVehicles(); setCityStatus('Przybliż mapę, by zobaczyć pojazdy.'); return; }
    CITY.vLayer.clearLayers();
    if(CITY.lineFilter) d={...d, vehicles:d.vehicles.filter(v=>v.line===CITY.lineFilter)};
    CITY.vehicles=d.vehicles.map(v=>{ const live=v.live; const m=L.marker(v.path[0],{icon:vehicleIcon(v), keyboard:false, riseOnHover:true})
      .bindTooltip(`<b>${esc(v.line||'')}</b> ${esc(v.from)} → ${esc(v.to)}<br><small>${live?(v.delayMin>0?`na żywo · opóźnienie ${v.delayMin} min`:v.delayMin<0?`na żywo · ${-v.delayMin} min przed czasem`:'na żywo · punktualnie'):'wg rozkładu'}</small>`,{className:'bus-tip', direction:'top'});
      m.addTo(CITY.vLayer); return {...v, m}; });
    moveVehicles(); renderCtxStats(CITY.vehicles);
    const live=d.vehicles.filter(v=>v.live).length;
    setCityStatus(`${d.vehicles.length} ${d.vehicles.length===1?'pojazd':d.vehicles.length%10>=2&&d.vehicles.length%10<=4&&(d.vehicles.length%100<10||d.vehicles.length%100>=20)?'pojazdy':'pojazdów'} w widoku${live?` · ${live} na żywo`:''}`);
  } catch(e){ console.warn('Pojazdy', e); setCityStatus('Pojazdy chwilowo niedostępne.'); }
  finally{ CITY.fetching=false; }
}
// Ikona pojazdu jak w legendzie: kolor linii (autobusy w kolorze trybu), biała obwódka u pojazdów z danymi na żywo.
const VICONS=new Map();
function vehicleIcon(v){
  const kind=VCOLORS[v.kind]?v.kind:'bus', bg=v.color&&kind!=='bus'?v.color:VCOLORS[kind], key=`${kind}|${bg}|${v.live?1:0}`;
  if(!VICONS.has(key)){ const [ic]=XMODE[kind]||XMODE.bus, size=kind==='bus'?18:22;
    VICONS.set(key, L.divIcon({className:`cp-veh ${kind} ${v.live?'live':''}`, html:`<span style="background:${esc(bg)}"><i class="fa-solid fa-${ic}" aria-hidden="true"></i></span>`, iconSize:[size,size], iconAnchor:[size/2,size/2]})); }
  return VICONS.get(key);
}
function moveVehicles(){
  if(!CITY.vehicles.length || !CITY.el?.isConnected) return;
  const now=Date.now();
  for(const v of CITY.vehicles){
    if(now<v.t0 || now>v.t1){ if(v.m._map) CITY.vLayer.removeLayer(v.m); continue; }
    if(!v.m._map) v.m.addTo(CITY.vLayer);
    const x=(now-v.t0)/v.stepMs, i=Math.min(v.path.length-1,Math.floor(x)), j=Math.min(v.path.length-1,i+1), f=x-i, a=v.path[i], b=v.path[j];
    v.m.setLatLng([a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f]);
  }
}
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && CITY.timer) loadVehicles(true); });
/* ---------- Komunikacja miejska w innych miastach Polski (Transitous) ----------
   Strona „Komunikacja miejska” wybranego miasta: planer z mapą pojazdów (ten sam panel co w planie zwiedzania)
   albo odjazdy z przystanku. Rzeszów ma własne, pełniejsze strony. */
const CTX={on:false, city:null, sub:null, stop:null, stops:[], q:'', timer:null, reqQ:0, reqD:0, data:null, err:'', day:'', at:'', line:'', lines:null, linesErr:''};
function syncCityTx(){
  const tx=S.agency==='ztm' && S.sub==='' ? searchTxCity() : S.agency==='ztm' && ['rozklad','linie'].includes(S.sub) ? txCity() : null;
  const page=document.getElementById('cityTxPage'); if(!page) return;
  document.body.classList.toggle('citytx-mode', !!tx);
  if(!tx){
    if(CTX.on){ CTX.on=false; clearInterval(CTX.timer); CTX.timer=null; page.innerHTML=''; CITY.lineFilter=''; if(CITY.el && !CITY.el.isConnected) stopVehicles(); }
    return;
  }
  const changed=!CTX.on || CTX.city!==tx.id || CTX.sub!==S.sub;
  CTX.on=true;
  if(CTX.city!==tx.id){ CTX.city=tx.id; CTX.stop=store('onward.citystop.'+tx.id)||null; CTX.stops=[]; CTX.q=''; CTX.data=null; CTX.err=''; CTX.line=''; CTX.lines=null; CTX.linesErr=''; CITY.lineFilter=''; }
  CTX.sub=S.sub;
  if(!changed) return;
  clearInterval(CTX.timer); CTX.timer=null;
  const head=`<div class="ctx-head"><div><h3><i class="fa-solid fa-train-tram" aria-hidden="true"></i> ${esc(tx.name)}</h3><small>${esc(txModes(tx))}${tx.operator?` · ${esc(tx.operator)}`:''}</small></div>
    <span class="ctx-badge ${tx.live?'live':''}">${tx.live?`<i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> ${L2('Opóźnienia na żywo','Live delays')}`:`<i class="fa-regular fa-clock" aria-hidden="true"></i> ${L2('Według rozkładu','Scheduled times')}`}</span></div>`;
  if(S.sub==='rozklad'){
    page.innerHTML=`<section class="ctx">${head}
      <form class="ctx-search" id="ctxForm" role="search" autocomplete="off"><label for="ctxStop">${L2('Przystanek','Stop')}</label>
        <div class="pl-inp"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="ctxStop" type="search" placeholder="${L2('Wpisz nazwę przystanku, np. ','Type a stop name, e.g. ')}${esc(TX_EXAMPLE[tx.id]||'Dworzec')}" value="${esc(CTX.q)}"></div></form>
      <ul class="ctx-stops" id="ctxStops"></ul>
      <div class="ctx-when-bar"><label>${L2('Dzień','Day')}<input type="date" id="ctxDay" value="${esc(CTX.day)}" min="${esc(localNow('Europe/Warsaw').slice(0,10))}"></label><label>${L2('Od godziny','From')}<input type="time" id="ctxAt" value="${esc(CTX.at)}" title="${L2('Puste = teraz','Empty = now')}"></label><label>${L2('Linia','Line')}<select id="ctxLine"><option value="">${L2('Wszystkie linie','All lines')}</option></select></label></div>
      <div id="ctxBoard" aria-live="polite"></div>
      <small class="cp-src">${L2('Odjazdy: Transitous (otwarte dane GTFS przewoźnika). „Na żywo” oznacza godzinę z opóźnieniem podanym przez przewoźnika.','Departures: Transitous (the operator’s open GTFS data). “Live” times include the delay the operator reports.')}</small></section>`;
    renderCtxStops(); renderCtxBoard();
    if(CTX.stop) loadCtxBoard();
    CTX.timer=setInterval(()=>{ if(CTX.stop && !document.hidden && CTX.sub==='rozklad') loadCtxBoard(true); }, 30000);
    return;
  }
  if(S.sub==='linie'){
    page.innerHTML=`<section class="ctx">${head}<div id="ctxLines" class="ctx-lines"></div>
      <small class="cp-src">${L2('Linie miasta zebrane z otwartych rozkładów GTFS (Transitous) i zapisane w bazie; odświeżane kilka razy dziennie. Liczba to pojazdy w trasie w najbliższych 30 minutach.','City lines collected from open GTFS timetables (Transitous) and stored in the database; refreshed several times a day. The number is vehicles on the way in the next 30 minutes.')}</small></section>`;
    renderCtxLines(); loadCtxLines();
    return;
  }
  page.innerHTML=`<section class="ctx">${head}<div class="ctx-stats" id="ctxStats"></div><div class="ctx-filter" id="ctxFilter"></div><div class="city-slot ctx-slot"></div></section>`;
  renderCtxStats(); renderCtxFilter();
  const today=localNow('Europe/Warsaw').slice(0,10);
  CITY.want={code:`pl:${tx.id}`, fromHint:`np. ulica i numer albo ${TX_EXAMPLE[tx.id]||'Dworzec'}`, toHint:'np. adres, przystanek, muzeum', city:tx.name, local:null, canSave:false, zone:'Europe/Warsaw', centre:{lat:tx.centre[0], lon:tx.centre[1]}, airport:null, home:null, day:today, back:null};
  mountCity(page.querySelector('.ctx-slot'));
}
const TX_EXAMPLE={rzeszow:'Dworzec Główny', warszawa:'Centrum', krakow:'Rondo Mogilskie', lodz:'Piotrkowska Centrum', wroclaw:'Rynek', poznan:'Rondo Kaponiera', gdansk:'Brama Wyżynna', gdynia:'Gdynia Główna', szczecin:'Plac Rodła', katowice:'Katowice Rondo', lublin:'Plac Litewski', bialystok:'Rynek Kościuszki', bydgoszcz:'Rondo Jagiellonów', torun:'Plac Rapackiego'};
function renderCtxStops(){
  const ul=document.getElementById('ctxStops'); if(!ul) return;
  ul.innerHTML=CTX.stops.map(st=>`<li><button type="button" data-ctx-stop="${esc(st.id)}" class="${CTX.stop?.id===st.id?'on':''}"><b>${esc(st.name)}</b><small>${st.km} km ${L2('od centrum','from the centre')}</small></button></li>`).join('');
}
function renderCtxBoard(){
  const box=document.getElementById('ctxBoard'); if(!box) return;
  if(!CTX.stop){ box.innerHTML=`<div class="empty-note">${L2('Wpisz nazwę przystanku i wybierz go z listy, by zobaczyć najbliższe odjazdy.','Type a stop name and pick it from the list to see the next departures.')}</div>`; return; }
  if(CTX.err){ box.innerHTML=`<div class="empty-note">${esc(CTX.err)}</div>`; return; }
  const d=CTX.data; if(!d){ box.innerHTML=searching(L2('Wczytuję odjazdy…','Loading departures…')); return; }
  const now=Date.now(), from=CTX.day||CTX.at?Date.parse(`${CTX.day||localNow('Europe/Warsaw').slice(0,10)}T${CTX.at||'00:00'}:00`):0;
  const sel=document.getElementById('ctxLine'), lines=[...new Set(d.departures.map(x=>x.line).filter(Boolean))].sort(natSort);
  if(sel){ const keep=CTX.line; sel.innerHTML=`<option value="">${L2('Wszystkie linie','All lines')}</option>`+lines.map(l=>`<option${l===keep?' selected':''}>${esc(l)}</option>`).join(''); }
  // Wspólna tablica odjazdów (PVT.departureBoard) z modelu /api/transport/departures — ta sama dla każdego przewoźnika.
  const list=d.departures.filter(x=>from?x.at>=Math.min(from,now)-60000:x.at>=now-60000);
  box.innerHTML=`<div class="ctx-board-head"><b>${esc(d.stop.name||CTX.stop.name)}</b><button type="button" class="btn-ghost" data-ctx-refresh><i class="fa-solid fa-rotate" aria-hidden="true"></i> ${L2('Odśwież','Refresh')}</button></div>`
    +PVT.departureBoard(list, {t:L2, now, line:CTX.line, empty:L2('Brak odjazdów w najbliższym czasie w otwartych rozkładach.','No departures soon in the open timetables.')})
    +PVT.freshness(d.fetchedAt, d.zone, d.source, L2);
}
async function loadCtxBoard(quiet){
  const stop=CTX.stop; if(!stop) return;
  const n=++CTX.reqD; if(!quiet){ CTX.data=null; CTX.err=''; renderCtxBoard(); }
  const q={provider:'transitous', stop:stop.id}; if(CTX.day||CTX.at){ const day=CTX.day||localNow('Europe/Warsaw').slice(0,10); q.time=`${day}T${CTX.at||(day===localNow('Europe/Warsaw').slice(0,10)?localNow('Europe/Warsaw').slice(11,16):'00:00')}`; }
  const d=await fetch('/api/transport/departures?'+new URLSearchParams({...q, limit:'50'})).then(r=>r.json()).catch(()=>null);
  if(n!==CTX.reqD || CTX.stop!==stop) return;
  if(!d || d.error){ if(!quiet||!CTX.data){ CTX.err=d?.error||L2('Odjazdy są chwilowo niedostępne.','Departures are unavailable right now.'); renderCtxBoard(); } return; }
  CTX.data=d; CTX.err=''; renderCtxBoard();
}
let ctxTyping;
document.getElementById('cityTxPage')?.addEventListener('input', e=>{
  if(e.target.id!=='ctxStop') return;
  CTX.q=e.target.value; clearTimeout(ctxTyping);
  ctxTyping=setTimeout(async()=>{
    const q=CTX.q.trim(), n=++CTX.reqQ;
    if(q.length<2){ CTX.stops=[]; renderCtxStops(); return; }
    const d=await fetch('/api/transit/stops?'+new URLSearchParams({city:CTX.city, q})).then(r=>r.json()).catch(()=>null);
    if(n!==CTX.reqQ) return;
    CTX.stops=d?.stops||[]; renderCtxStops();
    if(!CTX.stops.length){ const ul=document.getElementById('ctxStops'); if(ul) ul.innerHTML=`<li class="ctx-none">${esc(d?.error||L2('Nie znaleźliśmy takiego przystanku w tym mieście.','No stop of that name in this city.'))}</li>`; }
  }, 300);
});
document.getElementById('cityTxPage')?.addEventListener('submit', e=>{ if(e.target.id!=='ctxForm') return; e.preventDefault(); document.querySelector('[data-ctx-stop]')?.click(); });
document.getElementById('cityTxPage')?.addEventListener('click', e=>{
  const b=e.target.closest('[data-ctx-stop]');
  if(b){ const st=CTX.stops.find(x=>x.id===b.dataset.ctxStop); if(!st) return; CTX.stop=st; store('onward.citystop.'+CTX.city, st); renderCtxStops(); loadCtxBoard(); return; }
  if(e.target.closest('[data-ctx-refresh]')) loadCtxBoard();
  const ln=e.target.closest('[data-ctx-line]');
  if(ln){ CITY.lineFilter=ln.dataset.ctxLine; CITY.lastBox=''; CITY.txMapOpen=true; goPage('ztm',''); return; }
  if(e.target.closest('[data-ctx-unfilter]')){ CITY.lineFilter=''; CITY.lastBox=''; renderCtxFilter(); loadVehicles(true); }
});
document.getElementById('cityTxPage')?.addEventListener('change', e=>{
  if(e.target.id==='ctxDay'){ CTX.day=e.target.value; loadCtxBoard(); }
  if(e.target.id==='ctxAt'){ CTX.at=e.target.value; loadCtxBoard(); }
  if(e.target.id==='ctxLine'){ CTX.line=e.target.value; renderCtxBoard(); }
});
// Pasek jak w Rzeszowie: pojazdy w trasie, na żywo, spóźnione i największe opóźnienie (w widoku mapy).
function renderCtxStats(list=CITY.vehicles||[]){
  const el=document.getElementById('ctxStats'); if(!el) return;
  const live=list.filter(v=>v.live), late=live.filter(v=>v.delayMin>=3), max=live.reduce((m,v)=>Math.max(m,v.delayMin||0),0);
  const box=(lbl,num,red)=>`<div class="${red?'is-red':''}"><div class="lbl">${lbl}</div><div class="num">${num}</div></div>`;
  el.innerHTML=box(L2('W trasie (na mapie)','On the way (on the map)'), list.length||'–')+box(L2('Na żywo','Live'), live.length||'–')+box(L2('Spóźnione','Late'), late.length||(live.length?0:'–'), true)+box(L2('Maks. opóźnienie','Max delay'), live.length?`${max} min`:'–');
}
function renderCtxFilter(){
  const el=document.getElementById('ctxFilter'); if(!el) return;
  el.innerHTML=CITY.lineFilter?`<span>${L2('Na mapie tylko linia','Only line on the map')}</span> ${lineChip({line:CITY.lineFilter, kind:'bus'})} <button type="button" class="btn-ghost" data-ctx-unfilter><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${L2('Pokaż wszystkie','Show all')}</button>`:'';
}
async function loadCtxLines(){
  const city=CTX.city; if(CTX.lines?.city===city && Date.now()-CTX.lines.at<5*60000) return;
  const d=await fetch('/api/transit/lines?'+new URLSearchParams({city})).then(r=>r.json()).catch(()=>null);
  if(CTX.city!==city) return;
  if(!d || d.error){ CTX.linesErr=d?.error||L2('Lista linii jest chwilowo niedostępna.','The line list is unavailable right now.'); renderCtxLines(); return; }
  CTX.lines={city, at:Date.now(), list:d.lines||[], running:d.running!==false}; CTX.linesErr=''; renderCtxLines();
  // Zapisana lista bez świeżych pojazdów: serwer właśnie ją odświeża, więc pytamy jeszcze raz za chwilę.
  if(d.running===false && !CTX.linesRetry){ CTX.linesRetry=setTimeout(()=>{ CTX.linesRetry=null; if(CTX.city===city && CTX.sub==='linie'){ CTX.lines.at=0; loadCtxLines(); } }, 20000); }
}
function renderCtxLines(){
  const el=document.getElementById('ctxLines'); if(!el) return;
  if(CTX.linesErr && !CTX.lines){ el.innerHTML=`<div class="empty-note">${esc(CTX.linesErr)}</div>`; return; }
  if(!CTX.lines || CTX.lines.city!==CTX.city){ el.innerHTML=searching(L2('Wczytuję linie…','Loading lines…')); return; }
  const list=CTX.lines.list, running=CTX.lines.running; if(!list.length){ el.innerHTML=`<div class="empty-note">${L2('Teraz nie kursuje żadna linia (np. w nocy).','No line is running right now (e.g. at night).')}</div>`; return; }
  // Lista linii miasta jest zapisana w bazie; liczba pojazdów pochodzi z ostatniego sprawdzenia (gdy jest świeże).
  const note=l=>!running?'':l.vehicles?`${l.vehicles} ${L2('w trasie','on the way')}${l.late?` · <span class="txt-red">${l.late} ${L2('spóźn.','late')}</span>`:''}`:L2('teraz nie kursuje','not running now');
  const KIND=[['metro','Metro','Metro'],['tram','Tramwaje','Trams'],['rail','Kolej miejska','City rail'],['bus','Autobusy','Buses'],['ferry','Promy','Ferries']];
  el.innerHTML=KIND.map(([k,pl,en])=>{ const ls=list.filter(l=>(KIND.some(x=>x[0]===l.kind)?l.kind:'bus')===k); if(!ls.length) return '';
    return `<div><h4>${L2(pl,en)} · ${ls.length}</h4><div class="lg">${ls.map(l=>`<button type="button" class="ctx-line${running&&!l.vehicles?' idle':''}" data-ctx-line="${esc(l.line)}" title="${esc(L2('Pokaż pojazdy tej linii na mapie','Show this line’s vehicles on the map'))}">${lineChip(l)}${note(l)?`<small>${note(l)}</small>`:''}</button>`).join('')}</div></div>`; }).join('');
}

function stageTime(P){
  if(P.by) return `na miejscu do ${fmtDay(dayOfTs(P.by))} ${fmtClock(P.by)}`;
  return `${P.date?fmtDay(P.date)+' · ':''}${P.at?'odjazd od '+fmtClock(P.at):'odjazdy od teraz'}`;
}
function renderStage(P, R, paged){
  const {transit,rail,back,railBack,modes,best,flights,backAt}=R, home=P.home||P.origin, flightsNeeded=wantsFlights(P);
  if(modes.includes('car') && P.driving===undefined) loadDriving(P);
  const names=[...new Set(transit.map(transitName))].join(' / ');
  const latestFirst=list=>P.by?[...list].reverse():list; // przy godzinie na miejscu liczy się, jak późno można wyjść
  const sections=[];
  if(modes.includes('walk')) sections.push(tripSection('Pieszo', walkCard(P), 'person-walking'));
  if(transit.length) sections.push(tripSection(names, latestFirst(transit).map(o=>transitCard(o,P)).join('')+(paged?planPager(P,transit):''), 'bus'));
  else if(paged && P.history.length) sections.push(planPager(P,transit));
  if(rail.length) sections.push(tripSection('Pociąg', (paged&&!transit.length?'':'')+(TR.mode==='demo'?'<div class="small text-soft mb-2">Przykładowe dane — prawdziwe połączenia pojawią się, gdy dane PKP PLK będą dostępne.</div>':'')+latestFirst(rail).map(r=>trainCard(r,P,P.origin,P.dest)).join('')+(paged&&!transit.length?planPager(P,rail.map(r=>({dep:r.leave}))):''), 'train'));
  else if(P.railPending) sections.push(tripSection('Pociąg', searching('Sprawdzam rozkład pociągów…'), 'train'));
  else if(P.allowed.has('train') && TR.mode!=='live' && !transit.length) sections.push('<div class="empty-note">Dane PKP PLK są niedostępne, więc znamy tylko przykładowe pociągi w okolicy Rzeszowa.</div>');
  if(flightsNeeded) sections.push(tripSection('Samolot', flights.length||P.flights?.outbound?.length?tripFlights(P):flightNote(P), 'plane'));
  if(modes.includes('car')) sections.push(tripSection(flightsNeeded?'Samochód (dla porównania)':'Samochód', carCard(P), 'car'));
  if(!sections.length) sections.push(`<div class="empty-note">${stateIll(assetPaths.noResults)}${P.by?`Wybranymi środkami nie dojedziesz na ${fmtClock(P.by)}. Zmień godzinę albo zaznacz więcej środków transportu.`:'Brak połączeń wybranymi środkami transportu. Zaznacz więcej opcji.'}</div>`);
  if(flightsNeeded && (P.flightStep||1)>=2 && !(groundWizard(P)&&P.groundPick)){ const only=sections.filter(x=>x.includes('data-sec="plane"')); sections.length=0; sections.push(...only); }
  if(P.round && !flightsNeeded) sections.push(tripSection(`Powrót ${fmtDay(P.round.back)} od ${fmtClock(backAt)}`, (back.length||railBack.length?back.map(o=>transitCard(o,P,P.dest,home)).join('')+railBack.map(r=>trainCard(r,P,P.dest,home)).join(''):modes.includes('car')?'':'<div class="empty-note">Brak połączeń komunikacją w dniu powrotu. Wróć tą samą trasą.</div>')+backPager(P,back,railBack)+(modes.includes('car')?carCard(P,'back'):''), 'rotate-left'));
  return `<div class="plan-head"><span>${esc(P.from)} <span class="txt-red">→</span> ${esc(P.to)}</span><span class="text-soft">${P.km==null?'':'<span>w linii prostej '+fmtKm(P.km)+'</span> · '}<span>${stageTime(P)}</span>${P.round?` · powrót od ${fmtDay(P.round.back)}`:''}</span></div>`+(groundWizard(P)&&P.single?groundStepBar(P):'')+`<div class="stage-top">${tripWeather(P)}${best?`<div class="trip-best">${esc(bestText(best,P,R))}</div>`:''}${stageEstimate(P,R)}</div>`+sections.join('')+(groundWizard(P)&&P.single?groundNext(P):'');
}
// Ile pociągów zatrzymuje się na stacji (z rozkładu całego kraju) — żeby wybierać dworce, z których coś jeździ.
function railStopCounts(){
  if(TR.stopCounts?.src===TR.trains) return TR.stopCounts.map;
  const map=new Map();
  for(const t of TR.trains) for(const x of t.stops){ const n=railName(x.id); map.set(n,(map.get(n)||0)+1); }
  TR.stopCounts={src:TR.trains, map}; return map;
}
// Najbliższe stacje w promieniu 30 km z listy całego kraju, plus największy węzeł w okolicy:
// z małej wsi lepiej dojechać autobusem do dworca, z którego jeżdżą dalekie pociągi.
function stationsNear(place){
  if(!place.points.length) return [];
  const counts=railStopCounts(), seen=new Map();
  const add=(name,pt)=>{ if(seen.has(name)||!pt) return; const dist=Math.round(Math.min(...place.points.map(p=>hav(p,pt)))); if(dist<=30000) seen.set(name,{name,dist}); };
  for(const s of Object.values(RAIL_ST)) add(s[0],[s[1],s[2]]);
  for(const [name,pt] of RAIL_BY_NAME) add(name,pt);
  let list=[...seen.values()]; const served=list.filter(x=>counts.get(x.name)>0); if(served.length) list=served;
  list.sort((a,b)=>a.dist-b.dist);
  const near=list.slice(0,3), hub=[...list].sort((a,b)=>(counts.get(b.name)||0)-(counts.get(a.name)||0))[0];
  if(hub && !near.includes(hub)) near.push(hub);
  return near;
}
function placeCity(place){ return place.place?.locality || place.label; }
function isStreet(place){ return !!place.place && !place.station && place.place.label.split(',')[0]!==placeCity(place); }
const isMainStation=name=>/ Główn[ya]$/.test(name);
// Współrzędne mamy tylko dla okolic Rzeszowa, więc dalsze stacje szukamy po nazwie miasta, a wpisaną stację bierzemy dokładnie.
function railTargets(place){
  if(place.station) return [{name:place.station, dist:null}];
  const a=place.points[0], distTo=name=>{ const p=stopPoint(name); return a&&p?Math.round(hav(a,p)):null; };
  const city=placeCity(place).toLowerCase();
  const counts=railStopCounts(), served=name=>counts.get(name)||0;
  // Duże miasto ma dziesiątki stacji (Warszawa ~60); bierzemy te, na których zatrzymuje się najwięcej pociągów, a nie pierwsze alfabetycznie.
  let inCity=railStationNames().filter(n=>{ const l=n.toLowerCase(); return l===city || l.startsWith(city+' '); });
  if(inCity.some(served)) inCity=inCity.filter(served);
  const names=inCity.length ? inCity : stationsNear(place).map(x=>x.name);
  const home=distTo(HOME_STATION); if(home!=null && home<=30000 && !names.includes(HOME_STATION)) names.push(HOME_STATION);
  const wholeCity=inCity.length && !isStreet(place); // cel to samo miasto, więc dworzec jest już na miejscu
  const ranked=names.map(name=>({name, dist:wholeCity?null:distTo(name)}));
  ranked.sort(wholeCity
    ? (x,y)=>served(y.name)-served(x.name) || isMainStation(y.name)-isMainStation(x.name) // „Warszawa Główna” to mała stacja
    : (x,y)=>isMainStation(y.name)-isMainStation(x.name) || (x.dist??0)-(y.dist??0));
  if(!wholeCity && ranked.length>6){ // na ulicy: najbliższe stacje, ale zawsze też największy węzeł
    const top=ranked.slice(0,5), hub=[...ranked].sort((x,y)=>served(y.name)-served(x.name))[0];
    return top.includes(hub)?ranked.slice(0,6):[...top,hub];
  }
  return ranked.slice(0, wholeCity?60:6); // całe miasto: każdy dworzec z pociągami (Centralna nie musi być w pierwszej szóstce)
}
function stopsAtStation(station){
  const point=stopPoint(station); if(!point) return [];
  return nearbyStops({points:[point]}).filter(x=>x.dist<=800);
}
function busToTrain(origin, station, dep, notBefore, allow){
  const stops=stopsAtStation(station); if(!stops.length || !origin.names.length) return null;
  return arrivingBy(origin, stops, dep-RAIL_CHANGE_SEC, allow, [1,2.5], notBefore);
}
function busFromStation(station, dest, at, allow){
  const stops=stopsAtStation(station); if(!stops.length || !dest.names.length) return null;
  return planTrips({names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist]))}, dest, at, allow)[0]||null;
}
function railLink(P, key, build){ if(!P.railLinks.has(key)) P.railLinks.set(key, build()); return P.railLinks.get(key); }
function stationIds(names){
  const wanted=new Set(names), ids=[];
  for(const [id,name] of TR.names) if(wanted.has(name)) ids.push(id);
  for(const [id,s] of Object.entries(RAIL_ST)) if(wanted.has(s[0]) && !TR.names.has(+id)) ids.push(+id);
  return ids;
}
// Najpierw pociąg, potem dobieramy do niego autobus, żeby nie wychodzić z domu kilka godzin za wcześnie.
function planRail(P, at, origin, dest, by){
  if(P.km!=null && P.km<RAIL_MIN_KM) return [];
  const to=railTargets(dest); if(!to.length) return [];
  const trains=trainsAround(at); if(!trains){ P.railPending=true; return []; }
  const target={names:to.map(x=>x.name), walk:new Map(to.map(x=>[x.name,x.dist||0]))}, found=new Map(), from=railTargets(origin);
  const leadOf=s=>s.dist>RAIL_WALK_M ? s.dist/BUS_MS : (s.dist||0);
  const addRoute=(r,s,key)=>{
    const far=s.dist>RAIL_WALK_M;
    r.startDist=s.dist; r.walkFrom=far?0:(s.dist||0);
    r.access=far && usesTransit(P) ? railLink(P, `to|${s.name}|${r.dep}`, ()=>busToTrain(origin,s.name,r.dep,at,tripAllowed(P))) : null;
    r.egress=r.walkTo>RAIL_WALK_M && usesTransit(P) ? railLink(P, `from|${r.to}|${r.arr}|${dest.label}`, ()=>busFromStation(r.to,dest,r.arr+RAIL_CHANGE_SEC,tripAllowed(P))) : null;
    r.doorArr=r.egress ? r.egress.arr+r.egress.walkTo : r.arr+(r.walkTo<=RAIL_WALK_M?r.walkTo:0);
    r.leave=r.access ? r.access.dep-r.access.walkFrom : r.dep-leadOf(s);
    found.set(key, r);
  };
  for(const s of from){
    for(const r of planTrainRoutes({names:[s.name], walk:new Map()}, target, at+leadOf(s), trains, by)){
      if(!found.has(r.t.key)) addRoute(r,s,r.t.key);
    }
  }
  // Połączenia z przesiadką (np. przez Kraków) szukamy zawsze — zostają te, których nie wyprzedza inne połączenie.
  {
    const stations=new Map(from.flatMap(s=>stationIds([s.name]).map(id=>[id,s]))), targets=new Set(stationIds(target.names));
    for(const parts of changeJourneys(P, trains, stations, targets, at, leadOf, by)){
      const first=parts[0], last=parts[parts.length-1], name=railName(first.a.id), toName=railName(last.b.id), key=parts.map(x=>x.t.key).join('>');
      const s=from.find(x=>x.name===name); if(!s || found.has(key)) continue;
      if(parts.length===1 && found.has(first.t.key)) continue;
      addRoute({t:first.t, a:first.a, b:last.b, dep:first.dep, arr:last.arr, from:name, to:toName, walkTo:target.walk.get(toName)||0, parts:parts.length>1?parts:null}, s, key);
    }
  }
  const all=[...found.values()].filter(r=>!by || r.doorArr<=by), served=all.filter(r=>r.access || !(r.startDist>RAIL_WALK_M)); // pociąg bez dojazdu tylko wtedy, gdy nie ma lepszego
  const list=(served.length?served:all).sort((a,b)=>a.dep-b.dep);
  return by ? list.slice(-RAIL_LIST) : list.slice(0,RAIL_LIST);
}
const RAIL_LIST=8, RAIL_DAY_OPTIONS=16; // tyle pociągów na stronie; kolejne pod „Późniejsze”
function changeJourneys(P, trains, stations, targets, at, leadOf, by){
  const starts=from=>new Map([...stations].map(([id,s])=>[id,from+leadOf(s)]));
  const key=`change|${[...stations.keys()].join()}|${[...targets].join()}|${by||Math.floor(at/300)}`;
  return railLink(P, key, ()=>{
    if(!by) return railJourneys(trains, starts(at), targets, at+RAIL_SEARCH_HOURS*3600, RAIL_DAY_OPTIONS);
    for(const hours of [1,2,3,4,6,8,10,14]){
      const fit=railJourneys(trains, starts(Math.max(by-hours*3600,at)), targets, by).filter(parts=>parts[parts.length-1].arr<=by);
      if(fit.length) return fit;
      if(by-hours*3600<=at) break;
    }
    return [];
  });
}
function usesTransit(P){ return P.allowed.has('bus') || P.allowed.has('pks'); }
function tripAllowed(P){ return t=>tripInView(t) && P.allowed.has((routeById(t.route).agency||'ztm')==='pks'?'pks':'bus'); }
// Cofamy się małymi krokami: przesiadka czeka najwyżej 45 min, więc większy skok pominąłby najpóźniejsze połączenie.
function transitBy(origin, dest, by, notBefore, allow){
  for(const hours of [0.5,1,1.5,2,2.5,3,3.5,4,5,6,8,10]){
    const fit=planTrips(origin,dest,Math.max(by-hours*3600,notBefore),allow).filter(o=>o.arr+o.walkTo<=by);
    if(fit.length) return fit.slice(-4);
    if(by-hours*3600<=notBefore) break;
  }
  return [];
}
function planTransit(P, origin, dest, at, by){
  if(!GT.loaded || !usesTransit(P) || !origin.names.length || !dest.names.length) return [];
  if(!by) return planTrips(origin,dest,at,tripAllowed(P));
  return railLink(P, `by|${origin.label}|${dest.label}|${by}`, ()=>transitBy(origin,dest,by,at,tripAllowed(P)));
}
function planStage(P){
  const at=P.by ? Math.max(nowSec(),P.by-RAIL_BY_HOURS*3600,P.date?dateMid(P.date):0) : P.at||nowSec(), home=P.home||P.origin, ground=!wantsFlights(P), trains=GT.loaded && P.allowed.has('train');
  P.railPending=false;
  // Wybrany dzień wyjazdu: lista (i „Późniejsze”) kończy się o północy, nie przechodzi po cichu na następny dzień.
  const outDay=P.single && P.date && !P.by ? P.date : '', onDay=(ts,d)=>!d || dayOfTs(ts)===d;
  const transit=planTransit(P,P.origin,P.dest,at,P.by).filter(o=>onDay(o.dep-o.walkFrom,outDay));
  const found=trains?planRail(P,at,P.origin,P.dest,P.by).filter(r=>onDay(r.leave,outDay)):[], rail=railWorthIt(transit.length?found.filter(r=>r.access || !(r.startDist>RAIL_WALK_M)):found, transit);
  const flights=wantsFlights(P) ? P.flights?.options||[] : [];
  const modes=tripModes(P.km, {transit:transit.length>0, rail:rail.length>0, flights:flights.length>0}, P.allowed);
  const span=sec=>P.by?{leave:P.by-sec, arrive:P.by}:{leave:at, arrive:at+sec};
  const top=list=>[...list].sort((a,b)=>P.by?b.leave-a.leave:a.arrive-b.arrive)[0];
  const options={walk:P.km==null?null:span(walkMinutes(P.km)*60), transit:top(transit.map(o=>({o, leave:o.dep-o.walkFrom, arrive:o.arr+o.walkTo}))), rail:top(rail.map(r=>({r, leave:r.leave, arrive:r.doorArr})))};
  const rank={}; for(const m of ['walk','transit','rail']) if(options[m]) rank[m]=P.by?-options[m].leave:options[m].arrive;
  const best=modes.length?bestMode(P.km,modes,rank):null, chosen=options[best]||null;
  const carMin=P.driving?P.driving.minutes:(P.km||0)*ROAD_FACTOR/CAR_KMH*60; // bez rozkładu kolejny etap liczymy od czasu jazdy
  const arrival=chosen||span(carMin*60), backAt=P.round?Math.max(returnStart(P.round,arrival.arrive), P.round.from||0):null; // nie wracamy, zanim dojedziemy
  const backDay=P.round?.back||'';
  const back=P.round && ground ? planTransit(P,P.dest,home,backAt).filter(o=>onDay(o.dep-o.walkFrom,backDay)) : [], railBack=P.round && ground && trains ? planRail(P,backAt,P.dest,home).filter(r=>onDay(r.leave,backDay)) : [];
  return {transit,rail,back,railBack,flights,modes,best,chosen:arrival,backAt};
}
// Etapy liczymy od startu, a przy godzinie na miejscu od celu do początku podróży.
function runPlan(scroll){
  updateBanner();
  const J=S.plan; if(!J) return;
  const stages=J.stages, results=new Map();
  S.planRoutes=[]; S.groundOpts=[];
  stages.forEach(P=>{ P.single=stages.length===1; });
  if(J.by){
    let by=J.by;
    for(let k=stages.length-1;k>=0;k--){ const P=stages[k]; P.by=by; const R=planStage(P); results.set(P,R); by=R.chosen.leave-(stages[k-1]?.stay||0)*60; }
  } else {
    let at=null;
    stages.forEach((P,k)=>{
      if(k){
        P.at=at;
        // kolejny etap tego samego dnia albo później: loty szukamy na dzień, w którym etap się zaczyna
        const d=dayOfTs(at); if(d!==(P.date||ymdOf(0)) && d>ymdOf(0)){ P.date=d; if(wantsFlights(P)) loadTripFlights(P); }
        if(P.groundPick?.leave!=null && P.groundPick.leave<at) P.groundPick=null; // wybrany odjazd jest już przed przyjazdem z poprzedniego etapu
      }
      const R=planStage(P); results.set(P,R); at=(P.groundPick?.arrive ?? R.chosen.arrive)+P.stay*60;
    });
  }
  const single=stages.length===1, first=results.get(stages[0]).chosen, last=results.get(stages[stages.length-1]).chosen;
  const summary=single?'':`<div class="trip-summary"><b>${stages.map((P,k)=>esc(P.from)+(k&&stages[k-1].stay?` <small>(${stages[k-1].stay} min)</small>`:'')).join(' <span class="txt-red">→</span> ')} <span class="txt-red">→</span> ${esc(stages[stages.length-1].to)}</b><span>wyjazd ${fmtClock(first.leave)} · na miejscu ${fmtClock(last.arrive)}</span></div>`;
  // Odświeżenie nie może przesuwać strony: panel mapy wraca na miejsce, zanim cokolwiek zmierzy układ (inaczej strona na
  // chwilę jest krótsza i przeglądarka podciąga widok do góry), a położenie strony wraca do poprzedniego.
  const kept=scrollState(document.getElementById('planResults')), pageY=window.scrollY;
  const saveView=J.groundStep===2 && stages.every(P=>P.groundPick);
  if(J.groundStep===2 && !saveView) J.groundStep=1;
  document.getElementById('planResults').innerHTML=resultsFrame('plan', planStrip(), saveView?groundSaveAll(J):(single?'':groundStepBar(stages[0]))+summary+stages.map((P,k)=>{
    const R=results.get(P), html=renderStage(P,R,single&&!P.by);
    const stay=k<stages.length-1?`<div class="trip-stop-note"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(P.to)}: postój ${fmtStay(P.stay)}, dalej ${P.stay>=1440?fmtDay(dayOfTs(R.chosen.arrive+P.stay*60))+' ':''}ok. ${fmtClock(R.chosen.arrive+P.stay*60)}</div>`:'';
    return `<section class="trip-stage" data-stage="${k}">${single?'':`<h3 class="stage-title">Etap ${k+1} z ${stages.length}</h3>`}${html}</section>${stay}`;
  }).join('')+(single?'':groundNext(stages[0])), PLAN_SORTS, S.planView.sort);
  mountCity(); applyPlanView(); restoreScroll(document.getElementById('planResults'), kept); planBusy(); wireStrips(); updatePlanScope();
  if(!scroll && Math.abs(window.scrollY-pageY)>1) window.scrollTo({top:pageY, behavior:'instant'});
  // Po zmianie środków transportu wyniki zachowują wysokość, dopóki dojazdy się nie przeliczą, więc strona nie skacze.
  if(S.holdY!=null){
    const box=document.getElementById('planResults');
    window.scrollTo({top:S.holdY, behavior:'instant'});
    if(!stages.some(P=>[...P.access.values()].some(v=>v==null))){ box.style.minHeight=''; S.holdY=null; }
  }
  if(scroll) document.getElementById('planResults').scrollIntoView({behavior:'smooth', block:'nearest'});
}
function inPlan(P){ return !!S.plan?.stages.includes(P); }
/* ---------- Filtry, sortowanie i pasek dni, wspólne dla podróży i lotów ---------- */
const DAY_PARTS=[{value:'night',label:'Noc 0:00–5:59',from:0},{value:'morning',label:'Rano 6:00–11:59',from:6},{value:'afternoon',label:'Popołudnie 12:00–17:59',from:12},{value:'evening',label:'Wieczór 18:00–23:59',from:18}];
function dayPart(clock){ const h=+String(clock).slice(0,2); return [...DAY_PARTS].reverse().find(p=>h>=p.from).value; }
const partLabel=v=>DAY_PARTS.find(p=>p.value===v)?.label||'Bez godziny';
function addDays(day, n){ return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10); }
// Grupy filtrów z liczbą wyników; nic nie zaznaczone znaczy wszystko.
function filterGroups(facts, defs){
  return defs.map(d=>{
    const counts=new Map(); for(const f of facts) for(const v of d.of(f)) counts.set(v,(counts.get(v)||0)+1);
    return {...d, options:(d.order||[...counts.keys()].sort()).filter(v=>counts.has(v)).map(v=>({value:v, label:d.label(v), count:counts.get(v)}))};
  }).filter(g=>g.options.length);
}
function passesFilters(f, defs, picked){ return defs.every(d=>!picked[d.key]?.size || d.of(f).some(v=>picked[d.key].has(v))); }
function filterPanel(groups, picked){
  if(!groups.length) return '';
  return `<div class="rf-head"><b>Filtry</b><button type="button" class="rf-clear" data-clear-filters>Wyczyść wszystkie</button></div>`+groups.map(g=>`<fieldset class="rf-group"><legend>${esc(g.title)}</legend>${g.options.map(o=>`<label class="rf-opt"><input type="checkbox" data-filter-group="${g.key}" value="${esc(o.value)}" ${picked[g.key]?.has(o.value)?'checked':''}><span>${esc(o.label)}</span><small>${o.count}</small></label>`).join('')}</fieldset>`).join('');
}
function readFilters(box){
  const picked={};
  for(const x of box.querySelectorAll('[data-filter-group]:checked')) (picked[x.dataset.filterGroup] ||= new Set()).add(x.value);
  return picked;
}
function resultsFrame(id, strip, body, sorts, sort){
  return `<div class="res-layout"><aside class="res-filters" id="${id}Filters"></aside><div class="res-main">${strip}<div class="res-bar"><b id="${id}Count"></b><label class="res-sort">Sortuj: <select id="${id}Sort">${sorts.map(([v,l])=>`<option value="${v}" ${v===sort?'selected':''}>${esc(l)}</option>`).join('')}</select></label></div>${body}</div></div>`;
}
function countText(n){ return n===1?'1 wynik':n%10>=2&&n%10<=4&&(n%100<10||n%100>=20)?`${n} wyniki`:`${n} wyników`; }
// Pasek kolejnych dni: dwa tygodnie przed i po wybranym dniu; przy lotach z ceną i najtańszym dniem.
const STRIP_DAYS=56;
// Przewijanie paska dni (tydzień po tygodniu): dni bez ceny w bazie są sprawdzane u przewoźników; dni z ceną pokazują
// zapisaną cenę bez pytania. Aktualne ceny sprawdzamy tylko dla wybranego na początku okresu.
const STRIPFILL={plan:false, back:false}, FILLED=new Set();
let stripQuiet=0;
function wireStrips(){
  stripQuiet=Date.now()+900; // przewinięcie przy odświeżeniu strony to nie ruch użytkownika
  document.querySelectorAll('#planResults .date-strip .ds-days').forEach(box=>{
    let t; box.addEventListener('scroll', ()=>{ if(Date.now()<stripQuiet) return; clearTimeout(t); t=setTimeout(()=>fillStrip(box.closest('.date-strip')), 700); }, {passive:true});
  });
}
async function fillStrip(strip){
  if(!strip || document.body.classList.contains('guest')) return;
  const kind=strip.dataset.strip==='back'?'back':'plan', box=strip.querySelector('.ds-days'), P=S.plan?.stages.find(x=>wantsFlights(x) && x.flights);
  if(!P || STRIPFILL[kind] || ASK_NOTES[P.fetch]) return;
  const left=box.scrollLeft, right=left+box.clientWidth, today=ymdOf(0);
  const missing=[...box.querySelectorAll('.ds-day')].filter(b=>b.offsetLeft-box.offsetLeft+b.offsetWidth>left && b.offsetLeft-box.offsetLeft<right && b.dataset.priced==='0' && b.dataset.day>=today).map(b=>b.dataset.day);
  if(!missing.length) return;
  const start=missing[0], end=missing.at(-1), key=[kind,pointParam(P.origin.points[0]),pointParam(P.dest.points[0]),start,end].join('|');
  if(FILLED.has(key)) return; FILLED.add(key);
  STRIPFILL[kind]=true; STRIPFILL[kind+'Range']={start, end}; strip.classList.add('filling'); strip.insertAdjacentHTML('afterbegin', stripNote(kind));
  box.querySelectorAll('.ds-day').forEach(b=>{ if(b.dataset.priced==='0' && b.dataset.day>=start && b.dataset.day<=end) b.classList.add('ds-updating'); });
  let started=false;
  try{
    const r=await fetch('/api/flights/fill',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({origin:pointParam(P.origin.points[0]), dest:pointParam(P.dest.points[0]), start, end, dir:kind==='back'?'back':'out', prefer:preferredAirport(), radius:flightRadius()})});
    started=r.status===202;
  }catch(e){ console.warn('Ceny dni', e); }
  if(started){ for(let i=0;i<90;i++){ await new Promise(res=>setTimeout(res,2000)); const st=await fetch('/api/flights/status').then(x=>x.json()).catch(()=>null); if(!st?.running) break; } }
  STRIPFILL[kind]=false; STRIPFILL[kind+'Range']=null; STRIPFILL[kind+'Done']=Date.now();
  if(inPlan(P)) loadTripFlights(P); else document.querySelectorAll('.ds-filling').forEach(x=>x.remove());
}
// Komunikat na pasku dni: „Aktualizuję ceny…” w trakcie, a po skończeniu na chwilę „Ceny zaktualizowane”.
function stripNote(kind){
  if(STRIPFILL[kind]) return `<span class="ds-filling" role="status"><span class="spin sm" aria-hidden="true"></span> ${L2('Aktualizuję ceny…','Updating prices…')}</span>`;
  if(Date.now()-(STRIPFILL[kind+'Done']||0)<3000) return `<span class="ds-filling done" role="status"><i class="fa-solid fa-check" aria-hidden="true"></i> ${L2('Ceny zaktualizowane','Prices updated')}</span>`;
  return '';
}
function dateStrip(kind, selected, prices, label='', min='', byAirline=null, fromMin=false){
  const first=min&&min>ymdOf(0)?min:ymdOf(0), last=lastPlanDay(), days=[];
  if(fromMin){ for(let d=first; d<=addDays(selected,STRIP_DAYS) && d<=last; d=addDays(d,1)) days.push(d); } // powrót: od dnia wylotu
  else for(let i=-STRIP_DAYS;i<=STRIP_DAYS;i++){ const d=addDays(selected,i); if(d>=first && d<=last) days.push(d); }
  const known=prices?days.map(d=>prices.get(d)).filter(p=>p!=null):[], cheapest=known.length?Math.min(...known):null;
  const name=d=>new Date(d+'T12:00:00Z').toLocaleDateString(document.documentElement.lang==='en'?'en-GB':'pl-PL',{weekday:'short', timeZone:'UTC'});
  return `${label?`<div class="ds-label">${esc(label)}</div>`:''}<div class="date-strip ${STRIPFILL[kind]?'filling':''}" data-strip="${kind}">${stripNote(kind)}<button type="button" class="ds-arrow" data-shift="-1" aria-label="Wcześniejsze dni">‹</button><div class="ds-days">${days.map(d=>{ const p=prices?.get(d), cheap=p!=null&&p===cheapest;
    const upd=STRIPFILL[kind+'Range'] && p==null && d>=STRIPFILL[kind+'Range'].start && d<=STRIPFILL[kind+'Range'].end;
    return `<button type="button" class="ds-day ${d===selected?'on':''} ${cheap?'cheap':''}${upd?' ds-updating':''}" data-day="${d}" data-priced="${p!=null?1:0}">${cheap?'<em>Najtaniej</em>':''}<span>${esc(name(d))}</span><b>${fmtDay(d)}</b>${prices?(byAirline?airlineDayRows(byAirline.get(d)):`<small>${p!=null?Math.round(p)+' zł':'—'}</small>`):''}</button>`; }).join('')}</div><button type="button" class="ds-arrow" data-shift="1" aria-label="Późniejsze dni">›</button></div>`;
}
const AIRLINE_PLANE={RYANAIR:'#F1C933', WIZZ:'#7B2D8E'};
function airlineDayRows(prices){
  const row=(code,name)=>{ const p=prices?.[code]; return `<small class="ds-air" title="${name}"><i class="fa-solid fa-plane" style="color:${AIRLINE_PLANE[code]}" aria-hidden="true"></i> ${p!=null?Math.round(p)+' zł':'—'}</small>`; };
  return row('RYANAIR','Ryanair')+row('WIZZ','Wizz Air');
}
function centerStrip(root){
  root.querySelectorAll('.ds-day.on').forEach(on=>{ const box=on.parentElement; box.scrollLeft=on.offsetLeft-box.offsetLeft-(box.clientWidth-on.offsetWidth)/2; });
}
// Odświeżenie planu (np. co kilka sekund z danymi na żywo) nie może przewijać pasków dni ani list z powrotem na początek:
// paski i przewijane listy wracają tam, gdzie były; pasek dni wyśrodkowuje się tylko po wyborze innego dnia.
const KEEP_SCROLL='.ds-days,.twx-days,.timeline,.cp-results';
function scrollState(root){
  return [...root.querySelectorAll(KEEP_SCROLL)].map(el=>({left:el.scrollLeft, top:el.scrollTop, day:el.querySelector('.ds-day.on')?.dataset.day||''}));
}
function restoreScroll(root, kept){
  const now=[...root.querySelectorAll(KEEP_SCROLL)];
  if(now.length!==kept.length){ centerStrip(root); return; }
  now.forEach((el,i)=>{
    const was=kept[i], on=el.querySelector('.ds-day.on');
    if(on && on.dataset.day!==was.day){ el.scrollLeft=on.offsetLeft-el.offsetLeft-(el.clientWidth-on.offsetWidth)/2; return; }
    el.scrollLeft=was.left; el.scrollTop=was.top;
  });
}
/* ---------- Widok wyników planera ---------- */
const PLAN_SORTS=[['best','Najlepsze'],['leave','Najwcześniejszy odjazd'],['arrive','Najwcześniejszy przyjazd'],['time','Najkrótszy czas'],['changes','Najmniej przesiadek']];
const KIND_NAMES={bus:'Autobus miejski', pks:'Autobus podmiejski', train:'Pociąg'};
const PLAN_FILTERS=[
  {key:'changes', title:'Przesiadki', of:f=>[String(Math.min(f.changes,2))], order:['0','1','2'], label:v=>['Bez przesiadek','1 przesiadka','2 i więcej'][v]},
  {key:'dep', title:'Godziny odjazdu', of:f=>[dayPart(fmtClock(f.leave))], order:DAY_PARTS.map(p=>p.value), label:partLabel},
  {key:'arr', title:'Godziny przyjazdu', of:f=>[dayPart(fmtClock(f.arrive))], order:DAY_PARTS.map(p=>p.value), label:partLabel},
  {key:'kind', title:'Środki transportu', of:f=>f.kinds, order:['bus','pks','train'], label:v=>KIND_NAMES[v]},
];
const PLAN_ORDER={best:(x,y)=>x.leave-y.leave, leave:(x,y)=>x.leave-y.leave, arrive:(x,y)=>x.arrive-y.arrive, time:(x,y)=>(x.arrive-x.leave)-(y.arrive-y.leave), changes:(x,y)=>x.changes-y.changes||x.arrive-y.arrive};
function cardFacts(card, i){ const d=card.dataset; return {card, i, leave:+d.leave, arrive:+d.arrive, changes:+d.changes, kinds:d.kind.split(' ')}; }
function planPrices(){ const P=S.plan?.stages.find(x=>wantsFlights(x) && x.flights?.days); return P?new Map(P.flights.days.map(d=>[d.day,d.cheapest])):null; }
// Ceny dnia osobno dla Ryanaira i Wizz Air, do dwóch wierszy paska dni.
function airlinePrices(list){ return list?new Map(list.map(d=>[d.day,d.airlines||{}])):null; }
function planStrip(){
  const round=plRound.checked && plBack.value && S.agency==='podroz', P=S.plan?.stages.find(x=>wantsFlights(x) && x.flights?.backDays);
  const PF=S.plan?.stages.find(x=>wantsFlights(x) && x.flights?.days);
  const out=dateStrip('plan', plDate.value||ymdOf(0), planPrices(), round?'Wylot':'', '', airlinePrices(PF?.flights?.days));
  if(!round) return out;
  const back=P?new Map(P.flights.backDays.map(d=>[d.day,d.cheapest])):null;
  return out+dateStrip('back', plBack.value, back, 'Powrót', plDate.value||ymdOf(0), airlinePrices(P?.flights?.backDays), true);
}
function applyPlanView(){
  const root=document.getElementById('planResults'), box=document.getElementById('planFilters'); if(!box) return;
  const V=S.planView, facts=[...root.querySelectorAll('.res-card')].map(cardFacts);
  box.innerHTML=filterPanel(filterGroups(facts, PLAN_FILTERS), V.picked);
  const shown=facts.filter(f=>passesFilters(f, PLAN_FILTERS, V.picked));
  for(const f of facts){ f.card.hidden=!shown.includes(f); f.card.querySelector('.pc-badges').innerHTML=''; }
  const lists=new Map(); for(const f of facts){ if(!lists.has(f.card.parentElement)) lists.set(f.card.parentElement,[]); lists.get(f.card.parentElement).push(f); }
  for(const list of lists.values()){
    const anchor=list[0].card.previousElementSibling, sorted=[...list].sort((x,y)=>(PLAN_ORDER[V.sort]||(()=>0))(x,y)||x.i-y.i);
    if(anchor) anchor.after(...sorted.map(f=>f.card));
  }
  for(const stage of root.querySelectorAll('.trip-stage')){
    const P=stageOf(stage), list=shown.filter(f=>stage.contains(f.card) && !f.card.closest('[data-sec="rotate-left"]'));
    if(!list.length) continue;
    const best=[...list].sort((x,y)=>P?.by?y.leave-x.leave:x.arrive-y.arrive)[0], fast=[...list].sort(PLAN_ORDER.time)[0];
    best.card.querySelector('.pc-badges').innerHTML='<span class="pc-badge">Najlepsze</span>';
    if(fast!==best) fast.card.querySelector('.pc-badges').innerHTML='<span class="pc-badge alt">Najszybsze</span>';
  }
  const flights=root.querySelectorAll('.fl-card').length, total=shown.length+flights;
  const layout=root.querySelector('.res-layout'); layout.classList.toggle('no-filters', !box.innerHTML); layout.classList.toggle('no-results', !facts.length && !flights);
  document.getElementById('planCount').textContent=facts.length||flights?(total?countText(total):'Żaden wynik nie pasuje do filtrów'):'';
}

function stageOf(el){ return S.plan?.stages[+(el.closest('[data-stage]')?.dataset.stage||0)]; }
const pointParam=p=>p[0].toFixed(4)+','+p[1].toFixed(4);
async function loadDriving(P){
  P.driving=null;
  const a=P.origin.points[0], b=P.dest.points[0]; if(!a||!b) return;
  try{ const r=await fetch(`/api/driving?from=${pointParam(a)}&to=${pointParam(b)}`); if(r.ok) P.driving=(await r.json()).route; }
  catch(e){ console.warn('Trasa samochodowa', e); }
  if(inPlan(P) && P.driving) runPlan(false);
}
// Linie nie zawsze podają godzinę, więc taki lot sprawdzamy tylko po dniu.
function arrivesBy(f, by){
  const day=dayOfTs(by);
  return f.day<=day && (!f.arrival || f.arrival.slice(0,16).replace(' ','T')<=`${day}T${fmtClock(by)}`);
}
// Lotnisko, z którego podróżny woli latać: jego loty idą na początek listy, a przewoźnicy są o nie pytani w pierwszej kolejności.
const preferredAirport=()=>document.getElementById('plPrefer')?.value||'';
const flightRadius=()=>document.getElementById('plRadius')?.value||'300';
const radiusText=()=>flightRadius()==='any'?'dowolnej odległości':`promieniu ${flightRadius()} km`;
function syncPrefer(){
  const box=document.getElementById('plPreferBox'), sel=document.getElementById('plPrefer'); if(!box||!sel) return;
  box.hidden=!readModes().has('plane') || S.agency!=='podroz';
  const airports=(FL.data?.airports||[]).filter(a=>a.country==='Polska' && a.lat!=null).sort((x,y)=>natSort(x.city||x.code,y.city||y.code));
  const keep=sel.value||store('rzbus.plan.prefer')||'';
  if(airports.length && sel.options.length<=1) sel.innerHTML='<option value="">Dowolne</option>'+airports.map(a=>`<option value="${esc(a.code)}">${esc(a.city||a.code)} (${esc(a.code)})</option>`).join('');
  sel.value=keep; if(sel.value!==keep) sel.value='';
  const rad=document.getElementById('plRadius'); if(rad && !rad.dataset.ready){ rad.dataset.ready='1'; rad.value=String(store('rzbus.plan.radius')||'300'); }
}
async function loadTripFlights(P){
  loadFx(); // kurs EUR do cen w dwóch walutach
  const a=P.origin.points[0], b=P.dest.points[0];
  try{
    const r=await fetch(`/api/flights/options?origin=${pointParam(a)}&dest=${pointParam(b)}&date=${P.date||ymdOf(0)}${P.round?`&back=${P.round.back}`:''}&radius=${flightRadius()}&prefer=${preferredAirport()}`);
    P.flights=r.ok ? await r.json() : null;
    if(P.flights && P.by){ P.flights.options=P.flights.options.filter(f=>arrivesBy(f,P.by)); if(P.flights.outbound) P.flights.outbound=P.flights.outbound.filter(f=>arrivesBy(f,P.by)); }
    const prefer=preferredAirport(); P.prefer=prefer;

  }catch(e){ console.warn('Loty', e); P.flights=null; }
  // Najpierw ceny zapisane w bazie. Przewoźników pytamy sami tylko wtedy, gdy na te dni nie ma żadnych lotów;
  // aktualną cenę lotu sprawdza przycisk „Odśwież cenę”, a wszystkich lotów — „Sprawdź aktualne ceny”.
  if(P.flights && !P.flights.options.length && !P.asked && inPlan(P)){ if(document.body.classList.contains('guest')){ P.asked=true; P.fetch='login'; } else { askAirlines(P); return; } }
  if(scanYear(P)) return;
  if(inPlan(P)) runPlan(false);
}
// Bazy nie wypełniamy z wyprzedzeniem, więc gdy na te dni nie ma lotów, pytamy Ryanair i Wizz Air
// o trasy z najbliższych lotnisk, z których w ogóle da się dolecieć do celu — tylko o wybrane dni.
async function askAirlines(P){
  P.asked=true; P.fetch='asking'; if(inPlan(P)) runPlan(false);
  const C=P.flights?.options?flightChoice(P):null;
  for(const x of [C?.out, C?.ret]) if(x?.departure && !x.placeholder && ['WIZZ','RYANAIR'].includes(x.airline))
    fetch(x.airline==='RYANAIR'?'/api/flights/ryanair-time':'/api/flights/wizz-time',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from:x.from, to:x.to, time:x.departure})}).catch(()=>{});
  try{
    const r=await fetch('/api/flights/trip',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({origin:pointParam(P.origin.points[0]), dest:pointParam(P.dest.points[0]), date:P.date||ymdOf(0), back:P.round?.back||'', prefer:preferredAirport(), radius:flightRadius()})});
    const body=await r.json().catch(()=>({}));
    P.fetch=r.status===202?'running':r.status===409?'busy':r.status===503?'unavailable':r.ok?(body.reason||'fresh'):'error';
  }catch(e){ console.warn('Pytanie o loty', e); P.fetch='error'; }
  if(!inPlan(P)) return;
  if(P.fetch!=='running' && P.fetch!=='busy' && scanYear(P)) return;
  runPlan(false);
  if(P.fetch==='running' || P.fetch==='busy') watchTripFetch(P);
}
// Brak lotu w wybranym dniu i w dwóch tygodniach wokół niego: szukamy pierwszego lotu do roku naprzód
// (raz na wyszukiwanie) i proponujemy jego dzień w „Najbliższy lot”.
function scanYear(P){
  if(!P.flights || P.flights.options.length || P.flights.next || P.scanned || !P.asked || !inPlan(P)) return false;
  if(document.body.classList.contains('guest') || !['done','fresh','failed'].includes(P.fetch)) return false;
  P.scanned=true; P.fetch='scanning'; runPlan(false);
  fetch('/api/flights/first',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({origin:pointParam(P.origin.points[0]), dest:pointParam(P.dest.points[0]), date:P.date||ymdOf(0), prefer:preferredAirport(), radius:flightRadius()})})
    .then(r=>{ if(r.status===202){ watchTripFetch(P); return; } P.fetch='done'; loadTripFlights(P); })
    .catch(e=>{ console.warn('Szukanie najbliższego lotu', e); P.fetch='failed'; if(inPlan(P)) runPlan(false); });
  return true;
}
// Pasek postępu: ile zapytań do przewoźników jest zaplanowanych i ile już odpowiedziało (bez tego pasek „płynie”).
function busyProgress(p){
  S.busyProgress=p||null;
  const box=document.querySelector('#planResults .plan-busy'); if(!box) return;
  const bar=box.querySelector('.plan-busy-bar'), fill=bar?.querySelector('span'), count=box.querySelector('.plan-busy-count');
  const known=p && p.total>0, pct=known?Math.max(4,Math.min(100,Math.round(p.done/p.total*100))):0;
  bar?.classList.toggle('indet', !known);
  if(fill) fill.style.width=known?pct+'%':'';
  bar?.setAttribute('aria-valuenow', String(pct));
  if(count) count.textContent=known?`${p.done} z ${p.total} zapytań do przewoźników`:'Łączę się z przewoźnikami…';
}
async function watchTripFetch(P){
  await new Promise(resolve=>setTimeout(resolve, 1500));
  if(!inPlan(P)) return;
  let st=null; try{ st=await (await fetch('/api/flights/status')).json(); }catch(e){ console.warn('Stan pobierania lotów', e); }
  if(st?.progress) busyProgress(st.progress);
  if(st?.running){ watchTripFetch(P); return; }
  busyProgress(st?.progress?.total?{done:st.progress.total, total:st.progress.total}:null);
  if(P.fetch==='busy'){ P.asked=false; P.fetch=null; } // inne pobieranie się skończyło: sprawdzamy bazę i dopiero wtedy pytamy o swoje dni
  else P.fetch=st?.error?'failed':'done';
  FL.updating.clear();
  loadTripFlights(P);
}
const ASK_NOTES={
  asking:'Pobieram aktualne ceny…',
  scanning:'Szukam najbliższego lotu w ciągu roku…',
  running:'Pobieram aktualne ceny…',
  busy:'Pobieram aktualne ceny…',
};
// Gdy pobieramy aktualne ceny od przewoźników, plan i formularz są wyszarzone i zablokowane (inert), aż wszystko się
// skończy — wybór lotu czy dnia w trakcie pobierania i tak zostałby nadpisany nowymi cenami.
function planBusy(){
  const res=document.getElementById('planResults'), form=document.getElementById('planForm');
  const note=S.plan?.stages.map(P=>ASK_NOTES[P.fetch]).find(Boolean)||'';
  res.querySelector(':scope > .plan-busy')?.remove();
  res.classList.toggle('is-busy',!!note); res.inert=!!note;
  if(form){ form.classList.toggle('is-busy',!!note); form.inert=!!note; }
  if(!note) S.busyProgress=null;
  if(note){
    res.insertAdjacentHTML('afterbegin',`<div class="plan-busy" role="status"><div class="plan-busy-top"><span class="spin sm" aria-hidden="true"></span> <b>${esc(note)}</b> <small>Poczekaj — wybór lotów i dalsze kroki odblokują się po zakończeniu.</small></div>
      <div class="plan-busy-bar" role="progressbar" aria-label="Postęp pobierania cen" aria-valuemin="0" aria-valuemax="100"><span></span></div><small class="plan-busy-count"></small></div>`);
    busyProgress(S.busyProgress);
  }
}
const ASK_RESULTS={
  done:'Przewoźnicy nie mają lotów w tym dniu z lotnisk w pobliżu.',
  fresh:'Te dni sprawdzaliśmy u przewoźników w ciągu ostatnich 6 godzin.',
  'no-routes':'Ani Ryanair, ani Wizz Air nie latają do celu z lotnisk w promieniu 600 km.',
  login:'Zaloguj się, aby pobrać aktualną cenę od przewoźnika.',
  'fare-fresh':'Ten lot sprawdzaliśmy w ciągu ostatniej godziny.',
  'wizz-blocked':'Ceny Wizz Air pobiera rozkład Wizz Air przy planowaniu podróży i przycisk „Pobierz cenę tej godziny”.',
  unavailable:'Na tym serwerze nie da się teraz zapytać przewoźników o ceny.',
  failed:'Nie udało się pobrać lotów od przewoźników. Spróbuj ponownie za chwilę.',
  error:'Nie udało się zapytać przewoźników. Spróbuj ponownie za chwilę.',
};

/* ---------- Sprawdź kierunki: mapa świata z liniami lotów ---------- */
// Łuki z lotnisk w pobliżu do wszystkich kierunków z listy połączeń linii: Ryanair na żółto, Wizz Air na fioletowo.
// Kliknięcie kierunku wpisuje go w „Dokąd?”.
const EXPLORE={markers:new Map(), map:null, layer:null, from:null, airlines:new Set(['RYANAIR','WIZZ']), hidden:new Set(), removed:new Set(), open:store('rzbus.explore.open')!==false, drawn:'', style:store('podavo.explore.style')||'podavo', tiles:null, dests:new Map(), bounds:[], sel:null, summary:''};
const EXPLORE_COLORS={RYANAIR:'#F7C948', WIZZ:'#B04AE0'};
function exploreAirports(){ return new Map((FL.data?.airports||[]).filter(a=>a.lat!=null&&a.lon!=null).map(a=>[a.code,a])); }
// Punkt startu: miejsce z „Skąd?” zaplanowanej podróży, a bez niego Rzeszów.
function exploreHome(){ return S.plan?.stages?.[0]?.origin?.points?.[0] || [50.0413, 21.9990]; }
function exploreOrigins(){
  const airports=exploreAirports(), served=new Set(FL.network.map(r=>r.from)), home=exploreHome();
  return [...airports.values()].filter(a=>served.has(a.code)).map(a=>({...a, km:Math.round(hav(home,[a.lat,a.lon])/1000)})).sort((a,b)=>a.km-b.km);
}
// Gładki łuk między dwoma lotniskami: krzywa Béziera wygięta w bok, więcej dla dalszych lotów.
function exploreArc(a, b, bend){
  const [la1,lo1]=a, [la2,lo2]=b, mx=(la1+la2)/2, my=(lo1+lo2)/2, dx=la2-la1, dy=lo2-lo1, len=Math.hypot(dx,dy)||1;
  const k=Math.min(0.32, 0.12+len/220)*bend, cx=mx-dy*k, cy=my+dx*k, pts=[];
  for(let i=0;i<=32;i++){ const t=i/32, u=1-t; pts.push([u*u*la1+2*u*t*cx+t*t*la2, u*u*lo1+2*u*t*cy+t*t*lo2]); }
  return pts;
}
// Style mapy: „Podavo” (pastelowa mapa jak w Podavo Clean, assets/app.mapstyle.js) oraz kafelki Esri: ciemna, jasna i satelita.
// Gdy styl Podavo się nie wczyta, mapa pokazuje jasne kafelki Esri.
const EXPLORE_TILES={
  podavo:['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}','Esri, HERE, Garmin, © OpenStreetMap'],
  dark:['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}','Esri, HERE, Garmin, © OpenStreetMap'],
  light:['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}','Esri, HERE, Garmin, © OpenStreetMap'],
  satellite:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}','Esri, Maxar, Earthstar Geographics'],
};
const exploreTileUrl=()=>(EXPLORE_TILES[EXPLORE.style]||EXPLORE_TILES.dark)[0];
const exploreTileCredit=()=>(EXPLORE_TILES[EXPLORE.style]||EXPLORE_TILES.dark)[1];
function setExploreStyle(style){
  if(!EXPLORE_TILES[style]) return;
  EXPLORE.style=style; store('podavo.explore.style', style);
  document.querySelectorAll('[data-explore-style]').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.exploreStyle===style)));
  document.getElementById('explore')?.setAttribute('data-map-style', style);
  const m=EXPLORE.map; if(!m) return;
  const my=EXPLORE.styleToken=(EXPLORE.styleToken||0)+1;
  const raster=()=>L.tileLayer(exploreTileUrl(),{maxZoom:9, maxNativeZoom:7, noWrap:true, bounds:L.latLngBounds([-60,-170],[78,180]), attribution:exploreTileCredit()});
  const put=layer=>{ if(EXPLORE.tiles) m.removeLayer(EXPLORE.tiles); EXPLORE.tiles=layer.addTo(m); };
  if(style!=='podavo' || !window.PODAVO_MAP){ put(raster()); return; }
  if(!EXPLORE.tiles) put(raster());
  PODAVO_MAP.podavoLayer().then(l=>{ if(my===EXPLORE.styleToken) put(l); })
    .catch(()=>{ if(my===EXPLORE.styleToken && !(EXPLORE.tiles instanceof L.TileLayer)) put(raster()); });
}
function exploreFit(animate){
  if(EXPLORE.map && EXPLORE.bounds.length) EXPLORE.map.fitBounds(L.latLngBounds(EXPLORE.bounds),{padding:[24,24], maxZoom:5, animate});
}
// Opis pod tytułem strony: ile kierunków, z ilu lotnisk i którymi liniami.
function exploreSummary(){
  if(S.sub!=='kierunki' || !EXPLORE.summary) return;
  const lead=document.getElementById('heroLead'); if(lead && lead.dataset.summary!==EXPLORE.summary){ lead.textContent=EXPLORE.summary; lead.dataset.summary=EXPLORE.summary; }
}
// Polska odmiana liczebników: 1 kierunek, 2–4 kierunki, 5+ kierunków (ale 12–14 kierunków).
function plural(n, one, few, many){ const t=n%10, h=n%100; return n===1?one:(t>=2&&t<=4&&!(h>=12&&h<=14))?few:many; }
// Panel na mapie: liczba kierunków, lotnisk i linii oraz kierunki każdej linii.
function renderExploreStats(){
  const box=document.getElementById('exploreStats'); if(!box) return;
  const dests=[...EXPLORE.dests.values()], count=x=>dests.filter(d=>d.airlines.has(x)).length;
  const row=(icon,n,label)=>`<div class="es-row"><i class="${icon}" aria-hidden="true"></i><span><b>${n}</b><small>${label}</small></span></div>`;
  const nFrom=EXPLORE.from?.size||0, nAir=EXPLORE.airlines.size;
  box.innerHTML=row('oi oi-plane', dests.length, L2(plural(dests.length,'kierunek','kierunki','kierunków'), dests.length===1?'destination':'destinations'))
    +row('fa-solid fa-tower-broadcast', nFrom, L2(plural(nFrom,'lotnisko','lotniska','lotnisk'), nFrom===1?'airport':'airports'))
    +row('oi oi-route', nAir, L2(plural(nAir,'linia lotnicza','linie lotnicze','linii lotniczych'), nAir===1?'airline':'airlines'))
    +`<div class="es-legend">${[...EXPLORE.airlines].map(x=>`<span><i style="background:${EXPLORE_COLORS[x]}" aria-hidden="true"></i>${esc(AIRLINES[x]?.name||x)} (${count(x)})</span>`).join('')}</div>`;
}
// Karta wybranego kierunku: skąd lecimy, najbliższy lot, szacowany czas lotu i najniższa cena z bazy.
// Pogodę i opis miejsca pobieramy dopiero po otwarciu karty; serwer trzyma je w swojej pamięci podręcznej.
function openExploreCard(code){
  const box=document.getElementById('exploreCard'), d=EXPLORE.dests.get(code); if(!box || !d){ closeExploreCard(); return; }
  EXPLORE.sel=code;
  const a=d.airport, airports=exploreAirports(), routes=new Map((FL.data?.routes||[]).map(r=>[r.from+'|'+r.to, r]));
  const origins=[...d.from].map(c=>airports.get(c)).filter(Boolean).map(o=>({o, km:hav(exploreHome(),[o.lat,o.lon])/1000})).sort((x,y)=>x.km-y.km);
  const near=origins[0]?.o, others=origins.slice(1).map(x=>x.o.code);
  const first=[...d.from].map(c=>routes.get(c+'|'+code)?.firstDay).filter(Boolean).sort()[0];
  const flightKm=near?hav([near.lat,near.lon],[a.lat,a.lon])/1000:null, minutes=flightKm?Math.round(flightKm/780*60+30):null;
  const names=[...d.airlines].map(x=>AIRLINES[x]?.name||x).join(', '), wx=wxChip([a.lat,a.lon], ymdOf(0));
  const item=(icon,html)=>`<li><i class="${icon}" aria-hidden="true"></i><span>${html}</span></li>`;
  box.innerHTML=`<div class="ec-art" aria-hidden="true"></div>
    <button type="button" class="ec-close" data-explore-close aria-label="${L2('Zamknij kartę','Close card')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    <div class="ec-body">
      <h4>${esc(a.city)} (${esc(a.code)})</h4>
      <div class="ec-country">${esc(a.country||'')}</div>
      <ul>
        ${near?item('oi oi-plane', `${L2('Z','From')} ${esc(near.city)} (${esc(near.code)})${others.length?` <small>${L2('oraz','and')} ${esc(others.join(', '))}</small>`:''}`):''}
        ${item('oi oi-route', esc(names))}
        ${first?item('oi oi-calendar', `${L2('Najbliższy lot','Nearest flight')}: ${esc(longDay(first,{weekday:'short', day:'numeric', month:'short'}))}`):''}
        ${minutes?item('oi oi-clock', `≈ ${esc(isEn()?`${Math.floor(minutes/60)} h ${minutes%60} min`:fmtDuration(minutes))} <small>${L2('szacunek z odległości','estimated from distance')}</small>`):''}
        ${d.price!=null?item('oi oi-price', `${L2('od','from')} <b>${d.price} zł</b> <small>${L2('najniższa cena zapisana w bazie','lowest fare stored in our database')}</small>`):''}
        ${wx?item('fa-solid fa-cloud-sun', `${L2('Pogoda dziś','Weather today')} ${wx}`):''}
      </ul>
      <div class="ec-about" data-ec-about="${esc(a.code)}"><span class="spin sm" aria-hidden="true"></span> <small>${L2('Wczytuję opis…','Loading the description…')}</small></div>
      <button type="button" class="ec-plan" data-explore-pick="${esc(a.code)}">${L2('Zaplanuj podróż','Plan a trip')} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      <button type="button" class="ec-hide" data-explore-hide="${esc(a.code)}">${L2('Ukryj na mapie','Hide on the map')}</button>
    </div>`;
  box.hidden=false; box.closest('.explore-stage')?.classList.add('card-on');
  exploreMark(code); exploreRoutes({dest:code}); exploreListMark();
  aboutInfo(a.city, a.lat, a.lon).then(info=>{
    const el=box.querySelector(`[data-ec-about="${a.code}"]`); if(!el || EXPLORE.sel!==code) return;
    const text=info?.found?(info.description||String(info.extract||'').split(/(?<=\.)\s/)[0]||''):'';
    el.innerHTML=info?.found?`<p>${esc(text.length>220?text.slice(0,217)+'…':text)}</p><button type="button" class="ec-more" data-explore-about="${esc(a.code)}"><i class="fa-solid fa-landmark" aria-hidden="true"></i> ${L2('Więcej o miejscu','More about the place')}</button> <small class="ec-src">Wikipedia</small>`:'';
  }).catch(()=>{ const el=box.querySelector(`[data-ec-about="${a.code}"]`); if(el) el.innerHTML=''; });
}
function closeExploreCard(){
  const box=document.getElementById('exploreCard'); if(box){ box.hidden=true; box.closest('.explore-stage')?.classList.remove('card-on'); }
  if(EXPLORE.sel){ EXPLORE.sel=null; exploreMark(null); exploreListMark(); }
  exploreRoutes(null);
}
function exploreMark(code){ EXPLORE.markers.forEach((el,codes)=>el.classList.toggle('is-selected', !!code && codes.includes(code))); }
function exploreListMark(){ document.querySelectorAll('#exploreList [data-explore-dest]').forEach(b=>b.classList.toggle('on', b.dataset.exploreDest===EXPLORE.sel)); }
// Trasy rysujemy tylko dla wybranego kierunku albo lotniska wylotu, bez animacji, a nie całą sieć naraz.
function exploreRoutes(focus){
  const g=EXPLORE.routes; EXPLORE.focus=focus||null; if(!g) return; g.clearLayers(); if(!focus) return;
  const airports=exploreAirports();
  for(const r of EXPLORE.list||[]){
    if(focus.dest?r.to!==focus.dest:r.from!==focus.origin) continue;
    const a=airports.get(r.from), b=airports.get(r.to); if(!a || !b) continue;
    const lines=r.airlines.filter(x=>EXPLORE.airlines.has(x));
    lines.forEach((airline,i)=>L.polyline(exploreArc([a.lat,a.lon],[b.lat,b.lon], lines.length>1?(i?-1:1):1),{color:EXPLORE_COLORS[airline]||'#7FB3FF', weight:2.4, opacity:.9, interactive:false, pane:'exploreRoutes'}).addTo(g));
  }
}
// Kierunki jak dzielnice w Podavo Clean: bliskie sobie miejsca łączą się w kółko z liczbą kierunków, większe przy większej liczbie.
// Kółko z jednym kierunkiem otwiera jego kartę, a z kilkoma przybliża mapę do nich.
const EXPLORE_CELL=64, EXPLORE_TEAL='#24a690';
const exploreBubbleSize=n=>Math.round(Math.min(64, 30+Math.log2(Math.max(1,n))*8));
function exploreTip(list){
  if(list.length>1){ const names=list.slice(0,6).map(d=>d.airport.city).join(', '); return `<b>${list.length} ${esc(L2(plural(list.length,'kierunek','kierunki','kierunków'),'destinations'))}</b><br>${esc(names)}${list.length>6?' …':''}<br><small>${esc(L2('Kliknij, aby przybliżyć','Click to zoom in'))}</small>`; }
  const d=list[0], names=[...d.airlines].map(x=>AIRLINES[x]?.name||x).join(', ');
  return `<b>${esc(d.airport.city)} (${esc(d.airport.code)})</b><br>${esc(d.airport.country||'')}<br>${esc(names)} · ${esc(L2('z','from'))} ${esc([...d.from].join(', '))}${d.price!=null?`<br>${esc(L2('od','from'))} <b>${d.price} zł</b>`:''}`;
}
function exploreBubble(list, at){
  const n=list.length, size=exploreBubbleSize(n), codes=list.map(d=>d.airport.code), sel=!!EXPLORE.sel && codes.includes(EXPLORE.sel);
  const label=n>1?`${n} ${L2(plural(n,'kierunek','kierunki','kierunków'),'destinations')}`:`${list[0].airport.city} (${list[0].airport.code})`;
  // Kolor linii lotniczej: żółty Ryanair, fioletowy Wizz Air, a gdy latają obie — kółko podzielone w proporcji ich kierunków.
  const ry=list.filter(d=>d.airlines.has('RYANAIR')).length, wz=list.filter(d=>d.airlines.has('WIZZ')).length;
  const kind=ry&&wz?'both':wz?'wizz':'ryanair', share=ry&&wz?Math.round(ry/(ry+wz)*360):0;
  const fill=kind==='both'?`;--ry-deg:${share}deg`:'';
  const icon=L.divIcon({className:'explore-bubble-wrap', iconSize:[size,size], iconAnchor:[size/2,size/2],
    html:`<span class="explore-bubble ${kind}${n===1?' one':''}${sel?' is-selected':''}" style="--bubble-size:${size}px${fill}" role="button" aria-label="${esc(label)}">${n>1?`<b>${n}</b>`:'<i class="oi oi-plane" aria-hidden="true"></i>'}</span>`});
  const mk=L.marker(at,{icon, keyboard:true, title:label, riseOnHover:true, bubblingMouseEvents:false})
    .bindTooltip(exploreTip(list),{className:'explore-tip', direction:'top', offset:[0,-size/2]})
    .on('click', ()=>{
      if(n===1){ openExploreCard(codes[0]); return; }
      const b=L.latLngBounds(list.map(d=>[d.airport.lat,d.airport.lon]));
      const z=EXPLORE.map.getBoundsZoom(b, false, L.point(48,48));
      if(EXPLORE.map.getZoom()>=EXPLORE.map.getMaxZoom()-0.01){ openExploreCard(codes[0]); return; }
      if(z<=EXPLORE.map.getZoom()+0.01) EXPLORE.map.setView(b.getCenter(), Math.min(EXPLORE.map.getMaxZoom(), EXPLORE.map.getZoom()+1.5));
      else EXPLORE.map.fitBounds(b,{padding:[48,48], maxZoom:EXPLORE.map.getMaxZoom()});
    });
  mk.on('add', ()=>{ const el=mk.getElement()?.querySelector('.explore-bubble'); if(el) EXPLORE.markers.set(codes, el); });
  return mk;
}
// Na mapie są tylko kierunki z widocznego obszaru (z zapasem na przesuwanie), a lista obok pokazuje te same miejsca.
function exploreViewport(){
  const m=EXPLORE.map; if(!m || !EXPLORE.dots) return;
  const seen=m.getBounds(), near=seen.pad(0.25), shown=[], cells=new Map(), z=m.getZoom();
  for(const d of EXPLORE.dests.values()){
    const at=L.latLng(d.airport.lat,d.airport.lon); if(!near.contains(at)) continue;
    if(seen.contains(at)) shown.push(d);
    const p=m.project(at, z), k=Math.floor(p.x/EXPLORE_CELL)+':'+Math.floor(p.y/EXPLORE_CELL);
    const c=cells.get(k)||{list:[], x:0, y:0}; c.list.push(d); c.x+=p.x; c.y+=p.y; cells.set(k,c);
  }
  EXPLORE.dots.clearLayers(); EXPLORE.markers.clear();
  for(const c of cells.values()) EXPLORE.dots.addLayer(exploreBubble(c.list, m.unproject([c.x/c.list.length, c.y/c.list.length], z)));
  renderExploreList(shown);
}
const EXPLORE_LIST_MAX=60;
function renderExploreList(shown){
  const box=document.getElementById('exploreList'); if(!box) return;
  const n=shown.length, list=shown.sort((x,y)=>(x.price??1e9)-(y.price??1e9) || natSort(x.airport.city||'',y.airport.city||'')).slice(0,EXPLORE_LIST_MAX);
  box.classList.toggle('open', !!EXPLORE.sheet);
  box.innerHTML=`<button type="button" class="el-head" data-explore-sheet aria-expanded="${!!EXPLORE.sheet}"><span class="el-grip" aria-hidden="true"></span><span><b>${n}</b> ${esc(L2(plural(n,'kierunek','kierunki','kierunków'), n===1?'destination':'destinations'))} <small>${esc(L2('w widoku mapy','in the map view'))}</small></span><i class="fa-solid fa-chevron-up el-chev" aria-hidden="true"></i></button>
    <div class="el-legend">${[...EXPLORE.airlines].map(x=>`<span><i style="background:${EXPLORE_COLORS[x]}" aria-hidden="true"></i>${esc(AIRLINES[x]?.name||x)}</span>`).join('')}<span><i style="background:#24a690" aria-hidden="true"></i>${esc(L2('lotnisko wylotu','departure airport'))}</span></div>
    <ol class="el-items">${list.map(d=>`<li><button type="button" class="el-item ${EXPLORE.sel===d.airport.code?'on':''}" data-explore-dest="${esc(d.airport.code)}">
      <span class="el-dots" aria-hidden="true">${[...d.airlines].map(x=>`<i style="background:${EXPLORE_COLORS[x]}"></i>`).join('')}</span>
      <span class="el-name"><b>${esc(d.airport.city)}</b><small>${esc(d.airport.country||'')} · ${esc(L2('z','from'))} ${esc([...d.from].join(', '))}</small></span>
      ${d.price!=null?`<span class="el-price"><small>${esc(L2('od','from'))}</small> <b>${d.price} zł</b></span>`:''}</button></li>`).join('')}</ol>
    ${n>EXPLORE_LIST_MAX?`<p class="el-more">${esc(L2(`i ${n-EXPLORE_LIST_MAX} więcej. Przybliż mapę, aby je zobaczyć.`,`and ${n-EXPLORE_LIST_MAX} more. Zoom in to see them.`))}</p>`:''}
    ${!n?`<p class="el-more">${esc(L2('Brak kierunków w tym obszarze. Oddal mapę.','No destinations in this area. Zoom out.'))}</p>`:''}`;
}
function ensureExploreMap(){
  if(EXPLORE.map) return EXPLORE.map;
  const el=document.getElementById('exploreMap'); if(!el || !el.offsetParent) return null;
  const world=L.latLngBounds([-60,-170],[78,180]);
  const m=L.map(el,{zoomControl:true, attributionControl:true, worldCopyJump:false, minZoom:2, maxZoom:9, zoomSnap:0.25, preferCanvas:true, maxBounds:world, maxBoundsViscosity:1});
  m.attributionControl.setPrefix(false);
  L.control.scale({position:'bottomleft', metric:true, imperial:false, maxWidth:180}).addTo(m);
  const Center=L.Control.extend({options:{position:'topleft'}, onAdd(){ const b=L.DomUtil.create('div','leaflet-bar explore-center'); b.innerHTML=`<a href="#" role="button" title="${L2('Wyśrodkuj mapę','Centre the map')}" aria-label="${L2('Wyśrodkuj mapę','Centre the map')}"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i></a>`; L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b,'click',e=>{ L.DomEvent.preventDefault(e); exploreFit(true); }); return b; }});
  new Center().addTo(m);
  const Legend=L.Control.extend({options:{position:'topright'}, onAdd(){ const b=L.DomUtil.create('div','explore-map-legend'); b.setAttribute('aria-label',L2('Legenda','Legend'));
    b.innerHTML=`<span><i class="lg ryanair" aria-hidden="true"></i>Ryanair</span><span><i class="lg wizz" aria-hidden="true"></i>Wizz Air</span><span><i class="lg both" aria-hidden="true"></i>${L2('obie linie','both')}</span><span><i class="lg origin" aria-hidden="true"></i>${L2('wylot','departure')}</span>`; L.DomEvent.disableClickPropagation(b); return b; }});
  new Legend().addTo(m);
  m.setView([48,15],4);
  m.on('click', ()=>closeExploreCard());
  m.createPane('exploreRoutes').style.zIndex=390;
  m.on('moveend', ()=>{ clearTimeout(EXPLORE.moved); EXPLORE.moved=setTimeout(exploreViewport,120); });
  EXPLORE.map=m; EXPLORE.routes=L.layerGroup().addTo(m); EXPLORE.dots=L.layerGroup().addTo(m); EXPLORE.layer=L.layerGroup().addTo(m);
  setExploreStyle(EXPLORE.style);
  return m;
}
function renderExploreFrom(origins){
  const box=document.getElementById('exploreFrom'); if(!box) return;
  if(!EXPLORE.from) EXPLORE.from=new Set(origins.slice(0,3).map(a=>a.code));
  // Wszystkie polskie lotniska z połączeniami jako przyciski; każde inne można dodać z listy.
  for(const code of EXPLORE.removed) EXPLORE.from.delete(code);
  const listed=origins.filter(a=>!EXPLORE.removed.has(a.code)), polish=listed.filter(a=>a.country==='Polska'), extra=listed.filter(a=>a.country!=='Polska' && EXPLORE.from.has(a.code)), allPl=polish.length&&polish.every(a=>EXPLORE.from.has(a.code));
  box.innerHTML='<span class="explore-from-lbl">Wylot z:</span>'+`<button type="button" class="explore-chip all ${allPl?'on':''}" data-explore-all aria-pressed="${allPl}"><i class="oi oi-plane" aria-hidden="true"></i> Cała Polska <small>${polish.length}</small></button>`+[...polish,...extra].map(a=>`<span class="explore-chip-wrap ${EXPLORE.from.has(a.code)?'on':''}"><button type="button" class="explore-chip ${EXPLORE.from.has(a.code)?'on':''}" data-explore-from="${esc(a.code)}" aria-pressed="${EXPLORE.from.has(a.code)}">${esc(a.city)} (${esc(a.code)}) <small>${a.km} km</small></button><button type="button" class="explore-chip-x" data-explore-remove="${esc(a.code)}" title="Usuń z mapy" aria-label="Usuń ${esc(a.city)} z mapy"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`).join('')+
    `<label class="explore-add"><i class="fa-solid fa-plus" aria-hidden="true"></i><input id="exploreAdd" list="exploreAirportList" placeholder="Dodaj lotnisko" aria-label="Dodaj lotnisko wylotu" autocomplete="off"></label><datalist id="exploreAirportList">${origins.filter(a=>!EXPLORE.from.has(a.code)).map(a=>`<option value="${esc(a.city)} (${esc(a.code)})">${esc(a.country||'')}</option>`).join('')}</datalist>`+removedList();
}
// Usunięte lotniska wylotu i ukryte kierunki, każde do przywrócenia jednym kliknięciem.
function removedList(){
  // Bez listy usuniętych: lotnisko wraca przez „Dodaj lotnisko”, kierunek przez wyszukiwarkę, a wszystko naraz przez „Resetuj filtry”.
  if(!EXPLORE.removed.size && !EXPLORE.hidden.size) return '';
  return `<button type="button" class="explore-unhide" data-explore-unhide><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Resetuj filtry</button>`;
}
function renderExplore(){
  const sec=document.getElementById('explore'); if(!sec) return;
  sec.classList.toggle('closed', !EXPLORE.open);
  const t=document.getElementById('exploreToggle'); t.setAttribute('aria-expanded',String(EXPLORE.open)); t.querySelector('span').textContent=EXPLORE.open?'Ukryj mapę':'Pokaż mapę'; t.querySelector('i').className=`fa-solid fa-chevron-${EXPLORE.open?'up':'down'}`;
  document.querySelectorAll('[data-explore-air]').forEach(b=>{ const on=EXPLORE.airlines.has(b.dataset.exploreAir); b.classList.toggle('on',on); b.setAttribute('aria-pressed',String(on)); });
  if(discApply()) return;
  if(!FL.network.length || !FL.data){ document.getElementById('exploreInfo').textContent=FL.data===null?'Połączenia są chwilowo niedostępne.':'Wczytuję połączenia…'; return; }
  const origins=exploreOrigins(); renderExploreFrom(origins); exploreSuggestions();
  if(!EXPLORE.open) return;
  const m=ensureExploreMap(); if(!m) return;
  m.invalidateSize();
  const airports=exploreAirports(), from=EXPLORE.from, prices=new Map((FL.data.routes||[]).map(r=>[r.from+'|'+r.to, r]));
  const routes=FL.network.filter(r=>from.has(r.from) && airports.has(r.to) && !EXPLORE.hidden.has(r.to) && r.airlines.some(x=>EXPLORE.airlines.has(x)));
  const key=[...from].sort().join(',')+'|'+[...EXPLORE.airlines].sort().join(',')+'|'+[...EXPLORE.hidden].sort().join(',')+'|'+routes.length;
  if(EXPLORE.drawn===key){ exploreSummary(); return; }
  EXPLORE.drawn=key; EXPLORE.layer.clearLayers(); EXPLORE.dots.clearLayers(); EXPLORE.markers.clear(); EXPLORE.list=routes;
  const dests=new Map(), bounds=[];
  for(const r of routes){
    const b=airports.get(r.to), lines=r.airlines.filter(x=>EXPLORE.airlines.has(x));
    const d=dests.get(r.to)||{airport:b, airlines:new Set(), from:new Set(), price:null};
    lines.forEach(x=>d.airlines.add(x)); d.from.add(r.from);
    const p=prices.get(r.from+'|'+r.to); if(p && (d.price==null || p.cheapest<d.price)) d.price=Math.round(p.cheapest);
    dests.set(r.to,d); bounds.push([b.lat,b.lon]);
  }
  for(const code of from){ const a=airports.get(code); if(!a) continue; bounds.push([a.lat,a.lon]);
    L.marker([a.lat,a.lon],{icon:L.divIcon({className:'explore-bubble-wrap', iconSize:[30,30], iconAnchor:[15,15], html:'<span class="explore-bubble origin" style="--bubble-size:30px"><i class="oi oi-plane" aria-hidden="true"></i></span>'}), zIndexOffset:500, bubblingMouseEvents:false}).bindTooltip(`<b>${esc(a.city)} (${esc(a.code)})</b><br>lotnisko wylotu`,{className:'explore-tip', direction:'top'})
      .bindPopup(`<div class="explore-pop"><b>${esc(a.city)} (${esc(a.code)})</b><small>lotnisko wylotu</small><div class="explore-pop-btns"><button type="button" data-explore-remove="${esc(a.code)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Usuń z mapy</button></div></div>`,{className:'explore-popup', closeButton:false})
      .on('click', ()=>{ closeExploreCard(); exploreRoutes({origin:code}); }).addTo(EXPLORE.layer); }
  EXPLORE.dests=dests; EXPLORE.bounds=bounds;
  EXPLORE.summary=`${dests.size} kierunków z ${from.size} ${from.size===1?'lotniska':'lotnisk'} · ${[...EXPLORE.airlines].map(x=>AIRLINES[x]?.name||x).join(' i ')}`;
  document.getElementById('exploreInfo').textContent=EXPLORE.summary+(EXPLORE.hidden.size+EXPLORE.removed.size?` · usunięte: ${EXPLORE.hidden.size+EXPLORE.removed.size}`:'');
  renderExploreStats(); exploreSummary();
  exploreFit(false); exploreViewport();
  if(EXPLORE.sel){ if(dests.has(EXPLORE.sel)) openExploreCard(EXPLORE.sel); else closeExploreCard(); }
  else exploreRoutes(EXPLORE.focus?.origin && from.has(EXPLORE.focus.origin)?EXPLORE.focus:null);
}
// Widok mapy (lotniska wylotu, linie, ukryte kierunki) zapisany na koncie, a bez konta w tej przeglądarce.
function exploreView(){ return {from:[...(EXPLORE.from||[])], airlines:[...EXPLORE.airlines], hidden:[...EXPLORE.hidden], removed:[...EXPLORE.removed]}; }
function applyExploreView(v){
  if(!v) return;
  if(Array.isArray(v.from) && v.from.length) EXPLORE.from=new Set(v.from);
  if(Array.isArray(v.airlines) && v.airlines.length) EXPLORE.airlines=new Set(v.airlines.filter(x=>x==='RYANAIR'||x==='WIZZ'));
  if(Array.isArray(v.hidden)) EXPLORE.hidden=new Set(v.hidden);
  if(Array.isArray(v.removed)) EXPLORE.removed=new Set(v.removed);
  EXPLORE.drawn=''; renderExplore();
}
async function saveExploreView(){
  const view=exploreView();
  if(document.body.classList.contains('guest')){ store('rzbus.explore.view', view); toast('Zapisano widok mapy w tej przeglądarce. Zaloguj się, aby mieć go na każdym urządzeniu.'); return; }
  try{
    const current=(await (await fetch('/api/preferences')).json()).preferences||{};
    const r=await fetch('/api/preferences',{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({preferences:{...current, exploreView:view}})});
    toast(r.ok?'Zapisano widok mapy na Twoim koncie.':'Nie udało się zapisać widoku mapy.');
  }catch(e){ console.warn('Widok mapy', e); toast('Nie udało się zapisać widoku mapy.'); }
}
sessionUser.then(async user=>{
  if(!user){ applyExploreView(store('rzbus.explore.view')); return; }
  try{ const r=await fetch('/api/preferences'); if(r.ok) applyExploreView((await r.json()).preferences?.exploreView); }catch(e){ console.warn('Widok mapy', e); }
}).catch(()=>{});
// Szukanie miasta: podpowiedzi to wszystkie kierunki z polskich lotnisk; wybrane miasto mapa przybliża i otwiera jego kartę.
// Gdy z wybranych lotnisk tam nie latamy, dodajemy polskie lotniska, które mają ten kierunek.
function exploreDestinations(){
  const airports=exploreAirports(), polish=new Set([...airports.values()].filter(a=>a.country==='Polska').map(a=>a.code)), out=new Map();
  for(const r of FL.network){ const a=airports.get(r.to); if(!a || !polish.has(r.from) || polish.has(r.to)) continue; (out.get(r.to)||out.set(r.to,{airport:a, from:new Set()}).get(r.to)).from.add(r.from); }
  return out;
}
function exploreSuggestions(){
  const list=document.getElementById('exploreDestList'); if(!list || list.dataset.n===String(FL.network.length)) return;
  list.dataset.n=String(FL.network.length);
  list.innerHTML=[...exploreDestinations().values()].sort((x,y)=>natSort(x.airport.city||'',y.airport.city||'')).map(d=>`<option value="${esc(d.airport.city)}, ${esc(d.airport.country||'')} (${esc(d.airport.code)})"></option>`).join('');
}
function exploreFind(text){
  const code=/\(([A-Z]{3})\)\s*$/.exec(text.trim())?.[1], dests=exploreDestinations();
  if(code && dests.has(code)) return dests.get(code);
  const q=foldText(text.trim()); if(q.length<2) return null;
  const all=[...dests.values()];
  return all.find(d=>d.airport.code.toLowerCase()===q) || all.find(d=>foldText(d.airport.city)===q) || all.find(d=>foldText(d.airport.city).startsWith(q)) || all.find(d=>foldText(`${d.airport.city} ${d.airport.country}`).includes(q)) || null;
}
function exploreShow(text){
  const d=exploreFind(text);
  if(!d){ document.getElementById('exploreInfo').textContent=`Nie znaleźliśmy kierunku „${text.trim()}” z lotnisk w Polsce.`; return; }
  const code=d.airport.code;
  EXPLORE.hidden.delete(code);
  if(![...d.from].some(c=>EXPLORE.from?.has(c))){ for(const c of d.from){ EXPLORE.removed.delete(c); EXPLORE.from.add(c); } toast(`Do ${d.airport.city} latamy z: ${[...d.from].join(', ')} — dodano te lotniska wylotu.`); }
  if(!EXPLORE.open){ EXPLORE.open=true; store('rzbus.explore.open', true); }
  EXPLORE.drawn=''; renderExplore();
  const dest=EXPLORE.dests.get(code); if(!dest || !EXPLORE.map) return;
  EXPLORE.sel=code; EXPLORE.map.setView([dest.airport.lat,dest.airport.lon], Math.max(EXPLORE.map.getZoom(),5), {animate:true});
  openExploreCard(code);
}
document.getElementById('exploreSearchForm').addEventListener('submit', e=>{ e.preventDefault(); exploreShow(document.getElementById('exploreSearch').value); });
document.getElementById('exploreSearch').addEventListener('change', e=>{ if(/\([A-Z]{3}\)\s*$/.test(e.target.value)) exploreShow(e.target.value); });
// Wybrany kierunek przenosi do planera z uzupełnionym celem.
function exploreChoose(airport){
  goPage('podroz','');
  plTo.value=`${airport.city}${airport.country?', '+airport.country:''}`;
  document.getElementById('planHint').textContent=`Wybrano: ${airport.city} (${airport.code}). Uzupełnij daty i kliknij „Szukaj”.`;
  document.querySelector('.search-box')?.scrollIntoView({behavior:'smooth', block:'center'});
  setTimeout(()=>plDate.focus(),400);
}
document.getElementById('explore').addEventListener('change', e=>{
  if(e.target.id!=='exploreAdd') return;
  const code=/\(([A-Z]{3})\)$/.exec(e.target.value.trim())?.[1]||e.target.value.trim().toUpperCase();
  if(exploreAirports().has(code)){ EXPLORE.removed.delete(code); EXPLORE.from.add(code); renderExplore(); }
});
document.getElementById('explore').addEventListener('click', e=>{
  const air=e.target.closest('[data-explore-air]');
  if(air){ const a=air.dataset.exploreAir; if(EXPLORE.airlines.has(a) && EXPLORE.airlines.size>1) EXPLORE.airlines.delete(a); else EXPLORE.airlines.add(a); renderExplore(); return; }
  const fr=e.target.closest('[data-explore-from]');
  if(fr){ const c=fr.dataset.exploreFrom; if(EXPLORE.from.has(c) && EXPLORE.from.size>1) EXPLORE.from.delete(c); else EXPLORE.from.add(c); renderExplore(); return; }
  const style=e.target.closest('[data-explore-style]'); if(style){ setExploreStyle(style.dataset.exploreStyle); return; }
  if(e.target.closest('[data-explore-close]')){ closeExploreCard(); return; }
  const dest=e.target.closest('[data-explore-dest]');
  if(dest){ const d=EXPLORE.dests.get(dest.dataset.exploreDest); if(d){ EXPLORE.sel=d.airport.code; if(EXPLORE.map && !EXPLORE.map.getBounds().contains([d.airport.lat,d.airport.lon])) EXPLORE.map.panTo([d.airport.lat,d.airport.lon]); openExploreCard(d.airport.code); } return; }
  if(e.target.closest('[data-explore-sheet]')){ EXPLORE.sheet=!EXPLORE.sheet; const box=document.getElementById('exploreList'); box?.classList.toggle('open', EXPLORE.sheet); if(box && !EXPLORE.sheet) box.scrollTop=0; box?.querySelector('[data-explore-sheet]')?.setAttribute('aria-expanded', String(EXPLORE.sheet)); return; }
  const ab=e.target.closest('[data-explore-about]'); if(ab){ const d=EXPLORE.dests.get(ab.dataset.exploreAbout); if(d) openAbout({name:d.airport.city, lat:d.airport.lat, lon:d.airport.lon}); return; }
  const pick=e.target.closest('[data-explore-pick]'); if(pick){ const a=exploreAirports().get(pick.dataset.explorePick); EXPLORE.map?.closePopup(); if(a) exploreChoose(a); return; }
  const hide=e.target.closest('[data-explore-hide]'); if(hide){ EXPLORE.hidden.add(hide.dataset.exploreHide); EXPLORE.map?.closePopup(); closeExploreCard(); renderExplore(); return; }
  const rm=e.target.closest('[data-explore-remove]'); if(rm){ const c=rm.dataset.exploreRemove; EXPLORE.removed.add(c); EXPLORE.from.delete(c); if(!EXPLORE.from.size){ const next=exploreOrigins().find(a=>!EXPLORE.removed.has(a.code)); if(next) EXPLORE.from.add(next.code); } EXPLORE.map?.closePopup(); renderExplore(); return; }
  const rs=e.target.closest('[data-explore-restore]'); if(rs){ const c=rs.dataset.exploreRestore; if(EXPLORE.removed.delete(c)) EXPLORE.from.add(c); EXPLORE.hidden.delete(c); renderExplore(); return; }
  if(e.target.closest('[data-explore-unhide]')){ for(const c of EXPLORE.removed) EXPLORE.from.add(c); EXPLORE.removed.clear(); EXPLORE.hidden.clear(); renderExplore(); return; }
  if(e.target.closest('#exploreSave')){ saveExploreView(); return; }
  if(e.target.closest('[data-explore-all]')){ const pl=exploreOrigins().filter(a=>a.country==='Polska').map(a=>a.code), all=pl.every(c=>EXPLORE.from.has(c)); EXPLORE.from=new Set(all?pl.slice(0,3):pl); renderExplore(); return; }
  if(e.target.closest('#exploreToggle')){ EXPLORE.open=!EXPLORE.open; store('rzbus.explore.open', EXPLORE.open); renderExplore(); }
});

/* ---------- Odkrywanie (5b): lista kierunków z cenami z /api/discover ---------- */
// Domyślnie lista z cenami (najtańszy zapisany lot do każdego miejsca), mapa jednym kliknięciem. Wybór widoku i filtrów
// zostaje w tej przeglądarce. Do serwera idzie tylko punkt startu zaokrąglony do ok. 1 km.
const DISC={mode:store('podavo.disc.mode')==='map'?'map':'list', data:null, key:'', seq:0, f:store('podavo.disc.filters')||{}};
function discWhenOptions(){
  const sel=document.getElementById('discWhen'); if(!sel || sel.options.length) return;
  const today=ymdOf(0), add=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*864e5).toISOString().slice(0,10);
  const opts=[[`${today}|${add(today,30)}`, L2('Najbliższe 30 dni','Next 30 days')], [`${today}|${add(today,90)}`, L2('Najbliższe 3 miesiące','Next 3 months')]];
  const [y,m]=today.split('-').map(Number);
  for(let i=0;i<12;i++){
    const yy=y+Math.floor((m-1+i)/12), mm=(m-1+i)%12+1, first=`${yy}-${String(mm).padStart(2,'0')}-01`, last=new Date(Date.UTC(yy,mm,0)).toISOString().slice(0,10);
    const name=new Date(first+'T12:00:00Z').toLocaleDateString(isEn()?'en-GB':'pl-PL',{month:'long', year:'numeric', timeZone:'UTC'});
    opts.push([`${first<today?today:first}|${last}`, name.charAt(0).toUpperCase()+name.slice(1)]);
  }
  sel.innerHTML=opts.map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('');
  const nights=document.getElementById('discNights'), radius=document.getElementById('discRadius');
  const kept=[...sel.options].find(o=>o.text===DISC.f.whenText); if(kept) sel.value=kept.value; // „Najbliższe 30 dni” zostaje, choć jego daty idą naprzód
  if(DISC.f.nights!=null && [...nights.options].some(o=>o.value===String(DISC.f.nights))) nights.value=String(DISC.f.nights);
  if(DISC.f.radius && [...radius.options].some(o=>o.value===String(DISC.f.radius))) radius.value=String(DISC.f.radius);
}
// Pokazuje wybrany widok; true, gdy to lista (mapa się wtedy nie rysuje).
function discApply(){
  const sec=document.getElementById('explore'), list=DISC.mode==='list';
  sec.classList.toggle('disc-on', list);
  document.getElementById('disc').hidden=!list;
  document.querySelectorAll('[data-disc-mode]').forEach(b=>{ const on=b.dataset.discMode===DISC.mode; b.classList.toggle('on',on); b.setAttribute('aria-selected',String(on)); });
  const inp=document.getElementById('exploreSearch');
  if(inp){ inp.dataset.ph??=inp.placeholder; inp.placeholder=list?L2('np. Hiszpania w lutym na weekend do 400 zł','e.g. Spain in February for a weekend under 400 zł'):inp.dataset.ph; }
  if(list){ discWhenOptions(); loadDisc(); }
  return list;
}
function discQuery(){
  const [from,to]=(document.getElementById('discWhen').value||'|').split('|'), home=exploreHome();
  return new URLSearchParams({origin:`${(+home[0]).toFixed(2)},${(+home[1]).toFixed(2)}`, from, to, nights:document.getElementById('discNights').value||'0', radius:document.getElementById('discRadius').value||'300', limit:'60'});
}
function renderDisc(){
  const out=document.getElementById('discOut'); if(!out) return;
  if(DISC.data?.error){ out.innerHTML=`<div class="empty-note">${esc(DISC.data.error)}</div>`; return; }
  if(!DISC.data){ out.innerHTML=`<div class="empty-note">${esc(L2('Szukam najtańszych zapisanych lotów…','Looking for the cheapest stored flights…'))}</div>`; return; }
  const q=DISC.q||{}, words=(q.text||'').split(' ').filter(Boolean);
  const keep=d=>(q.maxPrice==null||d.flightPln<=q.maxPrice) && (!q.country||d.country===q.country)
    && words.every(w=>`${d.city} ${d.country} ${d.code} ${(d.alsoAirports||[]).join(' ')}`.toLocaleLowerCase('pl').includes(w));
  out.innerHTML=PVD.queryChips(q,L2)+PVD.list({...DISC.data, destinations:DISC.data.destinations.filter(keep)},{t:L2});
  const info=document.getElementById('exploreInfo'); if(info) info.textContent=L2(`${DISC.data.total} ${plural(DISC.data.total,'kierunek','kierunki','kierunków')} z cenami`, `${DISC.data.total} destinations with prices`);
}
async function loadDisc(force){
  const q=discQuery(), key=q.toString();
  if(!force && key===DISC.key && DISC.data){ renderDisc(); return; }
  DISC.key=key; DISC.data=null; renderDisc();
  const seq=++DISC.seq;
  try{
    const r=await fetch('/api/discover?'+q), body=await r.json().catch(()=>({}));
    if(seq!==DISC.seq) return;
    DISC.data=r.ok?body:{error:body.error||L2('Kierunki są chwilowo niedostępne.','Destinations are unavailable right now.')};
  }catch(e){ if(seq===DISC.seq) DISC.data={error:L2('Brak połączenia z serwerem.','No connection to the server.')}; }
  if(seq===DISC.seq){ if(document.getElementById('exploreSearch')?.value && DISC.data?.destinations) DISC.q=PVD.parseQuery(document.getElementById('exploreSearch').value,{today:ymdOf(0), countries:[...new Set(DISC.data.destinations.map(d=>d.country))]}); renderDisc(); }
}
function discPlan(code){
  const d=DISC.data?.destinations?.find(x=>x.code===code); if(!d) return;
  exploreChoose({city:d.city, country:d.country, code:d.code});
  plDate.value=d.outbound.day;
  if(d.ret){ document.querySelector('[data-round="1"]')?.click(); plBack.value=d.ret.day; }
  else if(plRound.checked) document.querySelector('[data-round="0"]')?.click();
  document.getElementById('planHint').textContent=L2(`Wybrano: ${d.city}, ${fmtDay(d.outbound.day)}${d.ret?' – '+fmtDay(d.ret.day):''}. Kliknij „Szukaj”, by sprawdzić aktualne ceny.`, `Chosen: ${d.city}, ${fmtDay(d.outbound.day)}${d.ret?' – '+fmtDay(d.ret.day):''}. Press “Search” to check current prices.`);
}
document.getElementById('explore').addEventListener('click', e=>{
  const m=e.target.closest('[data-disc-mode]');
  if(m){ DISC.mode=m.dataset.discMode; store('podavo.disc.mode', DISC.mode); renderExplore(); if(DISC.mode==='map') setTimeout(()=>EXPLORE.map?.invalidateSize(),60); return; }
  const p=e.target.closest('[data-disc-plan]'); if(p) discPlan(p.dataset.discPlan);
});
document.getElementById('disc').addEventListener('change', ()=>{
  const w=document.getElementById('discWhen');
  DISC.f={when:w.value, whenText:w.selectedOptions[0]?.text, nights:document.getElementById('discNights').value, radius:document.getElementById('discRadius').value};
  store('podavo.disc.filters', DISC.f); loadDisc();
});
// 5c: w trybie listy pole wyszukiwania rozumie życzenie („Hiszpania w lutym na weekend do 400 zł”) i ustawia filtry.
let discTyping=null;
function discFromText(){
  const text=document.getElementById('exploreSearch')?.value||'';
  const countries=[...new Set((DISC.data?.destinations||[]).map(d=>d.country))];
  DISC.q=PVD.parseQuery(text,{today:ymdOf(0), countries});
  let changed=false;
  if(DISC.q.month){ const w=document.getElementById('discWhen'), o=[...w.options].find(o=>o.value.slice(0,7)===DISC.q.month && o.value.slice(11,18)===DISC.q.month); if(o && w.value!==o.value){ w.value=o.value; changed=true; } }
  if(DISC.q.nights!=null){ const n=document.getElementById('discNights'); if(n.value!==String(DISC.q.nights)){ n.value=String(DISC.q.nights); changed=true; } }
  if(changed) document.getElementById('disc').dispatchEvent(new Event('change')); else renderDisc();
}
document.getElementById('exploreSearch')?.addEventListener('input', ()=>{ if(DISC.mode!=='list') return; clearTimeout(discTyping); discTyping=setTimeout(discFromText,350); });
document.getElementById('exploreSearchForm')?.addEventListener('submit', e=>{ if(DISC.mode!=='list') return; e.preventDefault(); e.stopImmediatePropagation(); clearTimeout(discTyping); discFromText(); }, true);

/* ---------- O miejscu (6b): opis z Wikipedii i fakty z Wikidata, w oknie ---------- */
const ABOUT=new Map();
const aboutName=name=>String(name).split(',')[0].replace(/\s*\([A-Z]{3}\)$/,'').trim();
async function aboutInfo(name, lat, lon){
  const clean=aboutName(name), lang=isEn()?'en':'pl', key=`${clean}|${(+lat).toFixed(2)}|${(+lon).toFixed(2)}|${lang}`;
  if(ABOUT.has(key)) return ABOUT.get(key);
  const r=await fetch('/api/places/about?'+new URLSearchParams({name:clean, lat:(+lat).toFixed(4), lon:(+lon).toFixed(4), lang}));
  const info=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(info.error||'');
  ABOUT.set(key, info); return info;
}
async function openAbout({name, lat, lon}){
  if(!window.PVUI || !name || lat==null || lon==null) return;
  const clean=aboutName(name);
  const h=PVUI.sheet.open({title:L2(`O miejscu: ${clean}`,`About ${clean}`), html:`<div class="empty-note">${esc(L2('Wczytuję opis…','Loading…'))}</div>`});
  try{
    const info=await aboutInfo(clean, lat, lon);
    // Tytuł arkusza: nazwa znalezionego artykułu („Rzym”), a nie etykieta lotniska, od której zaczęliśmy.
    if(info?.found && info.title){ const t=document.querySelector('.pv-sheet-layer:last-of-type .pv-sheet-title'); if(t) t.textContent=L2(`O miejscu: ${info.title}`,`About ${info.title}`); }
    h.setContent(PVD.aboutHtml(info,{t:L2}));
  }catch(e){ h.setContent(`<div class="empty-note">${esc(e.message||L2('Opis jest chwilowo niedostępny.','The description is unavailable right now.'))}</div>`); }
}
document.getElementById('explore').addEventListener('click', e=>{
  const a=e.target.closest('[data-disc-about]'); if(!a) return;
  const d=DISC.data?.destinations?.find(x=>x.code===a.dataset.discAbout); if(d) openAbout({name:d.city, lat:d.lat, lon:d.lon});
});

/* ---------- Tanie linie lotnicze ---------- */
const FL={data:null, network:[], byKey:new Map(), updating:new Set()};
const AIRLINES={RYANAIR:{name:'Ryanair', color:'#073590'}, WIZZ:{name:'Wizz Air', color:'#C6007E'}};
function airlineOf(f){ return AIRLINES[f.airline]||{name:f.airlineName||f.airline, color:'#5C5C5C'}; }
function fareKey(f){ return [f.airline,f.flightNumber||'',f.from,f.to,f.day,f.departure||''].join('|'); }
function offerKey(f){ return fareKey(f)+(f.ret?'>'+fareKey(f.ret):''); }
function flightDetail(f){ return `${f.from} → ${f.to} · ${fmtDay(f.day)}${f.departure?' '+f.departure.slice(11):''} · ${Math.round(f.pricePln)} zł`; }
function isSampleFare(f){ return f.source.startsWith('sample'); }
const foldName=s=>String(s||'').toLowerCase().replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
function knownAirports(){ return [...(FL.data?.airports||[]), ...(FL.data?.destinations||[])].filter(a=>a.lat!=null && a.lon!=null && a.city && a.country && a.country!=='Polska'); }
const airportAsPlace=a=>({label:`${a.city}, ${a.country}`, points:[[a.lat,a.lon]], airport:a.code});
// Dokładnie: „Miasto lotniska, Kraj”, „Miasto (KOD)” albo sam kod. Luźno (gdy adresy nic nie dały): nazwa miasta na początku.
function airportPlace(q, loose){
  const list=knownAirports(), t=foldName(q), head=foldName(q.split(',')[0].replace(/\([A-Z]{3}\)/,''));
  const code=/\(([A-Z]{3})\)/.exec(q)?.[1] || (/^[A-Z]{3}$/.test(q.trim())?q.trim():null);
  const hit=(code&&list.find(a=>a.code===code)) || list.find(a=>foldName(`${a.city}, ${a.country}`)===t)
    || (loose && head.length>=4 && list.find(a=>foldName(a.city)===head||foldName(a.city).startsWith(head+' ')||head.startsWith(foldName(a.city)+' ')));
  return hit?airportAsPlace(hit):null;
}
function foreignPlaces(){
  // Najpierw kierunki z lotami w bazie, potem wszystkie znane lotniska za granicą (np. Burgas, gdy lotów jeszcze nie pobrano).
  const seen=new Set(), out=[];
  for(const a of [...(FL.data?.destinations||[]), ...(FL.data?.airports||[])]){
    if(!a?.city || !a.country || a.country==='Polska' || a.lat==null || a.lon==null) continue;
    const label=`${a.city}, ${a.country}`; if(seen.has(label)) continue;
    seen.add(label); out.push({label, code:a.code||'', points:[[a.lat,a.lon]]});
  }
  return out;
}
async function flightSearch(params){
  const r=await fetch('/api/flights?'+new URLSearchParams(Object.entries(params).filter(([,v])=>v)));
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
async function loadFlights(){
  if(!FL.network.length){ try{ const r=await fetch('/api/flights/network'); if(r.ok) FL.network=(await r.json()).routes; }catch(e){ console.warn('Sieć połączeń', e); } }
  try{ FL.data=await flightSearch({}); FL.failed=false; }catch(e){ console.warn('Loty', e); FL.data=null; FL.failed=true; }
  loadDataStatus();
  syncPrefer();
  if(S.agency==='podroz' && S.sub==='kierunki') (window.requestIdleCallback||((fn)=>setTimeout(fn,200)))(()=>renderExplore(),{timeout:1500});
}
const clockOf=stamp=>stamp?stamp.slice(11,16):'';
// Przylot policzony z czasu lotu (z innych lotów tej trasy albo z odległości) ma znak „~”.
const arrivalOf=f=>f.arrival?`${f.arrivalEstimated?'~':''}${clockOf(f.arrival)}`:'';
const durationOf=f=>f.durationMin?`${f.arrivalEstimated?'ok. ':''}${fmtDuration(f.durationMin)}`:'';
// Wizz Air zna wszystkie odloty dnia, ale cenę tylko najtańszego; godzinę wybiera podróżny, a cenę aktualizuje tracker.
function timesRow(f){
  if(!f.times?.length || f.priceType!=='list') return '';
  const key=fareKey(f); FL.byKey.set(key,f);
  return `<div class="fl-times"><span class="fl-access-lbl">Odloty tego dnia</span>${f.times.map(t=>`<button type="button" class="fl-time ${t===f.departure?'on':''}" data-pick-time="${esc(key)}" data-time="${esc(t)}" aria-pressed="${t===f.departure}">${esc(t.slice(11))}</button>`).join('')}
    <small class="text-soft">${Math.round(f.pricePln)} zł to cena najtańszego lotu tego dnia. Cenę wybranej godziny pobierzesz przyciskiem „Pobierz cenę tej godziny”.</small></div>`;
}
function legRow(f, label){
  const x=f.placeholder?{name:'Lot do potwierdzenia', color:'#8F8F8F'}:airlineOf(f);
  return `<div class="fl-leg"><span class="fl-leg-label">${label}</span><span class="fl-airline" style="--a:${x.color}">${esc(x.name)}</span>
    <div class="pc-end"><b>${clockOf(f.departure)||'—'}</b><span>${esc(f.from)} · ${fmtDay(f.day)}</span></div>
    <div class="pc-span"><span>${esc([f.flightNumber, durationOf(f)].filter(Boolean).join(' · '))}</span><i class="pc-track"></i><span class="${f.stops?'txt-red':''}">${f.stops?`${changesText(f.stops)}${f.via?.length?' · przez '+esc(f.via.join(', ')):''}`:'bez przesiadek'}</span></div>
    <div class="pc-end pc-end-to"><b title="${f.arrivalEstimated?'Szacowany przylot: '+(f.durationFrom==='route'?'czas lotu z innych lotów tej trasy':'czas lotu z odległości'):''}">${arrivalOf(f)||'—'}</b><span>${esc(f.to)}</span></div></div>`;
}
const flightModalEl=document.getElementById('flightModal'); const flightModal=new bootstrap.Modal(flightModalEl);
function flightRows(f, title){
  const row=(k,v)=>v?`<div class="fl-detail"><span>${k}</span><b>${esc(v)}</b></div>`:'';
  return (title?`<h6 class="fl-detail-title">${title}</h6>`:'')+
    row('Lot',`${airlineOf(f).name}${f.flightNumber?' '+f.flightNumber:''} · ${f.fromLabel} → ${f.toLabel}`)+
    row('Wylot (czas lokalny)',`${fmtDay(f.day)} ${f.departure?f.departure.slice(11):'· brak godziny w tej cenie'}`)+row('Przylot (czas lokalny)',f.arrival?.slice(11))+
    row('Cena',`${Math.round(f.pricePln)} zł`+(f.currency&&f.currency!=='PLN'?` (${f.price} ${f.currency})`:''))+
    row('Rodzaj ceny',f.priceType==='list'?'Cena katalogowa, przed promocjami':'Cena konkretnego lotu')+
    row('Zostało miejsc',f.seatsLeft!=null?String(f.seatsLeft):'')+
    row('Cena z dnia',new Date(f.collectedAt).toLocaleDateString('pl-PL'))+
    (f.bookingUrl?`<a class="btn-ghost mt-2 d-inline-block" href="${esc(f.bookingUrl)}" target="_blank" rel="noopener">Sprawdź u przewoźnika</a>`:'');
}
function openFlight(key){
  const f=FL.byKey.get(key); if(!f) return;
  const x=airlineOf(f), P=S.plan?.stages.find(stage=>stage.flights), total=Math.round(f.pricePln+(f.ret?.pricePln||0));
  const hero=document.getElementById('flightHero'); hero.style.setProperty('--h1',x.color); hero.style.setProperty('--h2',x.color);
  hero.innerHTML=`<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Zamknij"></button>
    <span class="kicker mb-1">${esc(x.name)}${f.flightNumber?' · '+esc(f.flightNumber):''}</span><h4>${esc(f.fromLabel)} → ${esc(f.toLabel)}</h4><div class="sub">${fmtDay(f.day)}${f.ret?` · powrót ${fmtDay(f.ret.day)}`:''} · ${total} zł</div>`;
  document.getElementById('flightBody').innerHTML=flightRows(f, f.ret?'Wylot':'')+(f.ret?flightRows(f.ret,'Powrót'):'')+
    (isSampleFare(f)?'<div class="small text-soft mt-2">Próbka z zapisanych odpowiedzi linii. Cena może być nieaktualna.</div>':'')+
    `<div class="small text-soft mt-2">1 osoba, w cenie mała torba pod siedzenie, bez większego bagażu i wyboru miejsca. Aktualną cenę potwierdzisz u przewoźnika.</div>
    <div class="d-flex gap-2 flex-wrap mt-3">${favButton({type:'trip',view:'podroz',id:'f:'+key,from:P?.from||f.fromLabel,to:P?.to||f.toLabel,name:`${x.name} ${f.flightNumber||''}`.trim(),detail:flightDetail(f)+(f.ret?` · powrót ${flightDetail(f.ret)}`:''),...(tripFlight(f)?{flight:tripFlight(f)}:{})},'Zapisz podróż')}</div>`;
  flightModal.show();
}
let toastTimer=null;
function toast(text){ const el=document.getElementById('toastNote'); el.textContent=text; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{ el.hidden=true; },9000); }
// Krótki komunikat na dole ekranu.
/* ---------- Ulubione ---------- */
const FAV={items:store('rzbus.favs')||[], user:null};
const FAV_KINDS={ztm:'Autobusy', pks:'Podmiejskie', kolej:'Pociągi', podroz:'Podróż'};
// Trasy zapisane przed wspólnym planerem miały widok kategorii, a oznaczają to samo co nowe.
const favKey=f=>[f.type,f.type==='route'?'podroz':f.view,f.id||'',f.name||'',f.from||'',f.to||''].join('|');
function isFavorite(item){ return FAV.items.some(f=>favKey(f)===favKey(item)); }
function starText(on,label){ return (on?'★':'☆')+(label?' '+(on?'Zapisano':label):''); }
function saveHtml(on,label){ return on?'<i class="fa-solid fa-bookmark" aria-hidden="true"></i> Zapisano':`<i class="fa-regular fa-bookmark" aria-hidden="true"></i> ${esc(label)}`; }
function favButton(item,label=''){
  const on=isFavorite(item);
  if(label) return `<span class="fav-save-wrap"><span class="fav-star fav-save ${on?'on':''}" role="button" tabindex="0" data-fav="${esc(JSON.stringify(item))}" data-label="${esc(label)}" aria-pressed="${on}" title="${on?'Usuń z ulubionych':'Zapisz w ulubionych'}">${saveHtml(on,label)}</span><a class="fav-goto" href="/favourites#trips" data-fav-goto ${on?'':'hidden'}>Zobacz w ulubionych <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></span>`;
  return `<span class="fav-star ${on?'on':''}" role="button" tabindex="0" data-fav="${esc(JSON.stringify(item))}" data-label="" aria-pressed="${on}" title="${on?'Usuń z ulubionych':'Dodaj do ulubionych'}">${starText(on,'')}</span>`;
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
    star.classList.toggle('on',on); star.setAttribute('aria-pressed',String(on)); star.title=on?'Usuń z ulubionych':star.dataset.label?'Zapisz w ulubionych':'Dodaj do ulubionych';
    if(star.dataset.label){ star.innerHTML=saveHtml(on,star.dataset.label); const go=star.parentElement?.querySelector('[data-fav-goto]'); if(go) go.hidden=!on; }
    else star.textContent=starText(on,'');
  });
  renderMarkers();
  if(S.filter==='fav') renderLateList();
}
// Zapisy idą po kolei, żeby starsza lista nie nadpisała nowszej.
let favSaving=Promise.resolve();
function saveFavorites(){
  store('rzbus.favs', FAV.items);
  if(!FAV.user) return Promise.resolve();
  store('onward.favsPending', true);
  favSaving=favSaving.catch(()=>{}).then(async ()=>{
    let r;
    try{ r=await fetch('/api/favorites',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({favorites:FAV.items})}); }
    catch(e){ console.warn('Ulubione zapiszemy po powrocie połączenia', e); return false; }
    if(!r.ok) console.warn('Nie zapisano ulubionych', r.status);
    else window.TripPhotos?.run(); // zdjęcia czekające, aż podróż trafi na konto, mogą już iść
    if(r.ok || (r.status>=400 && r.status<500 && r.status!==408 && r.status!==429)) store('onward.favsPending', false);
    return r.ok;
  });
  return favSaving;
}
function toggleFavorite(item){
  const key=favKey(item);
  FAV.items=isFavorite(item) ? FAV.items.filter(f=>favKey(f)!==key) : [...FAV.items, item].slice(-50);
  saveFavorites().catch(e=>console.warn('Nie zapisano ulubionych', e));
  renderFavorites(); syncStars(); if(S.sub==='moje') renderMyTrips();
}
// Rodzaj ulubionego: trasy i podróże należą do planera, przystanki zapisane w planerze to autobusy.
function favKind(f){ return f.type==='route'||f.type==='trip' ? 'podroz' : f.view==='podroz' ? 'ztm' : f.view; }
const FAV_GROUPS=[
  {kind:'alerts', name:'Alerty cenowe', icon:'bell', empty:'Ustaw alert przyciskiem „Powiadom o cenie” przy locie lub zapisanej podróży.'},
  {kind:'podroz', name:'Podróże', icon:'route', empty:'Wyszukaj trasę w planerze i kliknij ☆, aby ją tu zapisać.'},
  {kind:'ztm', name:'Autobusy', icon:'bus', empty:'Kliknij ☆ przy linii lub przystanku autobusowym, aby je tu zapisać.'},
  {kind:'pks', name:'Podmiejskie', icon:'bus-simple', empty:'Kliknij ☆ przy linii lub przystanku komunikacji podmiejskiej, aby je tu zapisać.'},
  {kind:'kolej', name:'Pociągi', icon:'train', empty:'Kliknij ☆ przy pociągu lub stacji, aby je tu zapisać.'},
];
// Lot zapisanej podróży: nowe zapisy go przechowują, starsze odczytujemy z identyfikatora.
function savedFlight(f){
  if(f.flight?.from) return f.flight;
  const m=/^f:([A-Z]+)\|[^|]*\|([A-Z]{3})\|([A-Z]{3})\|(\d{4}-\d{2}-\d{2})/.exec(f.id||''); if(!m) return null;
  const back=/powrót (\d{2})\.(\d{2})/.exec(f.detail||''), year=m[4].slice(0,4);
  const backDay=back?(`${year}-${back[2]}-${back[1]}`<m[4]?`${+year+1}-${back[2]}-${back[1]}`:`${year}-${back[2]}-${back[1]}`):'';
  return {from:m[2], to:m[3], day:m[4], back:backDay, airline:m[1]};
}
const FAVP=new Map();
async function loadSavedPrice(key, fl){
  FAVP.set(key,{state:'loading'});
  try{
    const price=async(from,to,day)=>{ const r=await fetch('/api/flights?'+new URLSearchParams({from,to,date:day})); if(!r.ok) return null; const list=(await r.json()).flights.filter(x=>!fl.airline||x.airline===fl.airline); return list.length?Math.min(...list.map(x=>x.pricePln)):null; };
    const out=await price(fl.from,fl.to,fl.day), back=fl.back?await price(fl.to,fl.from,fl.back):0;
    FAVP.set(key,{state:'done', price:out!=null&&back!=null?Math.round(out+back):null});
  }catch(e){ console.warn('Cena zapisanej podróży', e); FAVP.set(key,{state:'done', price:null}); }
  if(S.sub==='ulubione') renderFavorites(); else if(S.sub==='trip') renderTripPage();
}
async function refreshSavedPrice(key, fl){
  FAVP.set(key,{state:'asking'}); renderFavorites();
  let state='done';
  try{
    const r=await fetch('/api/flights/fare',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from:fl.from, to:fl.to, day:fl.day, back:fl.back||'', airline:fl.airline})});
    if(r.status===202 || r.status===409){ for(let i=0;i<120;i++){ await new Promise(res=>setTimeout(res,5000)); const st=await (await fetch('/api/flights/status')).json().catch(()=>null); if(!st?.running) break; } }
    else if(r.status===503) state='unavailable';
  }catch(e){ console.warn('Odświeżanie ceny', e); }
  if(state==='unavailable'){ FAVP.set(key,{state, price:FAVP.get(key)?.price}); renderFavorites(); return; }
  await loadSavedPrice(key, fl);
}
function savedPriceHtml(key, fl, stored){
  const p=FAVP.get(key);
  if(!p) loadSavedPrice(key, fl);
  const now=p?.state==='asking'?'<span class="spin sm" aria-hidden="true"></span> pytam przewoźnika…':p?.state==='loading'||!p?'sprawdzam cenę…':p.state==='unavailable'?'na tym serwerze nie da się teraz zapytać przewoźnika':p.price!=null?`teraz ${p.price} zł`:'brak aktualnej ceny';
  const diff=p?.price!=null&&stored?p.price-stored:null;
  return `<div class="fav-price"><span>${stored?`zapisano za ${stored} zł · `:''}${now}${diff?` <b class="${diff<0?'txt-ok':'txt-red'}">${diff<0?'':'+'}${diff} zł</b>`:''}</span>
    <span class="fav-price-tools"><button class="btn-ghost" type="button" data-fav-refresh="${esc(key)}" ${p?.state==='asking'?'disabled':''}><i class="fa-solid fa-rotate" aria-hidden="true"></i> Odśwież cenę</button><button class="btn-ghost" type="button" data-fav-alert="${esc(key)}"><i class="fa-solid fa-bell" aria-hidden="true"></i> Powiadom o cenie</button></span></div>`;
}
// Nazwa podróży do alertów: własny tytuł, a bez niego miasta (bez ulicy i numeru domu z „Skąd?”).
function placeShort(s){ const parts=String(s||'').split(',').map(x=>x.trim()).filter(Boolean); return parts.length>1 && /\d/.test(parts[0]) ? parts[1] : (parts[0]||''); }
function tripName(f){ return f?.title || `${placeShort(f?.from)} → ${placeShort(f?.to)}`; }
function alertTrip(a){ return FAV.items.find(f=>{ if(f.type!=='trip') return false; const fl=savedFlight(f); return fl && fl.from===a.from && fl.to===a.to && fl.day===a.day; }); }
function alertName(a){ const t=alertTrip(a); return t ? tripName(t) : String(a.label||a.from+' → '+a.to).split(' → ').map(placeShort).join(' → '); }
function alertCard(a){
  const price=a.currentPrice!=null?`teraz ${Math.round(a.currentPrice)} zł`:'brak ceny';
  return `<div class="fav-card fav-alert ${a.reached?'reached':''}"><span class="fav-ico"><i class="fa-solid fa-bell" aria-hidden="true"></i></span>
    <div class="fav-card-open"><b>${esc(alertName(a))}</b><small>${esc(a.from)} → ${esc(a.to)} · ${fmtDay(a.day)}${a.back?' – '+fmtDay(a.back):''} · do ${a.maxPrice} zł · ${ALERT_EVERY[a.everyHours]||''}</small>
      <small>${price}${a.reached?' · <span class="chip ok">Cena osiągnięta</span>':''}${a.notifiedAt?' · wysłano e-mail':''}</small></div>
    <button class="fav-card-remove" type="button" data-alert-remove="${esc(a.id)}" title="Usuń alert" aria-label="Usuń alert"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>`;
}
function favCard(f){
  const kind=favKind(f), key=esc(favKey(f));
  let badge, title, sub;
  if(f.type==='route'||f.type==='trip'){
    badge=`<span class="fav-ico"><i class="fa-solid fa-${f.type==='trip'?'suitcase-rolling':'route'}" aria-hidden="true"></i></span>`;
    title=f.title?esc(f.title):esc(routeText(f));
    sub=f.type==='trip'?[f.title?routeText(f):'',f.name,f.detail].filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join(' · '):'Trasa'; // osobno, żeby każda część dała się przetłumaczyć
  } else if(f.type==='line' && kind!=='kolej'){
    const r=GT.routes.get(f.id);
    badge=`<span class="leg-line fav-line" style="background:${r?lineColor(r.short,r.color,r.agency):'var(--navy)'}">${esc(f.name)}</span>`;
    title=r?.long?esc(r.long):`Linia ${esc(f.name)}`;
    sub=kind==='pks'?'Linia podmiejska':'Linia autobusowa';
  } else if(f.type==='line'){
    badge=`<span class="fav-ico"><i class="fa-solid fa-train" aria-hidden="true"></i></span>`;
    title=esc(f.name); sub='Pociąg';
  } else {
    badge=`<span class="fav-ico"><i class="fa-solid fa-${kind==='kolej'?'building-columns':'signs-post'}" aria-hidden="true"></i></span>`;
    title=esc(f.name); sub=kind==='kolej'?'Stacja':'Przystanek';
  }
  const fl=f.type==='trip'?savedFlight(f):null;
  return `<div class="fav-card ${fl?'has-price':''}">${badge}<button class="fav-card-open" type="button" data-fav-open="${key}"><b>${title}</b><small>${sub}</small></button>
    <button class="fav-card-remove" type="button" data-fav-remove="${key}" title="Usuń z ulubionych" aria-label="Usuń z ulubionych"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>${fl?savedPriceHtml(favKey(f),fl,f.flight?.price):''}</div>`;
}
// Zapisane podróże z datami na osi czasu: miesiące, a w nich podróże od najbliższej; minione na końcu, przygaszone.
const longDay=(d, opts)=>new Date(d+'T12:00:00Z').toLocaleDateString(document.documentElement.lang==='en'?'en-GB':'pl-PL',{timeZone:'UTC', ...opts});
// Daty podróży bez samolotu: dzień wyjazdu i (jeśli jest) powrotu.
function groundDates(f){ const m=f.trip?.multi?f.trip.legs:null; if(m?.length){ const last=m[m.length-1].arrDay||m[m.length-1].day; return {day:m[0].day, back:last>m[0].day?last:'', ground:true}; }
  const g=f.trip?.ground; if(!g?.out) return null; const last=(g.legs||[g.out]).at(-1)?.day||''; return {day:g.out.day, back:g.back?.day||g.roundBack||(last>g.out.day?last:''), ground:true, ...(g.roundBack&&!g.back?{noReturn:true}:{})}; }
// Koniec podróży (dzień powrotu albo wyjazdu); minione to te, które skończyły się przed dzisiaj.
const tripEnd=f=>{ const fl=f.type==='trip'?(savedFlight(f)||groundDates(f)):null; return fl?.back||fl?.day||''; };
const tripIsPast=f=>{ const end=tripEnd(f); return !!end && end<ymdOf(0); };
// only: 'upcoming' (nadchodzące i bez dat), 'past' (archiwum, pogrupowane latami) albo nic (wszystko, minione na końcu).
function tripTimeline(list, {booked=false, only=''}={}){
  const today=ymdOf(0), dated=[], rest=[];
  for(const f of list){ const fl=f.type==='trip'?(savedFlight(f)||groundDates(f)):null; (fl?.day?dated:rest).push({f, fl}); }
  const end=x=>x.fl.back||x.fl.day;
  const upcoming=only==='past'?[]:dated.filter(x=>end(x)>=today).sort((a,b)=>a.fl.day.localeCompare(b.fl.day));
  const past=only==='upcoming'?[]:dated.filter(x=>end(x)<today).sort((a,b)=>b.fl.day.localeCompare(a.fl.day));
  const between=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/86400000);
  const archive=only==='past';
  const item=({f, fl})=>{
    const key=esc(favKey(f)), gone=end({fl})<today, now=fl.day<=today&&!gone, inDays=between(today, fl.day);
    const stay=fl.back?between(fl.day, fl.back)+1:0;
    const when=gone?(archive?'':'minęła'):now?'trwa':inDays===0?'dziś':`za ${inDays} ${inDays===1?'dzień':'dni'}`;
    const mine=SHARED.mine[f.tid]||[];
    // „Udostępnij” i z kim podróż jest udostępniona idą osobnym wierszem pod nazwą, żeby nazwa miała całą szerokość karty.
    const share=booked&&!f.shared&&f.tid&&FAV.user&&!gone?`<button type="button" class="tl-share" data-trip-share="${esc(f.tid)}" title="${L2('Udostępnij podróż znajomemu','Share the trip with a friend')}"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Udostępnij','Share')}${mine.length?` <small>${mine.length}</small>`:''}</button>`:'';
    const sharedText=f.shared?`<span class="tl-badge-shared"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Udostępnił(a)','Shared by')}: ${esc(f.shared.ownerName)}</span>`
      :mine.length?`<span class="tl-shared"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Udostępniona','Shared with')}: ${esc(mine.join(', '))}</span>`:'';
    return `<div class="tl-item ${gone&&!archive?'past':''}">
      <div class="tl-date"><b>${longDay(fl.day,{day:'numeric'})}</b><small>${longDay(fl.day,{month:'short'})}</small></div>
      <div class="tl-card">
        <div class="tl-head"><span class="fav-ico"><i class="fa-solid fa-${archive?'box-archive':'suitcase-rolling'}" aria-hidden="true"></i></span>
          <button class="fav-card-open" type="button" ${f.shared?`data-trip-open="${esc(tidOf(f))}"`:`data-fav-open="${key}"`}><b>${f.title?esc(f.title):`Podróż do ${esc(f.to)}`}</b>
            <small class="tl-dates"><span>${longDay(fl.day,{weekday:'short', day:'numeric', month:'long'})}</span>${fl.back?` – <span>${longDay(fl.back,{weekday:'short', day:'numeric', month:'long', year:'numeric'})}</span>`:` <span>${longDay(fl.day,{year:'numeric'})}</span>`}${stay?` · <span>${stay} ${stay===1?'dzień':'dni'}</span>`:''}</small></button>
          ${when?`<span class="tl-when ${now?'now':''}">${when}</span>`:''}
          ${f.shared?'':`<button class="fav-card-remove" type="button" data-fav-remove="${key}" title="${booked?'Usuń podróż':'Usuń z ulubionych'}" aria-label="${booked?'Usuń podróż':'Usuń z ulubionych'}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}</div>
        ${share||sharedText?`<div class="tl-actions">${share}${sharedText}</div>`:''}
        <div class="tl-sub"><span>${esc(routeText(f))}</span>${f.name?` · <span>${esc(f.name)}</span>`:''}${f.trip?.xfer?` · <span>${f.trip.xfer.skip?'odbiór z lotniska':esc(f.trip.xfer.name)}</span>`:''}${fl.noReturn&&!gone?` · <span class="tl-noreturn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Nie wybrano powrotu</span>`:''}</div>
        ${gone||booked||fl.ground?'':savedPriceHtml(favKey(f), fl, f.flight?.price)}
      </div></div>`;
  };
  let month='', html='';
  for(const x of upcoming){
    const m=longDay(x.fl.day,{month:'long', year:'numeric'});
    if(m!==month){ html+=`<div class="tl-month">${m}</div>`; month=m; }
    html+=item(x);
  }
  if(archive){ let year=''; for(const x of past){ const y=x.fl.day.slice(0,4); if(y!==year){ html+=`<div class="tl-month">${y}</div>`; year=y; } html+=item(x); } }
  else if(past.length) html+=`<div class="tl-month tl-past">Minione</div>`+past.map(item).join('');
  const others=only==='past'?[]:rest;
  return (html?`<div class="trip-timeline">${html}</div>`:'')+(others.length?`<h4 class="fav-subtitle">Zapisane trasy</h4><div class="fav-grid">${others.map(x=>favCard(x.f)).join('')}</div>`:'');
}
// Liczniki w prawym górnym rogu przycisków „Moje podróże” i „Ulubione”.
function navCounts(){
  const set=(id,n,label)=>{ const el=document.getElementById(id); if(!el) return; el.hidden=!n; el.textContent=n>99?'99+':String(n); el.setAttribute('aria-label',`${n} ${label}`); };
  // Tylko nadchodzące i trwające podróże; minione zostają na liście, ale nie w liczniku.
  const upcoming=f=>{ const fl=savedFlight(f)||groundDates(f), end=fl?.back||fl?.day; return !end || end>=ymdOf(0); };
  set('myTripsCount', FAV.items.filter(f=>f.type==='trip' && f.status==='booked' && upcoming(f)).length, 'podróży');
  set('favCount', FAV.items.filter(f=>f.status!=='booked').length, 'ulubionych');
  document.querySelectorAll('[data-count-of]').forEach(b=>{ const src=document.getElementById(b.dataset.countOf); b.hidden=!src||src.hidden; b.textContent=src?.textContent||''; });
}
function renderFavorites(){
  navCounts();
  const filters=document.getElementById('favFilters'), page=document.getElementById('favPage'), items=FAV.items.filter(f=>f.status!=='booked');
  if(!page) return;
  const count=kind=>kind==='alerts'?ALERTS.list.length:items.filter(f=>kind==='all'||favKind(f)===kind).length+(kind==='all'?ALERTS.list.length:0);
  if(!ALERTS.loaded && !document.body.classList.contains('guest')) loadAlerts();
  filters.innerHTML=[{kind:'all',name:'Wszystkie'},...FAV_GROUPS].map(g=>`<button type="button" class="fav-filter ${FAVF.kind===g.kind?'on':''}" data-fav-kind="${g.kind}" aria-pressed="${FAVF.kind===g.kind}">${g.icon?`<i class="fa-solid fa-${g.icon}" aria-hidden="true"></i> `:''}${g.name} <small>${count(g.kind)}</small></button>`).join('');
  const groups=FAV_GROUPS.filter(g=>FAVF.kind==='all'||g.kind===FAVF.kind);
  if(FAVF.kind==='all' && !items.length && !ALERTS.list.length){ page.innerHTML='<div class="empty-note">'+stateIll(assetPaths.noFavourites)+'Nie masz jeszcze ulubionych. Kliknij ☆ przy trasie, linii, przystanku, stacji lub pociągu, aby je tu zapisać.</div>'; return; }
  page.innerHTML=groups.map(g=>{
    if(g.kind==='alerts'){
      if(!ALERTS.list.length && FAVF.kind==='all') return '';
      const body=document.body.classList.contains('guest')?'<div class="empty-note">Zaloguj się, aby ustawiać alerty cenowe.</div>':ALERTS.list.length?`<div class="fav-grid">${ALERTS.list.map(alertCard).join('')}</div>`:`<div class="empty-note">${g.empty}</div>`;
      return `<section class="fav-group"><h3 class="fav-group-title"><i class="fa-solid fa-bell" aria-hidden="true"></i> ${g.name} <small>${ALERTS.list.length}</small></h3>${body}</section>`;
    }
    const list=items.filter(f=>favKind(f)===g.kind);
    if(!list.length && FAVF.kind==='all') return '';
    return `<section class="fav-group"><h3 class="fav-group-title"><i class="fa-solid fa-${g.icon}" aria-hidden="true"></i> ${g.name} <small>${list.length}</small></h3>
      ${!list.length?`<div class="empty-note">${g.empty}</div>`:g.kind==='podroz'?tripTimeline(list):`<div class="fav-grid">${list.map(favCard).join('')}</div>`}</section>`;
  }).join('');
}
document.getElementById('favPage').addEventListener('click', e=>{
  const rm=e.target.closest('[data-alert-remove]'); if(rm){ removeAlert(rm.dataset.alertRemove); return; }
  const item=key=>FAV.items.find(x=>favKey(x)===key);
  const rf=e.target.closest('[data-fav-refresh]'); if(rf){ const f=item(rf.dataset.favRefresh), fl=f&&savedFlight(f); if(fl) refreshSavedPrice(rf.dataset.favRefresh, fl); return; }
  const fa=e.target.closest('[data-fav-alert]'); if(fa){ const f=item(fa.dataset.favAlert), fl=f&&savedFlight(f); if(fl) openAlertDialog({...fl, price:FAVP.get(fa.dataset.favAlert)?.price??f.flight?.price??null, label:tripName(f)}); }
});
document.getElementById('favFilters').addEventListener('click', e=>{
  const b=e.target.closest('[data-fav-kind]'); if(!b) return;
  FAVF.kind=b.dataset.favKind; setSubpage('ulubione');
});
// Wybory zapisanego planu; starsze zapisy mają wylot i dojazd tylko w identyfikatorze („f:<lot>:<dojazd>”).
/* ---------- Zapisane podróże: plan w ulubionych albo „Moje podróże”, z osobną stroną szczegółów ---------- */
// Identyfikator strony podróży: nowe zapisy mają własny, starsze dostają skrót z klucza ulubionego.
function hashText(t){ let h=5381; for(let i=0;i<t.length;i++) h=((h<<5)+h+t.charCodeAt(i))>>>0; return h.toString(36); }
const tidOf=f=>f.tid||('k'+hashText(favKey(f))).padEnd(6,'0');
const newTid=()=>(Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,12);
function findTrip(id){ return id?FAV.items.find(f=>f.type==='trip' && tidOf(f)===id)||sharedTrip(id)||null:null; }
// Po otwarciu podróży z połączeniem: zapisane plany dni jej miast trafiają do kopii offline (pobiera je service worker).
function warmTripOffline(id){
  if(navigator.onLine===false || document.body.classList.contains('guest') || !AIP.enabled) return;
  const f=findTrip(id), T=f?.trip; if(!f?.tid || !T || f.shared) return;
  const cities=(T.airport||T.ground||T.multi)?tripCities(T,f):[];
  for(const c of cities.slice(0,6)) fetch('/api/ai/city-plan?'+new URLSearchParams({tid:f.tid, city:c.label})).catch(()=>{});
}
function openTrip(id, opts={}){ setTimeout(()=>(window.requestIdleCallback||setTimeout)(()=>warmTripOffline(id)),1500); TRIPV.id=id; TRIPV.city=false; TRIPV.cityAt=undefined; TRIPV.step='go'; TRIPV.map=false; TRIPV.sheet=''; TRIPV.back=''; PEOPLE.invite=!!opts.invite; PEOPLE.open=!!opts.invite; PEOPLE.adding=!!opts.invite; goPage('podroz','trip'); }
// Jak podróż wyglądała w chwili zapisu: loty, dojazd na lotnisko, wybrany dojazd do centrum, cel i lotnisko docelowe.
function tripSnapshot(P, f, o, d){
  const p=P.dest?.points?.[0], pt=Array.isArray(p)?{lat:p[0], lon:p[1]}:p, t=XFER.get(f.to);
  const pick=P.xferPick, opt=pick&&pick!=='skip'?d?.options?.find(x=>x.id===pick):null;
  const r4=v=>Math.round(v*1e4)/1e4, ap=code=>{ const q=airportPoint(P,code)||(code===f.from&&f.airport?[f.airport.lat,f.airport.lon]:code===f.to&&t?[t.airportLat,t.airportLon]:null); return q&&q[0]!=null?[r4(q[0]),r4(q[1])]:null; };
  const stepsOf=list=>(list||[]).slice(0,14).map(s=>({icon:s.icon, text:s.text, sub:s.sub||'', ...(s.link?.href&&s.link.href.length<=300?{link:{href:s.link.href, label:s.link.label||'Mapy Google'}}:{})}));
  const home=P.origin?.points?.[0];
  const leg=x=>x?{from:x.from, to:x.to, fromLabel:x.fromLabel||x.from, toLabel:x.toLabel||x.to, day:x.day, arrDay:(x.arrival||'').slice(0,10)||x.day, fromPoint:ap(x.from), toPoint:ap(x.to), dep:clockOf(x.departure)||'', arr:arrivalOf(x)||'',
    airline:x.airline||'', airlineName:airlineOf(x).name, price:x.pricePln!=null?Math.round(x.pricePln):null, booking:x.bookingUrl&&x.bookingUrl.length<=300?x.bookingUrl:''}:null;
  const xfer=pick==='skip'?{skip:true}:opt?{name:opt.name||`${(XMODE[opt.kind]||XMODE.bus)[1]} ${opt.line}`.trim(), kind:opt.kind, line:opt.line||'', agency:opt.agency||'',
    lines:(opt.lines||[]).slice(0,6).map(l=>({kind:l.kind, line:l.line, color:l.color||'', textColor:l.textColor||''})), board:opt.board?.name||'', walkMin:opt.board?.walkMin||0, alight:opt.alight||'',
    minutes:opt.minutes??null, transfers:opt.transfers??null, fare:opt.fare?.text||'', pln:opt.fare?.pln??null, departures:(opt.departures||[]).slice(0,4), ticketUrl:opt.ticketUrl&&opt.ticketUrl.length<=300?opt.ticketUrl:'',
    timetable:opt.timetable!==false, km:opt.km??null, boardAt:opt.board?.at?[r4(opt.board.at[0]),r4(opt.board.at[1])]:null, steps:(opt.steps||[]).slice(0,8).map(s=>({kind:s.kind, line:s.line||'', from:s.from||'', to:s.to||'', dep:s.dep||'', arr:s.arr||'', minutes:s.minutes||0}))}:null;
  return {
    out:leg(f), ret:leg(f.ret), total:fareTotal(f)!=null?Math.round(fareTotal(f)):null,
    access:o?{title:o.title||'', mode:o.id||'', leave:o.leave||null, arrive:o.arrive||null, steps:stepsOf(o.steps), backSteps:stepsOf(o.back?.steps)}:null,
    dest:{label:P.to, lat:pt?.lat??null, lon:pt?.lon??null}, home:{label:P.from, lat:home?r4(home[0]):null, lon:home?r4(home[1]):null},
    airport:{code:f.to, city:t?.city||d?.city||'', zone:d?.zone||t?.zone||'', lat:t?.airportLat??d?.airport?.lat??null, lon:t?.airportLon??d?.airport?.lon??null},
    centre:d?.target?{label:d.target.label||'', lat:d.target.lat, lon:d.target.lon}:null,
    xfer, people:Math.max(1,P.people||1), costs:tripCosts(P,f), weather:planWeatherPoints(P,f), savedAt:new Date().toISOString(),
  };
}
function saveMyTrip(P, status, title){
  const C=flightChoice(P); if(!C?.out) return;
  const f={...C.out, ret:C.ret||null, returns:[]}, o=pickedAccess(P,f), d=airportOptions(P,f);
  if(!P.xferPick) return;
  const id=`f:${fareKey(f)}:${o?.id||''}`, before=FAV.items.find(x=>x.type==='trip' && x.id===id);
  const item={type:'trip', view:'podroz', id, tid:before?.tid||newTid(), status, from:P.from, to:P.to, title:(title ?? before?.title ?? '').trim().slice(0,80),
    name:o?`${o.title} · ${airlineOf(f).name}`:airlineOf(f).name, detail:f.ret?`${flightDetail(f)} · powrót ${fmtDay(f.ret.day)}`:flightDetail(f),
    flight:tripFlight(f), plan:{out:fareKey(f), ret:f.ret?fareKey(f.ret):'', access:o?.id||'', xfer:P.xferPick}, trip:{...tripSnapshot(P,f,o,d), ...stayForTrip('flight',P,{f,d},before)}};
  FAV.items=[...FAV.items.filter(x=>!(x.type==='trip' && x.id===id)), item].slice(-50);
  P.savedOk=null;
  saveFavorites().then(ok=>{ if(ok!==false && P.saved===item.tid){ P.savedOk=item.tid; runPlan(false); } }).catch(e=>console.warn('Nie zapisano podróży', e));
  P.saved=item.tid; renderFavorites(); syncStars(); runPlan(false); navCounts();
  S.editing=null; renderEditBadge();
  toast(status==='booked'?'Zapisano w „Moje podróże”.':'Zapisano plan w ulubionych.');
  finishSaved(item.tid);
}
// Moje podróże: oś czasu jak w ulubionych, bez cen do sprawdzania (bilety są już kupione).
document.getElementById('myTripsPage')?.addEventListener('click', e=>{
  const tab=e.target.closest('[data-mytrips-tab]'); if(tab){ if(MYT.tab!==tab.dataset.mytripsTab){ MYT.tab=tab.dataset.mytripsTab; goPage('podroz','moje'); } return; }
  const sh=e.target.closest('[data-trip-share]'); if(sh){ e.preventDefault(); e.stopPropagation(); openTrip(sh.dataset.tripShare, {invite:true}); return; }
  const to=e.target.closest('[data-trip-open]'); if(to){ e.preventDefault(); openTrip(to.dataset.tripOpen); }
});
/* ---------- 9a/9b: najbliższa podróż na górze „Moich podróży”, z działaniami zależnymi od etapu ----------
   przed wyjazdem: odliczanie, pogoda u celu (gdy jest prognoza), co jeszcze warto dodać; w dniu wyjazdu: przebieg
   podróży; w trakcie: dzień pobytu, miejsca w okolicy i opis miasta. Nic nie jest liczone poza tym, co już zapisano. */
function tripPhase(day, back, today=ymdOf(0)){
  if(!day) return {phase:'undated'};
  const diff=Math.round((Date.parse(day)-Date.parse(today))/864e5);
  if(diff>0) return {phase:'before', days:diff};
  if(diff===0) return {phase:'travel'};
  const end=back||day;
  if(today<=end) return {phase:'during', dayN:1-diff, of:Math.round((Date.parse(end)-Date.parse(day))/864e5)+1};
  return {phase:'after'};
}
function nextTripCard(all){
  const today=ymdOf(0);
  const dated=all.filter(f=>!tripIsPast(f)).map(f=>{ const fl=savedFlight(f)||groundDates(f); return {f, day:fl?.day||'', back:fl?.back||''}; }).filter(x=>x.day).sort((a,b)=>a.day.localeCompare(b.day));
  const x=dated[0]; if(!x) return '';
  const {f, day, back}=x, T=f.trip||{}, ph=tripPhase(day, back, today), tid=tidOf(f);
  const city=T.airport||T.ground||T.multi?tripCities(T,f)[0]:null, hotel=T.hotel?.name||'', points=T?allLocalItems(T).length:0;
  const when=ph.phase==='before'?(ph.days===1?L2('jutro','tomorrow'):L2(`za ${ph.days} dni`,`in ${ph.days} days`))
    :ph.phase==='travel'?L2('dziś wyjazd','leaving today'):ph.phase==='during'?L2(`dzień ${ph.dayN} z ${ph.of}`,`day ${ph.dayN} of ${ph.of}`):'';
  const btn=(sheet,icon,label,primary)=>`<button type="button" class="${primary?'btn-grad':'btn-ghost'}" data-next-open="${esc(tid)}" data-next-sheet="${esc(sheet)}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${label}</button>`;
  const acts=[];
  if(ph.phase==='travel') acts.push(btn('step:go','route',L2('Przebieg podróży','Journey'),true));
  if(ph.phase==='during'&&city) acts.push(btn('city','compass',L2('W okolicy','Nearby'),true));
  if(ph.phase!=='during') acts.push(btn('','suitcase-rolling',L2('Otwórz podróż','Open trip'),ph.phase!=='travel'));
  if(ph.phase==='before'&&!hotel&&!f.shared) acts.push(btn('hotel','bed',L2('Dodaj nocleg','Add a stay')));
  if(city&&ph.phase!=='during') acts.push(btn('city','map-location-dot',points?L2(`Plan zwiedzania (${points})`,`Sightseeing plan (${points})`):L2('Zaplanuj zwiedzanie','Plan sightseeing')));
  if(city&&ph.phase==='during') acts.push(`<button type="button" class="btn-ghost" data-next-about="${esc(tid)}"><i class="fa-solid fa-landmark" aria-hidden="true"></i> ${L2('O miejscu','About')}</button>`);
  const wx=city?.centre?wxChip([city.centre.lat, city.centre.lon], ph.phase==='during'?today:day):'';
  return `<section class="next-trip phase-${ph.phase}" aria-label="${L2('Najbliższa podróż','Next trip')}">
    <div class="nt-head"><small>${L2('Najbliższa podróż','Next trip')}</small>${when?`<span class="nt-when">${esc(when)}</span>`:''}</div>
    <h3>${f.title?esc(f.title):`${esc(f.from)} <span class="txt-red">→</span> ${esc(f.to)}`}</h3>
    <div class="nt-meta"><span><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${esc(longDay(day,{weekday:'short', day:'numeric', month:'short'}))}${back?` – ${esc(longDay(back,{weekday:'short', day:'numeric', month:'short'}))}`:''}</span>${hotel?`<span><i class="fa-solid fa-bed" aria-hidden="true"></i> ${esc(hotel)}</span>`:''}${wx?`<span class="nt-wx">${wx}</span>`:''}</div>
    <div class="nt-acts">${acts.join('')}</div></section>`;
}
document.getElementById('myTripsPage')?.addEventListener('click', e=>{
  const b=e.target.closest('[data-next-open]');
  if(b){ const sheet=b.dataset.nextSheet; openTrip(b.dataset.nextOpen); if(sheet) setTimeout(()=>openTripSheet(sheet),0); return; }
  const a=e.target.closest('[data-next-about]');
  if(a){ const f=findTrip(a.dataset.nextAbout), c=f?.trip?tripCities(f.trip,f)[0]:null; if(c?.centre) openAbout({name:c.label, lat:c.centre.lat, lon:c.centre.lon}); }
});
function renderMyTrips(){
  const page=document.getElementById('myTripsPage'); if(!page) return;
  const list=FAV.items.filter(f=>f.type==='trip' && f.status==='booked');
  const shared=SHARED.items.map(x=>({...x.trip, shared:{ownerId:x.ownerId, ownerName:x.ownerName}}));
  const all=[...list, ...shared], past=all.filter(tripIsPast), next=all.length-past.length;
  const archive=MYT.tab==='archive', calendar=MYT.tab==='calendar', upcomingTab=!archive&&!calendar;
  // Kalendarz jest zawsze dostępny (dni wolne można blokować jeszcze przed pierwszą podróżą).
  const tabs=`<div class="fav-filters mytrips-tabs" role="tablist" aria-label="Moje podróże">
    <button type="button" role="tab" class="fav-filter ${upcomingTab?'on':''}" data-mytrips-tab="upcoming" aria-selected="${upcomingTab}"><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> ${L2('Nadchodzące','Upcoming')} <small>${next}</small></button>
    ${all.length?`<button type="button" role="tab" class="fav-filter ${archive?'on':''}" data-mytrips-tab="archive" aria-selected="${archive}"><i class="fa-solid fa-box-archive" aria-hidden="true"></i> ${L2('Archiwum','Archive')} <small>${past.length}</small></button>`:''}
    <button type="button" role="tab" class="fav-filter ${calendar?'on':''}" data-mytrips-tab="calendar" aria-selected="${calendar}"><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${L2('Kalendarz','Calendar')}</button></div>`;
  let body;
  if(calendar) body=tripCalendarHtml();
  else if(!all.length) body=`<div class="empty-note">${stateIll(assetPaths.noTrips)}Nie masz jeszcze zapisanych podróży. Zaplanuj lot, a na ostatnim kroku „Z lotniska do centrum” kliknij „Zapisz moją podróż”. Plany, których nie jesteś pewien, zapisuj w ulubionych.</div>`;
  else if(archive) body=past.length?`<p class="mytrips-note">${L2('Podróże, które już się skończyły. Otwórz podróż, aby zobaczyć jej plan i dodać zdjęcia.','Trips that have already ended. Open a trip to see its plan and add photos.')}</p>${tripTimeline(past,{booked:true, only:'past'})}`
    :`<div class="empty-note">${L2('Archiwum jest puste. Podróże trafiają tu same, gdy minie dzień powrotu.','The archive is empty. Trips move here on their own once the return day has passed.')}</div>`;
  else body=next?nextTripCard(all)+tripTimeline(all,{booked:true, only:'upcoming'})
    :`<div class="empty-note">${stateIll(assetPaths.noTrips)}${L2('Nie masz nadchodzących podróży. Minione znajdziesz w zakładce „Archiwum”.','You have no upcoming trips. Past ones are in the “Archive” tab.')}</div>`;
  page.innerHTML=tabs+body;
}
/* ---------- Kalendarz podróży (assets/app.calendar.js): podróże, plany z ulubionych i zablokowane dni ----------
   Podróże i plany biorą daty z zapisanych ulubionych; zablokowane dni (wolne / zajęte) są na koncie, /api/calendar. */
const CAL={month:'', selected:'', form:null, blocks:[], loaded:false, loading:null};
function calTrips(){
  const mine=FAV.items.filter(f=>f.type==='trip').map(f=>({f, shared:false}));
  const shared=SHARED.items.map(x=>({f:{...x.trip, shared:{ownerId:x.ownerId, ownerName:x.ownerName}}, shared:true}));
  return [...mine, ...shared].map(({f, shared})=>{ const fl=savedFlight(f)||groundDates(f); if(!fl?.day) return null;
    return {key:shared?'':favKey(f), tid:tidOf(f), title:tripName(f), route:routeText(f), from:fl.day, to:fl.back||fl.day, status:shared?'booked':f.status==='booked'?'booked':'planned', shared}; }).filter(Boolean);
}
function loadCalendar(){
  if(!FAV.user || CAL.loaded || CAL.loading) return CAL.loading;
  CAL.loading=fetch('/api/calendar').then(r=>r.ok?r.json():null).then(x=>{ if(x){ CAL.blocks=x.blocks||[]; CAL.loaded=true; } })
    .catch(e=>console.warn('Nie wczytano kalendarza', e)).finally(()=>{ CAL.loading=null; if(S.sub==='moje'&&MYT.tab==='calendar') renderMyTrips(); });
  return CAL.loading;
}
async function saveCalendar(blocks){
  const before=CAL.blocks; CAL.blocks=blocks; renderMyTrips();
  try{
    const r=await fetch('/api/calendar',{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({blocks})});
    if(!r.ok) throw new Error('HTTP '+r.status);
    CAL.blocks=(await r.json()).blocks||[]; renderMyTrips(); return true;
  }catch(e){ console.warn('Nie zapisano kalendarza', e); CAL.blocks=before; renderMyTrips(); toast(L2('Nie udało się zapisać kalendarza. Spróbuj ponownie.','Could not save the calendar. Please try again.')); return false; }
}
function tripCalendarHtml(){
  const today=ymdOf(0);
  if(!CAL.month){ CAL.month=today.slice(0,7); CAL.selected=today; }
  if(FAV.user && !CAL.loaded) loadCalendar();
  if(CAL.form) CAL.form.conflicts=PVCAL.conflicts(CAL.form, calTrips(), CAL.blocks, L2);
  return PVCAL.render({state:CAL, trips:calTrips(), blocks:CAL.blocks, today, signedIn:!!FAV.user, loaded:CAL.loaded, t:L2});
}
const calFormValues=()=>({...CAL.form, from:document.getElementById('calFrom')?.value||CAL.form.from, to:document.getElementById('calTo')?.value||CAL.form.to,
  note:document.getElementById('calNote')?.value??CAL.form.note, kind:document.querySelector('#calForm input[name="calKind"]:checked')?.value||CAL.form.kind});
document.getElementById('myTripsPage')?.addEventListener('click', e=>{
  if(MYT.tab!=='calendar') return;
  const sh=e.target.closest('[data-cal-shift]'); if(sh){ CAL.month=PVCAL.shiftMonth(CAL.month, +sh.dataset.calShift); renderMyTrips(); return; }
  if(e.target.closest('[data-cal-today]')){ const d=ymdOf(0); CAL.month=d.slice(0,7); CAL.selected=d; renderMyTrips(); return; }
  const day=e.target.closest('[data-cal-day]');
  if(day){ const d=day.dataset.calDay; CAL.selected=d; if(d.slice(0,7)!==CAL.month) CAL.month=d.slice(0,7);
    if(CAL.form&&!CAL.form.id){ CAL.form={...calFormValues(), from:d, to:d}; } renderMyTrips(); document.querySelector(`[data-cal-day="${d}"]`)?.focus(); return; }
  if(e.target.closest('[data-cal-add]')){ CAL.form={from:CAL.selected, to:CAL.selected, kind:'off', note:''}; renderMyTrips(); document.getElementById('calNote')?.focus(); return; }
  if(e.target.closest('[data-cal-cancel]')){ CAL.form=null; renderMyTrips(); return; }
  const ed=e.target.closest('[data-cal-edit]');
  if(ed){ const b=CAL.blocks.find(x=>x.id===ed.dataset.calEdit); if(b){ CAL.form={id:b.id, from:b.from, to:b.to, kind:b.kind, note:b.note||''}; renderMyTrips(); document.getElementById('calNote')?.focus(); } return; }
  const rm=e.target.closest('[data-cal-remove]');
  if(rm){ const b=CAL.blocks.find(x=>x.id===rm.dataset.calRemove); if(!b) return;
    if(CAL.form?.id===b.id) CAL.form=null;
    saveCalendar(CAL.blocks.filter(x=>x.id!==b.id)).then(ok=>{ if(ok) toast(L2('Usunięto z kalendarza.','Removed from the calendar.')); }); }
});
document.getElementById('myTripsPage')?.addEventListener('change', e=>{
  if(MYT.tab!=='calendar' || !CAL.form || !e.target.closest('#calForm')) return;
  // Bez przerysowania formularza (kliknięte właśnie pole daty musi zostać): tylko najwcześniejszy dzień „Do” i nakładki.
  const v=calFormValues(), to=document.getElementById('calTo');
  if(to){ to.min=v.from; if(v.to<v.from){ v.to=v.from; to.value=v.from; } }
  v.conflicts=PVCAL.conflicts(v, calTrips(), CAL.blocks, L2);
  CAL.form=v;
  const box=document.getElementById('calConflict'); if(box) box.innerHTML=PVCAL.conflictHtml(v.conflicts, L2);
});
document.getElementById('myTripsPage')?.addEventListener('submit', e=>{
  if(e.target.id!=='calForm') return;
  e.preventDefault();
  const v=calFormValues(), DAYRE=/^\d{4}-\d{2}-\d{2}$/;
  if(!DAYRE.test(v.from)||!DAYRE.test(v.to)||v.to<v.from){ CAL.form={...v, error:L2('Wybierz pierwszy i ostatni dzień (ostatni nie może być wcześniej).','Pick the first and last day (the last one cannot be earlier).')}; renderMyTrips(); return; }
  if(PVCAL.addDays(v.from,366)<=v.to){ CAL.form={...v, error:L2('Najwyżej rok naraz.','A year at most.')}; renderMyTrips(); return; }
  const block={id:v.id||newTid(), from:v.from, to:v.to, kind:v.kind==='busy'?'busy':'off', note:(v.note||'').trim().slice(0,200)};
  const edited=!!v.id;
  CAL.form=null; CAL.selected=v.from; CAL.month=v.from.slice(0,7);
  saveCalendar([...CAL.blocks.filter(x=>x.id!==block.id), block]).then(ok=>{ if(ok) toast(edited?L2('Zapisano zmiany.','Changes saved.'):block.kind==='off'?L2('Dodano dni wolne.','Days off added.'):L2('Zablokowano dni.','Days blocked.')); });
});
const fmtTs=ts=>ts?`${fmtDay(dayOfTs(ts))} ${fmtClock(ts)}`:'';
/* ---------- Pogoda jako mała plakietka przy miejscu (start, lotniska, centrum) ---------- */
function wxChipHtml(w){
  if(!w || w.loading) return '<span class="spin sm" aria-hidden="true"></span>';
  const d=w.days?.[0];
  if(!d) return w.availableFrom?`<small>prognoza od ${fmtDay(w.availableFrom)}</small>`:'';
  const [desc,ico]=wmo(d.code);
  return `<span class="wx-ico" title="${esc(desc)}" aria-hidden="true">${ico}</span><b>${Math.round(d.max)}°</b><small>${Math.round(d.min)}°</small>${d.rainChance?`<small class="wtl-rain"><i class="fa-solid fa-droplet" aria-hidden="true"></i>${d.rainChance}%</small>`:''}`;
}
function wxChip(point, day){
  if(CFG.weather===false || !point || point[0]==null || !day) return '';
  const key=`${(+point[0]).toFixed(2)},${(+point[1]).toFixed(2)}|${day}|${day}`;
  if(!TWX.has(key)){
    TWX.set(key,{loading:true});
    fetch('/api/weather?'+new URLSearchParams({lat:point[0], lon:point[1], from:day, to:day})).then(r=>r.ok?r.json():null)
      .then(x=>{ TWX.set(key,x||{error:true}); document.querySelectorAll('[data-wx]').forEach(el=>{ if(el.dataset.wx===key) el.innerHTML=wxChipHtml(TWX.get(key)); }); })
      .catch(()=>TWX.set(key,{error:true}));
  }
  return `<span class="wx-chip" data-wx="${esc(key)}">${wxChipHtml(TWX.get(key))}</span>`;
}
const ptOf=x=>Array.isArray(x)&&x[0]!=null?x:x?.lat!=null?[x.lat,x.lon]:null;
// Rozwinięte „Kroki” zostają rozwinięte, gdy strona podróży się odświeża.
const TP_OPEN=new Set();
document.addEventListener('toggle', e=>{ const d=e.target; if(!d.classList?.contains('tp-more') || !d.dataset.k) return; if(d.open) TP_OPEN.add(d.dataset.k); else TP_OPEN.delete(d.dataset.k); }, true);
const more=(k,label,html)=>html?`<details class="tp-more" data-k="${esc(k)}"${TP_OPEN.has(k)?' open':''}><summary>${label}</summary>${html}</details>`:'';
const iconLink=(href,icon,title)=>href?`<a class="icon-btn" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}" aria-label="${esc(title)}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></a>`:'';
const iconMap=(key,title='Na mapie')=>`<button type="button" class="icon-btn" data-tp-map="${esc(key)}" title="${esc(title)}" aria-label="${esc(title)}"><i class="fa-solid fa-map" aria-hidden="true"></i></button>`;
function tripPoints(T){
  const pt=(icon,label,time,place,wx,cls='')=>`<div class="tp-point ${cls}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><small>${label}</small><b>${esc(time||'—')}</b><span>${esc(place||'')}</span>${wx||''}</div>`;
  const x=T.xfer, pts=[], centre=ptOf(T.centre)||ptOf(T.dest);
  if(T.access) pts.push(pt('house','Wyjście',fmtTs(T.access.leave),T.home?.label,wxChip(ptOf(T.home),T.access.leave?dayOfTs(T.access.leave):T.out?.day)));
  if(T.out){ pts.push(pt('plane-departure','Wylot',`${fmtDay(T.out.day)} ${T.out.dep}`,T.out.fromLabel,wxChip(T.out.fromPoint,T.out.day))); pts.push(pt('plane-arrival','Przylot',T.out.arr,T.out.toLabel,wxChip(T.out.toPoint||centre,T.out.arrDay||T.out.day))); }
  if(x) pts.push(x.skip?pt('car-side','Odbiór','z lotniska','ktoś odbiera','', 'soft'):pt((XMODE[x.kind]||XMODE.bus)[0],'Do centrum',x.minutes!=null?`ok. ${fmtDuration(x.minutes)}`:'',x.name,''));
  if(T.ret){ pts.push(pt('plane-departure','Powrót',`${fmtDay(T.ret.day)} ${T.ret.dep}`,T.ret.fromLabel,wxChip(T.ret.fromPoint||centre,T.ret.day))); pts.push(pt('plane-arrival','Lądowanie',T.ret.arr,T.ret.toLabel,wxChip(ptOf(T.home)||T.ret.toPoint,T.ret.arrDay||T.ret.day))); }
  return `<div class="tp-points">${pts.join('<i class="fa-solid fa-chevron-right ps-sep" aria-hidden="true"></i>')}</div>`;
}
function tripFlightDetails(T){
  const ap=(p,label,key,day)=>`<span class="tp-ap"><b>${esc(label)}</b>${wxChip(p,day)}<span class="tp-icons">${p?iconMap(key,'Lotnisko na mapie'):''}${iconLink(gPlace(p,label+' airport'),'diamond-turn-right','Lotnisko w Google Maps')}</span></span>`;
  const row=(x,label,key)=>x?`<div class="tp-fl"><div class="tp-fl-main"><span class="tp-flight-l">${label}</span><b>${esc(x.dep)} → ${esc(x.arr)}</b><small>${longDay(x.day,{weekday:'short', day:'numeric', month:'short'})} · ${esc(x.airlineName||x.airline)}${x.price!=null?` · ${x.price} zł/os.`:''}${x.booking?` · <a href="${esc(x.booking)}" target="_blank" rel="noopener">u przewoźnika</a>`:''}</small></div>
    <div class="tp-fl-aps">${ap(x.fromPoint,x.fromLabel,key+'-from',x.day)}<i class="fa-solid fa-arrow-right tp-arrow" aria-hidden="true"></i>${ap(x.toPoint,x.toLabel,key+'-to',x.arrDay||x.day)}</div></div>`:'';
  return row(T.out,'Wylot','out')+row(T.ret,'Powrót','ret');
}
function tripAccessDetails(T, f){
  const a=T.access; if(!a) return '<div class="empty-note">Bez zapisanego dojazdu.</div>';
  const home=ptOf(T.home), mode=a.mode==='car'?'driving':'transit';
  return `<div class="tp-line"><div><b>${esc((a.title||'').replace(/ \+ samolot$/,''))}</b><small>${a.leave?`wyjście ${fmtTs(a.leave)} · `:''}${esc(T.home?.label||f.from)} → ${esc(T.out?.fromLabel||'')}</small></div>
    <span class="tp-icons">${home&&T.out?.fromPoint?iconMap('access','Trasa na mapie'):''}${iconLink(gDir(home,T.out?.fromPoint,mode),'diamond-turn-right','Wskazówki dojazdu (Google Maps)')}</span></div>
    ${more('access-go',`<i class="fa-solid fa-list-ol" aria-hidden="true"></i> Kroki dojazdu (${a.steps?.length||0})`,a.steps?.length?stepsHtml(a.steps):'')}
    ${a.backSteps?.length?`<div class="tp-line"><div><b>Powrót do domu</b><small>${esc(T.ret?.toLabel||'')} → ${esc(T.home?.label||'')}</small></div><span class="tp-icons">${iconLink(gDir(T.ret?.toPoint,home,mode),'diamond-turn-right','Wskazówki powrotu (Google Maps)')}</span></div>${more('access-back',`<i class="fa-solid fa-list-ol" aria-hidden="true"></i> Kroki powrotu (${a.backSteps.length})`,stepsHtml(a.backSteps))}`:''}`;
}
function tripXferCard(T){
  const x=T.xfer, centre=ptOf(T.centre)||ptOf(T.dest), day=T.out?.arrDay||T.out?.day;
  if(!x) return '<div class="empty-note">Nie wybrano dojazdu z lotniska. Otwórz podróż w planerze, aby go wybrać.</div>';
  if(x.skip) return `<div class="tp-line"><div><b>Ktoś mnie odbierze</b><small>Bez dojazdu komunikacją z lotniska.</small></div>${wxChip(centre,day)}</div>`;
  const [ic,modeName]=XMODE[x.kind]||XMODE.bus, air=T.out?.toPoint||ptOf(T.airport), board=x.boardAt||null;
  return `<div class="tp-line"><div class="tp-x"><span class="cs-mode ${esc(x.kind)}"><i class="fa-solid fa-${ic}" aria-hidden="true"></i></span><div><b>${esc(x.name)}</b>
      <small>${[x.minutes!=null?`ok. ${fmtDuration(x.minutes)}`:'', x.transfers!=null&&x.kind!=='taxi'?(x.transfers?`${x.transfers} ${x.transfers===1?'przesiadka':'przesiadki'}`:'bez przesiadek'):'', x.pln!=null?`ok. ${x.pln} zł/os.`:''].filter(Boolean).join(' · ')}</small></div></div>
    <span class="tp-icons">${air&&centre?iconMap('xfer','Trasa na mapie'):''}${iconLink(board?gDir(air,board,'walking'):gPlace(null,`${x.board||x.name}, ${T.airport?.city||''}`),'person-walking','Jak dojść do odjazdu')}${iconLink(gDir(board||air,centre,x.kind==='taxi'?'driving':'transit'),'diamond-turn-right','Trasa do centrum (Google Maps)')}${x.ticketUrl?iconLink(x.ticketUrl,'ticket','Bilety'):''}</span></div>
    ${x.board?`<div class="tp-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> Odjazd: <b>${esc(x.board)}</b>${x.alight?` · wysiadasz: ${esc(x.alight)}`:''}${x.departures?.length?` · odjazdy ${x.departures.map(esc).join(', ')}`:x.timetable===false&&x.kind!=='taxi'?' · rozkład u przewoźnika':''}</div>`:''}
    <div class="tp-where">${wxChip(centre,day)} <small>${esc(T.centre?.label||T.dest?.label||'')} w dniu przylotu</small></div>
    ${x.fare?`<small class="text-soft">${esc(x.fare)}</small>`:''}
    ${more('xfer-steps',`<i class="fa-solid fa-list-ol" aria-hidden="true"></i> Trasa krok po kroku (${x.steps?.length||0})`,x.steps?.length?csSteps(x.steps):'')}`;
}
function tripXferLinks(){ return ''; }
function tripFlightRows(T){
  const row=(x,label)=>x?`<div class="tp-flight"><span class="tp-flight-l">${label}</span><b>${esc(x.from)} ${esc(x.dep)} → ${esc(x.to)} ${esc(x.arr)}</b><small>${longDay(x.day,{weekday:'short', day:'numeric', month:'long'})} · ${esc(x.airlineName||x.airline)}${x.price!=null?` · ${x.price} zł`:''}</small>${x.booking?`<a href="${esc(x.booking)}" target="_blank" rel="noopener">u przewoźnika <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`:''}</div>`:'';
  return row(T.out,'Wylot')+row(T.ret,'Powrót');
}
// Przebieg podróży jako klikalna oś: każdy punkt pokazuje pod spodem swoje szczegóły i miejsce na mapie.
const TRIP_STEPS=['go','out','arr','xfer','hotel','ret','home'];
const STEP_MAP={go:'access', out:'out-from', arr:'out-to', xfer:'xfer', hotel:'hotel', ret:'ret-from', home:'ret-to'};
function tripFlow(T){
  const x=T.xfer, centre=ptOf(T.centre)||ptOf(T.dest), cur=TRIPV.step||'go';
  const pt=(key,icon,label,time,place,wx,cls='')=>`<button type="button" class="tp-point ${cls} ${key===cur?'on':''}" data-tp-step="${key}" aria-pressed="${key===cur}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><small>${label}</small><b>${esc(time||'—')}</b><span>${esc(place||'')}</span>${wx||''}</button>`;
  const pts=[];
  if(T.access) pts.push(pt('go','house','Wyjście',fmtTs(T.access.leave),T.home?.label,wxChip(ptOf(T.home),T.access.leave?dayOfTs(T.access.leave):T.out?.day)));
  if(T.out){ pts.push(pt('out','plane-departure','Wylot',`${fmtDay(T.out.day)} ${T.out.dep}`,T.out.fromLabel,wxChip(T.out.fromPoint,T.out.day))); pts.push(pt('arr','plane-arrival','Przylot',T.out.arr,T.out.toLabel,wxChip(T.out.toPoint||centre,T.out.arrDay||T.out.day))); }
  if(x) pts.push(x.skip?pt('xfer','car-side','Odbiór','z lotniska','ktoś odbiera','','soft'):pt('xfer',(XMODE[x.kind]||XMODE.bus)[0],'Do centrum',x.minutes!=null?`ok. ${fmtDuration(x.minutes)}`:'',x.name,''));
  pts.push(T.hotel?pt('hotel','hotel','Nocleg',T.hotel.checkin?`${fmtDay(T.hotel.checkin)}–${fmtDay(T.hotel.checkout)}`:'hotel',T.hotel.name,''):pt('hotel','bed','Nocleg','dodaj hotel','szukaj lub wpisz','','soft'));
  if(T.ret){ pts.push(pt('ret','plane-departure','Powrót',`${fmtDay(T.ret.day)} ${T.ret.dep}`,T.ret.fromLabel,wxChip(T.ret.fromPoint||centre,T.ret.day))); pts.push(pt('home','plane-arrival','Lądowanie',T.ret.arr,T.ret.toLabel,wxChip(ptOf(T.home)||T.ret.toPoint,T.ret.arrDay||T.ret.day))); }
  return `<nav class="tp-flow" aria-label="Przebieg podróży">${pts.join('<span class="tp-conn" aria-hidden="true"></span>')}</nav>`;
}
function flightBox(x, label, key){
  const ap=(p,name,k,day)=>`<span class="tp-ap"><b>${esc(name)}</b>${wxChip(p,day)}<span class="tp-icons">${p?iconMap(k,'Lotnisko na mapie'):''}${iconLink(gPlace(p,name+' airport'),'diamond-turn-right','Lotnisko w Google Maps')}</span></span>`;
  return `<div class="tp-fl"><div class="tp-fl-main"><span class="tp-flight-l">${label}</span><b>${esc(x.dep)} → ${esc(x.arr)}</b><small>${longDay(x.day,{weekday:'short', day:'numeric', month:'short'})} · ${esc(x.airlineName||x.airline)}${x.price!=null?` · ${x.price} zł/os.`:''}${x.booking?` · <a href="${esc(x.booking)}" target="_blank" rel="noopener">u przewoźnika</a>`:''}</small></div>
    <div class="tp-fl-aps">${ap(x.fromPoint,x.fromLabel,key+'-from',x.day)}<i class="fa-solid fa-arrow-right tp-arrow" aria-hidden="true"></i>${ap(x.toPoint,x.toLabel,key+'-to',x.arrDay||x.day)}</div></div>`;
}
function tripStepPanel(T, f, price){
  const step=TRIPV.step||'go', home=ptOf(T.home), a=T.access, mode=a?.mode==='car'?'driving':'transit', centre=ptOf(T.centre)||ptOf(T.dest);
  const box=(icon,title,body)=>`<section class="tp-sec tp-panel"><h4><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${title}</h4><div class="tp-sec-body">${body}</div></section>`;
  if(step==='go') return box('route','Dojazd na lotnisko', a?`<div class="tp-line"><div><b>${esc((a.title||'').replace(/ \+ samolot$/,''))}</b><small>${a.leave?`wyjście ${fmtTs(a.leave)} · `:''}${esc(T.home?.label||f.from)} → ${esc(T.out?.fromLabel||'')}</small></div>
      <span class="tp-icons">${home&&T.out?.fromPoint?iconMap('access','Trasa na mapie'):''}${iconLink(gDir(home,T.out?.fromPoint,mode),'diamond-turn-right','Wskazówki dojazdu (Google Maps)')}</span></div>${a.steps?.length?stepsHtml(a.steps):''}`:'<div class="empty-note">Bez zapisanego dojazdu.</div>');
  if(step==='out' && T.out) return box('plane-departure','Wylot', flightBox(T.out,'Wylot','out')+price);
  if(step==='arr' && T.out) return box('plane-arrival',`Przylot: ${esc(T.out.toLabel)}`, `<div class="tp-line"><div><b>${esc(T.out.arr)} · ${longDay(T.out.arrDay||T.out.day,{weekday:'short', day:'numeric', month:'long'})}</b><small>${esc(T.out.toLabel)}</small></div><span class="tp-icons">${T.out.toPoint?iconMap('out-to','Lotnisko na mapie'):''}${iconLink(gPlace(T.out.toPoint,T.out.toLabel+' airport'),'diamond-turn-right','Lotnisko w Google Maps')}</span></div>
      <div class="tp-where">${wxChip(T.out.toPoint||centre,T.out.arrDay||T.out.day)} <small>pogoda w dniu przylotu</small></div>
      <div class="tp-where"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Dalej: ${T.xfer?.skip?'odbiór z lotniska':T.xfer?`${esc(T.xfer.name)}${T.xfer.board?` — odjazd: ${esc(T.xfer.board)}`:''}`:'wybierz dojazd do centrum w planerze'} <button type="button" class="btn-ghost tp-next" data-tp-step="xfer">Zobacz <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>`);
  if(step==='xfer') return box('map-location-dot',`Z lotniska ${esc(T.airport?.code||'')} do centrum`, tripXferCard(T));
  if(step==='hotel') return box('hotel','Nocleg', hotelSection(f,T));
  if(step==='ret' && T.ret) return box('plane-departure','Powrót', flightBox(T.ret,'Powrót','ret')+price);
  if(step==='home') return box('house','Powrót do domu', a?.backSteps?.length?`<div class="tp-line"><div><b>${esc(T.ret?.toLabel||'')} → ${esc(T.home?.label||'')}</b><small>po lądowaniu ${esc(T.ret?.arr||'')}</small></div><span class="tp-icons">${iconLink(gDir(T.ret?.toPoint,home,mode),'diamond-turn-right','Wskazówki powrotu (Google Maps)')}</span></div>${stepsHtml(a.backSteps)}`
    :`<div class="tp-line"><div><b>${esc(T.ret?.toLabel||'')} → ${esc(T.home?.label||'')}</b><small>tą samą drogą co na lotnisko</small></div><span class="tp-icons">${iconLink(gDir(T.ret?.toPoint,home,mode),'diamond-turn-right','Wskazówki powrotu (Google Maps)')}</span></div>`);
  return box('route','Dojazd na lotnisko','');
}
/* ---------- Udostępnione podróże i lokalizacja uczestników ----------
   Podróż udostępnia się zarejestrowanym znajomym (po adresie e-mail konta). Lokalizację każdy włącza sam, na swoim
   urządzeniu, tylko dla tej podróży i najdłużej do dnia po jej końcu; inni widzą ją na mapie podróży. */
const SHARED={items:[], mine:{}, ok:false, why:''};
const PEOPLE={key:'', data:null, locs:[], timer:null, layer:null, focus:'', open:false, adding:false};
async function loadShared(){
  if(!FAV.user) return;
  try{
    const [a,b]=await Promise.all([fetch('/api/trips/shared'), fetch('/api/trips/mine/shares')]);
    SHARED.ok=a.ok;
    if(a.ok){ SHARED.items=(await a.json()).trips||[]; SHARED.why=''; }
    else { const b=await a.json().catch(()=>({})); SHARED.why=a.status===404||b.code==='api-offline'?'no-api':(b.error||'error'); }
    if(b.ok) SHARED.mine=(await b.json()).shares||{};
  }catch(e){ console.warn('Udostępnione podróże', e); SHARED.why='offline'; }
  if(S.sub==='moje') renderMyTrips();
  if(S.sub==='trip') renderTripPage();
}
function sharedTrip(tid){ const x=SHARED.items.find(s=>s.trip?.tid===tid); return x?{...x.trip, shared:{ownerId:x.ownerId, ownerName:x.ownerName}}:null; }
const tripOwner=f=>f.shared?f.shared.ownerId:FAV.user?.id;
const tripApi=f=>`/api/trips/${encodeURIComponent(tripOwner(f))}/${encodeURIComponent(f.tid)}`;
const initials=name=>String(name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'?';
const PERSON_COLORS=['#2878D0','#20A995','#E8892B','#7B5BD6','#DC5555','#173B70'];
const personColor=id=>PERSON_COLORS[[...String(id)].reduce((s,c)=>s+c.charCodeAt(0),0)%PERSON_COLORS.length];

// Trasa podróży jako linia na mapie: dom → lotnisko → (łuk lotu) → lotnisko → odjazd do centrum → centrum.
function tripRoute(T){
  const P=x=>Array.isArray(x)&&x[0]!=null?x:x?.lat!=null?[x.lat,x.lon]:null;
  const home=P(T.home), dep=P(T.out?.fromPoint), arr=P(T.out?.toPoint)||P(T.airport), board=P(T.xfer?.boardAt), centre=P(T.centre)||P(T.dest);
  const pts=[];
  if(T.ground||T.multi) return [home, ...(T.stops||[]).map(P), centre].filter(Boolean);
  for(const p of [home, dep]) if(p) pts.push(p);
  if(dep&&arr) pts.push(...exploreArc(dep,arr,1).slice(1)); else if(arr) pts.push(arr);
  for(const p of [board, centre]) if(p) pts.push(p);
  return pts;
}
// Gdzie na trasie jest punkt: ile km od startu (wzdłuż trasy), ile do celu i jak daleko od samej trasy.
function routeProgress(route, p){
  if(route.length<2 || !p) return null;
  const km=(a,b)=>hav(a,b)/1000;
  let best=null, before=0;
  for(let i=0;i<route.length-1;i++){
    const a=route[i], b=route[i+1], len=km(a,b), lat0=Math.cos(a[0]*Math.PI/180);
    const ax=a[1]*lat0, ay=a[0], bx=b[1]*lat0, by=b[0], px=p[1]*lat0, py=p[0];
    const t=len?Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2||1))):0;
    const q=[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t], off=km(p,q);
    if(!best || off<best.off) best={off, along:before+len*t};
    before+=len;
  }
  return {along:best.along, off:best.off, total:before, left:Math.max(0,before-best.along)};
}
const agoText=iso=>{ const m=Math.max(0,Math.round((Date.now()-Date.parse(iso))/60000)); return m<1?L2('przed chwilą','just now'):m<60?L2(`${m} min temu`,`${m} min ago`):L2(`${Math.round(m/60)} godz. temu`,`${Math.round(m/60)} h ago`); };

async function loadPeople(f){
  const key=`${tripOwner(f)}|${f.tid}`;
  try{
    const [m,l]=await Promise.all([fetch(tripApi(f)+'/members'), fetch(tripApi(f)+'/locations')]);
    if(!m.ok){ PEOPLE.data=null; return; }
    PEOPLE.key=key; PEOPLE.data=await m.json(); PEOPLE.locs=l.ok?(await l.json()).locations:[];
  }catch(e){ console.warn('Uczestnicy podróży', e); }
}
function personLine(p, me, route){
  const loc=PEOPLE.locs.find(x=>x.userId===p.id);
  if(!loc) return p.me?L2('Nie udostępniasz lokalizacji','You are not sharing your location'):L2('Nie udostępnia lokalizacji','Not sharing location');
  if(loc.lat==null) return L2(`Udostępnia lokalizację · ostatnio ${loc.at?agoText(loc.at):'—'}`,`Sharing location · last ${loc.at?agoText(loc.at):'—'}`);
  const pr=route.length>1?routeProgress(route,[loc.lat,loc.lon]):null, mine=me&&me!==loc&&me.lat!=null?routeProgress(route,[me.lat,me.lon]):null;
  const parts=[agoText(loc.at)];
  if(pr) parts.push(pr.off>30?L2(`${fmtKm(pr.off)} od trasy`,`${fmtKm(pr.off)} off the route`):L2(`${fmtKm(pr.left)} do celu`,`${fmtKm(pr.left)} to go`));
  if(pr && mine && !p.me){ const d=pr.along-mine.along; if(Math.abs(d)>=1) parts.push(d>0?L2(`${fmtKm(d)} przed Tobą`,`${fmtKm(d)} ahead of you`):L2(`${fmtKm(-d)} za Tobą`,`${fmtKm(-d)} behind you`)); }
  return parts.join(' · ');
}
function sharingOffHtml(){
  const why=SHARED.why==='no-api'?L2('Serwer udostępniania (FastAPI) nie działa. Uruchom aplikację poleceniem „npm run dev:all” (Node i FastAPI razem) i kliknij „Udostępnij” ponownie.','The sharing server (FastAPI) is not running. Start the app with “npm run dev:all” (Node and FastAPI together) and click “Share” again.')
    :SHARED.why==='offline'?L2('Brak połączenia — udostępnianie wróci, gdy połączenie wróci.','No connection — sharing will be back when you are online.')
    :SHARED.why&&SHARED.why!=='error'?SHARED.why:L2('Udostępnianie jest chwilowo niedostępne.','Sharing is unavailable right now.');
  return `<section class="tp-people" id="tripPeople"><h4><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Uczestnicy podróży','Trip participants')}</h4><p class="tp-invite-msg err" role="status">${esc(why)}</p></section>`;
}
function peopleHtml(f, T){
  const d=PEOPLE.data, owner=d?.role==='owner';
  const head=`<h4 class="visually-hidden">${L2('Uczestnicy podróży','Trip participants')}</h4>`;
  if(!d) return `<section class="tp-people" id="tripPeople">${head}<p class="text-soft"><span class="spin sm" aria-hidden="true"></span> ${L2('Wczytuję…','Loading…')}</p></section>`;
  const end=T?.ret?.day||T?.ground?.back?.day||T?.out?.day||T?.ground?.out?.day||T?.legs?.at(-1)?.arrDay||'', past=!!end && end<ymdOf(-1);
  const route=T?tripRoute(T):[], meLoc=PEOPLE.locs.find(x=>x.me), seen=d.members.filter(p=>p.seesMyLocation).length;
  const rows=d.members.map(p=>`<li class="tp-person ${PEOPLE.focus===p.id?'focus':''}">
      <button type="button" class="tp-person-open" data-person="${esc(p.id)}" ${PEOPLE.locs.some(x=>x.userId===p.id&&x.lat!=null)?'':'disabled'} title="${L2('Pokaż na mapie','Show on the map')}">
        <span class="tp-avatar" style="background:${personColor(p.id)}">${esc(initials(p.name))}</span>
        <span class="tp-person-text"><b>${esc(p.name||'—')}${p.me?` <small>(${L2('Ty','you')})</small>`:''}${p.role==='owner'?` <small class="tp-owner">${L2('organizator','organiser')}</small>`:''}</b>
          <small>${p.me?esc(seen?L2(`Twoją lokalizację widzi: ${seen} ${seen===1?'osoba':'osoby'}`,`${seen} ${seen===1?'person sees':'people see'} your location`):L2('Nikt nie widzi Twojej lokalizacji','Nobody sees your location')):esc(personLine(p, meLoc, route))}${p.email?` · ${esc(p.email)}`:''}</small></span></button>
      ${owner&&p.role==='member'?inviteStatusChip(p):''}
      ${p.me||p.status&&p.status!=='accepted'?'':`<label class="tp-loc-to ${past?'disabled':''}" title="${L2('Czy ta osoba widzi Twoją lokalizację','Whether this person sees your location')}"><input type="checkbox" role="switch" data-loc-viewer="${esc(p.id)}" ${p.seesMyLocation?'checked':''} ${past?'disabled':''}><span>${L2('Widzi moją lokalizację','Sees my location')}</span></label>`}
      ${owner&&p.role!=='owner'?`<button type="button" class="tp-person-x" data-person-remove="${esc(p.id)}" data-person-name="${esc(p.name||'')}" title="${L2('Usuń z podróży','Remove from the trip')}" aria-label="${L2('Usuń z podróży','Remove from the trip')}: ${esc(p.name)}">×</button>`:''}
    </li>`).join('');
  return `<section class="tp-people" id="tripPeople">${head}
    <ul class="tp-people-list">${rows}</ul>
    ${owner&&d.members.length<2?`<p class="text-soft tp-people-none">${L2('Nikogo jeszcze nie dodano. Dodaj znajomego, który ma konto w aplikacji.','Nobody has been added yet. Add a friend who has an account in the app.')}</p>`:''}
    ${owner?`<form class="tp-invite" data-trip-invite><label class="tp-invite-label" for="tripInvite">${L2('Dodaj osobę','Add a person')}</label>
      <span class="tp-invite-field"><input id="tripInvite" type="text" required placeholder="${L2('Imię lub e-mail znajomego z kontem w aplikacji','Name or e-mail of a friend with an account')}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tripInviteList"><ul class="tp-suggest" id="tripInviteList" role="listbox" hidden></ul></span>
      <span class="tp-invite-btns"><button type="submit" class="btn-grad" data-with-location="1" ${past?'disabled':''}><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i> ${L2('Udostępnij z moją lokalizacją','Share with my location')}</button>
      <button type="submit" class="btn-ghost" data-with-location="0"><i class="fa-solid fa-user-plus" aria-hidden="true"></i> ${L2('Udostępnij bez lokalizacji','Share without location')}</button></span></form><p class="tp-invite-msg" role="status"></p>`:''}
    <p class="tp-loc-note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> ${past?L2('Podróż się skończyła — lokalizacji nie można już udostępniać.','The trip has ended — location can no longer be shared.'):L2('Każdy sam wybiera, komu pokazuje swoją lokalizację. Działa tylko w tej podróży, do dnia po jej końcu; wysyłamy ją co minutę, gdy aplikacja jest otwarta.','Everyone chooses who sees their own location. Only for this trip, until the day after it ends; sent every minute while the app is open.')}</p>
    ${!owner?`<div class="tp-people-foot"><button type="button" class="btn-ghost" data-trip-leave><i class="fa-solid fa-arrow-right-from-bracket" aria-hidden="true"></i> ${L2('Opuść podróż','Leave the trip')}</button></div>`:''}
  </section>`;
}
// Stan zaproszenia widziany przez organizatora: czeka, odrzucone, przyjęte (z lokalizacją albo bez).
function inviteStatusChip(p){
  if(p.status==='pending') return `<span class="tp-status-chip pending" title="${p.offersLocation?L2('Zaproszona z Twoją lokalizacją','Invited with your location'):L2('Zaproszona bez Twojej lokalizacji','Invited without your location')}"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${L2('Czeka na odpowiedź','Waiting for reply')}</span>`;
  if(p.status==='declined') return `<span class="tp-status-chip declined"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${L2('Odrzucone','Declined')}</span>`;
  return `<span class="tp-status-chip accepted"><i class="fa-solid fa-check" aria-hidden="true"></i> ${p.acceptedWithLocation?L2('Przyjęte · z lokalizacją','Accepted · with location'):L2('Przyjęte · bez lokalizacji','Accepted · without location')}</span>`;
}
/* ---------- Zaproszenia do podróży (dzwonek): przyjmij z lokalizacją, bez lokalizacji albo odrzuć;
   organizator dostaje odpowiedź z informacją, czy przyjęto z lokalizacją ---------- */
const INBOX={invites:[], responses:[], loaded:false, known:null};
const responseKey=r=>`${r.tid}|${r.memberId}|${r.at}`;
const inboxSeen=()=>store('onward.inboxSeen')||[];
function markResponsesSeen(){ store('onward.inboxSeen', [...new Set([...inboxSeen(), ...INBOX.responses.map(responseKey)])].slice(-200)); }
async function loadInbox(){
  if(!FAV.user) return;
  try{
    const r=await fetch('/api/trips/inbox'); if(!r.ok) return;
    const d=await r.json(), before=INBOX.known;
    INBOX.invites=d.invites||[]; INBOX.responses=d.responses||[]; INBOX.loaded=true;
    INBOX.known=new Set(INBOX.invites.map(i=>i.ownerId+'|'+i.tid));
    const fresh=before?INBOX.invites.filter(i=>!before.has(i.ownerId+'|'+i.tid)):[];
    if(fresh.length) toast(L2(`${fresh[0].ownerName} udostępnił(a) Ci podróż — zobacz w dzwonku.`,`${fresh[0].ownerName} shared a trip with you — see the bell.`));
    for(const a of INBOX.responses) startOfferedSending(a);
    renderAlertsBtn();
  }catch(e){ console.warn('Zaproszenia', e); }
}
// Organizator zaprosił „z moją lokalizacją”: po akceptacji to urządzenie zaczyna ją wysyłać (raz na odpowiedź).
async function startOfferedSending(a){
  if(a.status!=='accepted' || !a.offersLocation) return;
  const done=store('onward.offerSent')||[], key=responseKey(a); if(done.includes(key)) return;
  store('onward.offerSent', [...done, key].slice(-200));
  const f=FAV.items.find(x=>x.type==='trip' && x.tid===a.tid); if(!f) return;
  const s=await fetch(tripApi(f)+'/location-sharing',{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({viewerId:a.memberId, enabled:true})}).then(x=>x.ok?x.json():null).catch(()=>null);
  if(s) rememberSending(f, s);
}
function inboxHtml(){
  if(document.body.classList.contains('guest') || !INBOX.loaded || !(INBOX.invites.length||INBOX.responses.length)) return '';
  const seen=inboxSeen();
  const inv=INBOX.invites.map(i=>{
    const route=i.title||`${i.from} → ${i.to}`, key=esc(i.ownerId+'|'+i.tid);
    return `<article class="inbox-card invite">
      <span class="tp-avatar" style="background:${personColor(i.ownerId)}">${esc(initials(i.ownerName))}</span>
      <div class="inbox-text"><b>${esc(L2(`${i.ownerName} udostępnił(a) Ci podróż`,`${i.ownerName} shared a trip with you`))}</b>
        <span class="inbox-route">${esc(route)}${i.day?` · ${esc(fmtDay(i.day))}`:''}</span>
        ${i.offersLocation?`<small><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i> ${esc(L2(`${i.ownerName} pokaże Ci swoją lokalizację w czasie podróży.`,`${i.ownerName} will show you their location during the trip.`))}</small>`:''}
        <div class="inbox-btns">
          <button type="button" class="btn-grad" data-invite-answer="${key}" data-accept="1" data-loc="1"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i> ${L2('Przyjmij z moją lokalizacją','Accept with my location')}</button>
          <button type="button" class="btn-ghost" data-invite-answer="${key}" data-accept="1" data-loc="0"><i class="fa-solid fa-check" aria-hidden="true"></i> ${L2('Przyjmij bez lokalizacji','Accept without location')}</button>
          <button type="button" class="btn-ghost inbox-decline" data-invite-answer="${key}" data-accept="0"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${L2('Odrzuć','Decline')}</button>
        </div><p class="inbox-msg" role="status"></p></div></article>`;
  }).join('');
  const res=INBOX.responses.slice(0,8).map(a=>{
    const ok=a.status==='accepted', isNew=!seen.includes(responseKey(a));
    const what=ok?(a.withLocation?L2('przyjął(a) zaproszenie — z lokalizacją','accepted — with location'):L2('przyjął(a) zaproszenie — bez lokalizacji','accepted — without location')):L2('odrzucił(a) zaproszenie','declined');
    return `<article class="inbox-card ${ok?'accepted':'declined'} ${isNew?'new':''}">
      <span class="inbox-ico"><i class="fa-solid ${ok?'fa-check':'fa-xmark'}" aria-hidden="true"></i></span>
      <div class="inbox-text"><b>${esc(a.memberName)} ${what}</b><span class="inbox-route">${esc(a.title)} · ${esc(agoText(a.at))}</span></div>
      <button type="button" class="btn-ghost inbox-open" data-inbox-open="${esc(a.tid)}">${L2('Otwórz','Open')}</button></article>`;
  }).join('');
  return `<section class="inbox">${inv?`<h5 class="section-title mb-2"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Zaproszenia do podróży','Trip invitations')} <small>${INBOX.invites.length}</small></h5>${inv}`:''}
    ${res?`<h5 class="section-title mb-2 ${inv?'mt-3':''}"><i class="fa-solid fa-reply" aria-hidden="true"></i> ${L2('Odpowiedzi na Twoje zaproszenia','Answers to your invitations')}</h5>${res}`:''}</section>`;
}
async function answerInvite(btn){
  const [ownerId, tid]=btn.dataset.inviteAnswer.split('|'), accept=btn.dataset.accept==='1', withLocation=btn.dataset.loc==='1';
  const card=btn.closest('.inbox-card'), msg=card.querySelector('.inbox-msg'), btns=[...card.querySelectorAll('button')];
  msg.textContent=''; msg.className='inbox-msg';
  if(!accept && !(await askConfirm(L2('Odrzucić zaproszenie?','Decline the invitation?'), {detail:card.querySelector('.inbox-route')?.textContent||'', ok:L2('Odrzuć','Decline'), danger:true}))) return;
  if(withLocation && !(await locationAllowed())){ msg.textContent=L2('Bez zgody na lokalizację na tym urządzeniu możesz przyjąć zaproszenie tylko bez lokalizacji.','Without location permission on this device you can only accept without location.'); msg.className='inbox-msg err'; return; }
  btns.forEach(b=>b.disabled=true);
  try{
    const r=await fetch(`/api/trips/${encodeURIComponent(ownerId)}/${encodeURIComponent(tid)}/respond`,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({accept, withLocation})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ msg.textContent=body.error||L2('Nie udało się odpowiedzieć.','Could not answer.'); msg.className='inbox-msg err'; btns.forEach(b=>b.disabled=false); return; }
    if(body.sharing) rememberSending({shared:{ownerId}, tid}, body.sharing);
    INBOX.invites=INBOX.invites.filter(i=>!(i.ownerId===ownerId&&i.tid===tid));
    if(accept){ await loadShared(); toast(withLocation?L2('Przyjęto. Organizator widzi Twoją lokalizację w czasie tej podróży.','Accepted. The organiser sees your location during this trip.'):L2('Przyjęto zaproszenie. Podróż jest w „Moje podróże”.','Invitation accepted. The trip is in “My trips”.')); }
    else toast(L2('Odrzucono zaproszenie.','Invitation declined.'));
    fillAlerts(); renderAlertsBtn();
    if(accept){ alertsModal.hide(); openTrip(tid); }
  }catch(e){ msg.textContent=L2('Brak połączenia.','No connection.'); msg.className='inbox-msg err'; btns.forEach(b=>b.disabled=false); }
}
function drawPeople(T){
  const m=TRIPMAP.map; if(!m || !PEOPLE.data || !TRIPV.map) return;
  if(!PEOPLE.layer) PEOPLE.layer=L.layerGroup().addTo(m); else { PEOPLE.layer.clearLayers(); if(!m.hasLayer(PEOPLE.layer)) PEOPLE.layer.addTo(m); }
  const route=tripRoute(T);
  if(route.length>1) L.polyline(route,{color:'#173B70', weight:6, opacity:.18, interactive:false}).addTo(PEOPLE.layer);
  const meLoc=PEOPLE.locs.find(x=>x.me);
  for(const p of PEOPLE.data.members){
    const loc=PEOPLE.locs.find(x=>x.userId===p.id); if(!loc || loc.lat==null) continue;
    const mk=L.marker([loc.lat,loc.lon],{zIndexOffset:3000, icon:L.divIcon({className:'tp-person-pin', iconSize:[34,34], iconAnchor:[17,17],
      html:`<span style="background:${personColor(p.id)}">${esc(initials(p.name))}</span>`})})
      .bindPopup(`<b>${esc(p.name)}${p.me?' ('+L2('Ty','you')+')':''}</b><br><small>${esc(personLine(p, meLoc, route))}</small>`).addTo(PEOPLE.layer);
    if(loc.accuracy && loc.accuracy<5000) L.circle([loc.lat,loc.lon],{radius:loc.accuracy, color:personColor(p.id), weight:1, fillOpacity:.08, interactive:false}).addTo(PEOPLE.layer);
    if(PEOPLE.focus===p.id){ m.setView([loc.lat,loc.lon], Math.max(m.getZoom(),11)); mk.openPopup(); }
  }
}
async function refreshPeople(f, T){
  await loadPeople(f);
  const cur=findTrip(TRIPV.id); if(cur!==f && cur?.tid!==f.tid) return;
  const box=document.getElementById('tripPeople'); if(box && PEOPLE.open) box.outerHTML=peopleHtml(f, T);
  drawPeople(T);
  if(PEOPLE.invite){ PEOPLE.invite=false; openPeople(f); }
}
/* ---------- Okno „Uczestnicy podróży” na środku ekranu ---------- */
const PEOPLE_EL=document.getElementById('peopleModal');
let peopleModal=null;
async function openPeople(f){
  if(!f?.tid || !FAV.user) return;
  peopleModal=peopleModal||new bootstrap.Modal(PEOPLE_EL);
  PEOPLE.open=true;
  document.getElementById('peopleModalTrip').textContent=f.title||`${f.from} → ${f.to}`;
  const body=document.getElementById('peopleBody');
  body.innerHTML=SHARED.ok?peopleHtml(f, f.trip):sharingOffHtml();
  peopleModal.show();
  if(!SHARED.ok){ await loadShared(); body.innerHTML=SHARED.ok?peopleHtml(f, f.trip):sharingOffHtml(); }
  if(SHARED.ok){ await loadPeople(f); if(PEOPLE.open) body.innerHTML=peopleHtml(f, f.trip); }
}
PEOPLE_EL.addEventListener('shown.bs.modal', ()=>{ if(!matchMedia('(pointer:coarse)').matches) document.getElementById('tripInvite')?.focus(); });
PEOPLE_EL.addEventListener('hidden.bs.modal', ()=>{ PEOPLE.open=false; closeInviteList(); const f=findTrip(TRIPV.id); if(f?.trip) drawPeople(f.trip); });
function watchPeople(f, T){
  clearInterval(PEOPLE.timer);
  PEOPLE.focus=''; refreshPeople(f, T);
  PEOPLE.timer=setInterval(()=>{ if(S.sub!=='trip'){ clearInterval(PEOPLE.timer); return; } if(!document.hidden) refreshPeople(f, T); }, 60000);
}

/* Wysyłanie MOJEJ lokalizacji: tylko dla podróży, w których sam to włączyłem (lista w tej przeglądarce/aplikacji),
   co minutę, gdy aplikacja jest otwarta, i do końca udostępniania podanego przez serwer. */
const SENDING={timer:null};
const sharingList=()=>(store('onward.sharing')||[]).filter(x=>x && Date.parse(x.until)>Date.now());
function sendMyLocation(){
  const list=sharingList(); store('onward.sharing', list);
  if(!list.length || document.hidden || !navigator.geolocation || !FAV.user) return;
  navigator.geolocation.getCurrentPosition(pos=>{
    const body=JSON.stringify({lat:pos.coords.latitude, lon:pos.coords.longitude, accuracy:pos.coords.accuracy});
    for(const x of list) fetch(`/api/trips/${encodeURIComponent(x.owner)}/${encodeURIComponent(x.tid)}/location`,{method:'PUT', headers:{'Content-Type':'application/json'}, body})
      .then(r=>{ if(r.status===409||r.status===404) store('onward.sharing', sharingList().filter(y=>!(y.owner===x.owner&&y.tid===x.tid))); }).catch(()=>{});
  }, err=>console.warn('Lokalizacja', err.message), {enableHighAccuracy:true, timeout:20000, maximumAge:30000});
}
function startSending(){ clearInterval(SENDING.timer); if(!sharingList().length) return; sendMyLocation(); SENDING.timer=setInterval(sendMyLocation, 60000); }
// Lokalizacja tylko za zgodą urządzenia: bez niej nic nie wysyłamy.
async function locationAllowed(){
  if(!navigator.geolocation) return false;
  return new Promise(res=>navigator.geolocation.getCurrentPosition(()=>res(true), e=>res(e.code!==1), {timeout:20000}));
}
// Dla których podróży to urządzenie wysyła moje położenie (dopóki ktokolwiek może je widzieć).
function rememberSending(f, body){
  const others=sharingList().filter(x=>!(x.owner===tripOwner(f)&&x.tid===f.tid));
  store('onward.sharing', body?.sharing?[...others, {owner:tripOwner(f), tid:f.tid, until:body.until}]:others);
  if(body?.sharing) startSending(); else if(!others.length) clearInterval(SENDING.timer);
}
// Pokaż albo ukryj MOJĄ lokalizację jednej osobie z podróży.
async function setLocationViewer(f, viewerId, on, input){
  input.disabled=true;
  try{
    if(on && !(await locationAllowed())){ toast(L2('Bez zgody na lokalizację w przeglądarce lub telefonie nie możemy jej udostępniać.','Without location permission on this device it cannot be shared.')); input.checked=false; return; }
    const r=await fetch(tripApi(f)+'/location-sharing',{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({viewerId, enabled:on})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ toast(body.error||L2('Nie udało się zmienić udostępniania.','Could not change sharing.')); input.checked=!on; return; }
    rememberSending(f, body);
    const who=PEOPLE.data?.members.find(p=>p.id===viewerId)?.name||'';
    toast(on?L2(`${who} widzi teraz Twoją lokalizację.`,`${who} now sees your location.`):L2(`${who} nie widzi już Twojej lokalizacji.`,`${who} no longer sees your location.`));
    setTimeout(()=>refreshPeople(f, f.trip), on?1200:0);
  } finally { input.disabled=false; }
}
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) sendMyLocation(); });
function renderTripPage(){
  const page=document.getElementById('tripPage'); if(!page) return;
  const f=findTrip(TRIPV.id);
  if(!f){ page.innerHTML=`<div class="empty-note">Nie znaleźliśmy tej podróży. Zobacz <a href="/my-trips" data-go-mytrips>Moje podróże</a> albo <a href="/favourites#trips" data-fav-goto>ulubione</a>.</div>`; stopVehicles(); return; }
  const booked=f.status==='booked', T=f.trip||null, fl=savedFlight(f);
  setHeroTitle('Szczegóły podróży'); document.getElementById('heroLead').textContent=tripLead(f);
  const today=ymdOf(0), day=T?.out?.day||(T?.ground||T?.multi?groundDates(f)?.day:'')||fl?.day, back=T?.ret?.day||(T?.ground||T?.multi?groundDates(f)?.back:'')||fl?.back||'';
  const stay=day&&back?Math.round((Date.parse(back)-Date.parse(day))/86400000)+1:0;
  const when=!day?'':(back||day)<today?'minęła':day<=today?'trwa':`za ${Math.round((Date.parse(day)-Date.parse(today))/86400000)} dni`;
  const head=`<div class="tp-head">
    <div class="tp-title">${f.shared?`<span class="tp-status shared"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Udostępnił(a)','Shared by')}: ${esc(f.shared.ownerName)}</span> `:SHARED.mine[f.tid]?.length?`<span class="tp-status shared"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${L2('Udostępniona','Shared with')}: ${esc(SHARED.mine[f.tid].join(', '))}</span> `:''}<span class="tp-status ${booked?'booked':'planned'}">${booked?'<i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> Moja podróż':'<i class="fa-regular fa-bookmark" aria-hidden="true"></i> Plan w ulubionych'}</span>
      <h3>${f.title?esc(f.title):`${esc(f.from)} <span class="txt-red">→</span> ${esc(f.to)}`}</h3>${f.title||f.stops?.length?`<div class="tp-route">${(f.title?[f.from, ...(f.stops||[]), f.to]:f.stops).map(esc).join(' <span class="txt-red">→</span> ')}</div>`:''}
      <small>${day?`${longDay(day,{weekday:'short', day:'numeric', month:'long'})}${back?` – ${longDay(back,{weekday:'short', day:'numeric', month:'long', year:'numeric'})}`:''}`:''}${stay?` · ${stay} ${stay===1?'dzień':'dni'}`:''}${when?` · ${when}`:''}</small></div>
    <div class="tp-actions">
      ${booked||f.shared?'':'<button type="button" class="btn-grad" data-tp-book><i class="fa-solid fa-suitcase-rolling" aria-hidden="true"></i> Zapisz moją podróż</button>'}
      ${f.shared?'':'<button type="button" class="btn-ghost" data-tp-plan><i class="fa-solid fa-pen" aria-hidden="true"></i> Edytuj<span class="tp-long"> w planerze</span></button>'}
      ${f.tid&&FAV.user?`<span class="tp-share-wrap"><button type="button" class="btn-ghost ${PEOPLE.open?'on':''}" data-tp-share aria-expanded="${PEOPLE.open}" aria-controls="tripPeople"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${f.shared?L2('Uczestnicy','Participants'):L2('Udostępnij','Share')}</button></span>`:''}
      ${f.shared?'':'<button type="button" class="btn-ghost" data-tp-remove><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Usuń</button>'}
      <a class="tp-back" href="${booked?(when==='minęła'?'/my-trips#archive':'/my-trips'):'/favourites#trips'}" ${booked?`data-go-mytrips="${when==='minęła'?'archive':''}"`:'data-fav-goto'}><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${booked?(when==='minęła'?'Archiwum':'Moje podróże'):'Ulubione'}</a>
    </div></div>`+
    (booked&&when!=='minęła'?`<div class="tp-ready"><img src="${assetPaths.readyToGo}" alt="" aria-hidden="true" width="150" height="88" loading="lazy" decoding="async"><p>${T?.ground||T?.multi?'Przygotuj się do wyjazdu: sprawdź poniżej przebieg podróży i pogodę po drodze. Bilety kupisz u przewoźników.':'Przygotuj się do wyjazdu: sprawdź poniżej dojazd na lotnisko, lot i drogę do centrum. Bilety i rezerwacje potwierdzisz u przewoźników.'}</p></div>`
      :!booked?`<div class="tp-ready"><img src="${assetPaths.journeyPlanned}" alt="" aria-hidden="true" width="150" height="88" loading="lazy" decoding="async"><p>To plan zapisany w ulubionych. Sprawdź ceny i dojazdy, a gdy podróż będzie pewna, zapisz ją jako swoją.</p></div>`:'');
  if(!T){
    page.innerHTML=`<div class="tp">${head}<div class="tp-card"><h4><i class="fa-solid fa-plane" aria-hidden="true"></i> Lot</h4>${fl?`<div class="tp-flight"><b>${esc(fl.from)} → ${esc(fl.to)}</b><small>${longDay(fl.day,{weekday:'short', day:'numeric', month:'long'})}${fl.back?` – powrót ${longDay(fl.back,{day:'numeric', month:'long'})}`:''}${f.flight?.price?` · zapisano za ${f.flight.price} zł`:''}</small></div>`:''}
      <div class="empty-note">Ta podróż została zapisana, zanim strona podróży powstała. Otwórz ją w planerze i zapisz ponownie na ostatnim kroku, aby zobaczyć tu cały plan.</div></div></div>`;
    stopVehicles(); return;
  }
  if(T.ground||T.multi){
    // Tak jak przy samolocie: nocleg w miejscu docelowym i komunikacja w mieście — zmienia się tylko środek transportu.
    const dest=T.dest?.label||f.to;
    const flow=groundFlow(T);
    paintTripPage(page, f, T, head, flow, ()=>groundStepPanel(T,f), groundCosts(T), cityExploreBox(f,T), day, back);
    return;
  }
  const city=T.centre?.label||T.airport?.city||f.to, old=!T.access?.steps;
  const n=T.people||1;
  const price=booked?(T.total!=null?`<div class="tp-total">Loty razem: <b>${T.total*(T.people||1)} zł</b>${(T.people||1)>1?` <small>(${T.people} × ${T.total} zł)</small>`:''}</div>`:''):(fl?savedPriceHtml(favKey(f), fl, f.flight?.price):'');
  const note=old?'<div class="fl-mismatch" role="status"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> <span>Ta podróż została zapisana wcześniej, bez kroków dojazdu i miejsc na mapie. Otwórz ją w planerze („Edytuj w planerze”) i zapisz ponownie na ostatnim kroku, aby zobaczyć wszystkie szczegóły.</span></div>':'';
  paintTripPage(page, f, T, head, tripFlow(T)+note, ()=>tripStepPanel(T,f,price), tripCostsWithHotel(T), cityExploreBox(f,T), day, back);
}
/* ---------- Strona podróży: przebieg podróży (etapy) zostaje na stronie, a reszta jest pod przyciskami z ikonami.
   Etap i każdy przycisk otwierają okno ze szczegółami na środku ekranu (na telefonie na cały ekran), więc strona
   nie przewija się w dół ani nie skacze. Okno jest częścią strony podróży: gdy strona się odświeża (zapis hotelu,
   plan od AI), okno zostaje otwarte w tym samym miejscu. ---------- */
const TP_SHEETS={get cost(){ return ['wallet',L2('Koszt podróży','Trip cost')]; }, get photos(){ return ['images',L2('Zdjęcia z podróży','Trip photos')]; }, get hotel(){ return ['bed',L2('Nocleg','Accommodation')]; }, get map(){ return ['map',L2('Mapa podróży','Trip map')]; }, get city(){ return ['landmark',L2('Plan zwiedzania','Sightseeing plan')]; }};
function tripTools(f, T, costs, cityBox){
  const tool=(key,sub,extra='')=>{ const [icon,label]=TP_SHEETS[key], on=TRIPV.sheet===key||(key==='hotel'&&TRIPV.sheet==='step'&&TRIPV.step==='hotel');
    return `<button type="button" class="tp-tool ${on?'on':''}" data-tp-sheet="${key}" aria-haspopup="dialog"><span class="tp-tool-ic"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span><span class="tp-tool-tx"><b>${label}</b><small${extra}>${sub}</small></span></button>`; };
  const h=T.hotel, stays=(T.stopHotels||[]).length+(h?1:0), cities=tripCities(T,f), planned=allLocalItems(T).length;
  const out=[];
  if(costs?.rows?.length) out.push(tool('cost', `${costs.missing?'od ':'ok. '}${costs.total} zł${(costs.people||1)>1?` · ${peopleText(costs.people)}`:''}`));
  if(f.tid && !f.shared) out.push(tool('photos', L2('Dodaj i przeglądaj','Add and browse'), ' data-tp-photo-count'));
  out.push(tool('hotel', h?esc(h.name)+(stays>1?` +${stays-1}`:''):L2('Dodaj hotel','Add a stay')));
  out.push(tool('map', L2('Trasa i uczestnicy','Route and people')));
  // Alert cenowy widoczny od razu na stronie podróży (dotąd był tylko w oknie etapu „Lot”).
  const fl=savedFlight(f);
  if(fl && !f.shared && (fl.back||fl.day)>=ymdOf(0)){
    const set=ALERTS.list.find(x=>x.from===fl.from && x.to===fl.to && x.day===fl.day);
    out.push(`<button type="button" class="tp-tool ${set?'on':''}" data-fav-alert="${esc(favKey(f))}" aria-haspopup="dialog"><span class="tp-tool-ic"><i class="fa-solid fa-bell" aria-hidden="true"></i></span><span class="tp-tool-tx"><b>${L2('Alert cenowy','Price alert')}</b><small>${set?esc(L2(`do ${set.maxPrice} zł${set.reached?' · osiągnięta':''}`,`up to ${set.maxPrice} zł${set.reached?' · reached':''}`)):L2('Powiadom o niższej cenie','Tell me when it drops')}</small></span></button>`);
  }
  const about=tripCities(T,f)[0]; if(about?.centre) out.push(`<button type="button" class="tp-tool" data-tp-about aria-haspopup="dialog"><span class="tp-tool-ic"><i class="fa-solid fa-landmark" aria-hidden="true"></i></span><span class="tp-tool-tx"><b>${L2('O miejscu','About the place')}</b><small>${esc(String(about.label).split(',')[0])}</small></span></button>`);
  if(cityBox) out.push(tool('city', planned?`${planned} ${planned===1?'punkt':planned<5?'punkty':'punktów'}`:esc(cities.map(c=>c.label).slice(0,2).join(', '))||L2('Miejsca i dojazdy','Places and rides')));
  return `<nav class="tp-tools" aria-label="${L2('Szczegóły podróży','Trip details')}">${out.join('')}</nav>`;
}
function tripSheetBody(f, T, flow, stepPanel, costs, cityBox){
  const k=TRIPV.sheet;
  if(k==='step'){
    const keys=[...flow.matchAll(/data-tp-step="(\w+)"/g)].map(m=>m[1]).filter((x,i,a)=>a.indexOf(x)===i), i=keys.indexOf(TRIPV.step||'go');
    const lab=key=>(flow.match(new RegExp(`data-tp-step="${key}"[^>]*>(?:<i[^>]*></i>)?<small>([^<]*)</small>`))||[])[1]||'';
    const nav=keys.length>1?`<div class="tp-sheet-nav">${i>0?`<button type="button" class="btn-ghost" data-tp-step="${keys[i-1]}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${esc(lab(keys[i-1]))}</button>`:'<span></span>'}<small class="text-soft">${i+1} / ${keys.length}</small>${i>=0&&i<keys.length-1?`<button type="button" class="btn-ghost" data-tp-step="${keys[i+1]}">${esc(lab(keys[i+1]))} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`:'<span></span>'}</div>`:'';
    return stepPanel()+nav;
  }
  if(k==='cost') return costCard(costs);
  if(k==='photos') return '<section class="tp-photos" id="tripPhotos" aria-live="polite"></section>';
  if(k==='map') return `<section class="tp-map-box tp-map-sheet"><div class="tp-map-slot"></div><small class="text-soft">${L2('Kliknij etap podróży, a potem „Na mapie”, aby pokazać go na mapie.','Open a stage and press “On the map” to show it here.')}</small></section>`;
  if(k==='city') return cityBox;
  return '';
}
function paintTripPage(page, f, T, head, flow, stepPanel, costs, cityBox, day, back){
  if(TRIPV.sheet==='hotel'){ TRIPV.sheet='step'; TRIPV.step='hotel'; }
  if(TRIPV.sheet==='city' && !cityBox) TRIPV.sheet='';
  if(TRIPV.sheet==='photos' && !(f.tid && !f.shared)) TRIPV.sheet='';
  if(TRIPV.sheet==='cost' && !costs?.rows?.length) TRIPV.sheet='';
  TRIPV.map=TRIPV.sheet==='map';
  if(TRIPV.sheet!=='city') TRIPV.city=false;
  // Odświeżenie strony nie może jej przewinąć: zostaje to samo miejsce na stronie i w otwartym oknie.
  const y=window.scrollY, was=page.querySelector('.tp-sheet'), wasKey=was?.dataset.sheet, wasTop=page.querySelector('.tp-sheet-body')?.scrollTop||0;
  const key=TRIPV.sheet==='step'?'step:'+(TRIPV.step||'go'):TRIPV.sheet;
  const body=TRIPV.sheet?tripSheetBody(f,T,flow,stepPanel,costs,cityBox):'';
  const sheet=TRIPV.sheet?`<div class="tp-sheet-layer${was?' show':''}" data-tp-sheet-layer><div class="tp-sheet tp-sheet-${TRIPV.sheet}" data-sheet="${esc(key)}" data-pv-trap role="dialog" aria-modal="true" aria-label="${esc(TRIPV.sheet==='step'?L2('Etap podróży','Trip stage'):TP_SHEETS[TRIPV.sheet]?.[1]||'')}">
      <div class="tp-sheet-bar">${TRIPV.back?`<button type="button" class="btn-ghost tp-sheet-back" data-tp-sheet-back><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${L2('Wróć','Back')}</button>`:''}${TRIPV.sheet!=='step'&&TP_SHEETS[TRIPV.sheet]?`<h4><i class="fa-solid fa-${TP_SHEETS[TRIPV.sheet][0]}" aria-hidden="true"></i> ${TP_SHEETS[TRIPV.sheet][1]}</h4>`:'<span></span>'}<button type="button" class="tp-sheet-x" data-tp-sheet-close aria-label="${L2('Zamknij','Close')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
      <div class="tp-sheet-body">${body}</div></div></div>`:'';
  page.innerHTML=`<div class="tp">${head}${flow}${tripTools(f,T,costs,cityBox)}</div>${sheet}`;
  if(window.scrollY!==y) window.scrollTo(0,y);
  // Na telefonie przebieg podróży to poziomy pasek: przewijamy go do bieżącego kroku (bez przewijania strony).
  const strip=page.querySelector('.tp-flow'), cur=strip?.querySelector('.tp-point.on');
  if(strip && cur && strip.scrollWidth>strip.clientWidth) strip.scrollLeft=Math.max(0, cur.offsetLeft-strip.offsetLeft-(strip.clientWidth-cur.offsetWidth)/2);
  const layer=page.querySelector('[data-tp-sheet-layer]');
  if(layer){
    if(wasKey===key) layer.querySelector('.tp-sheet-body').scrollTop=wasTop;
    if(!was){ requestAnimationFrame(()=>layer.classList.add('show')); layer.querySelector('[data-tp-sheet-close]').focus({preventScroll:true}); }
  }
  // Wspólne zachowanie okien (app.ui.js): przycisk Wstecz zamyka okno, strona pod spodem się nie przewija, Tab zostaje w oknie.
  if(window.PVUI){ if(TRIPV.sheet && !TRIPV.closing) PVUI.layer.enter('trip', why=>closeTripSheet(why)); else if(!TRIPV.sheet) PVUI.layer.leave('trip'); }
  if(TRIPV.map){ mountTripMap(f,T); setTimeout(()=>TRIPMAP.map?.invalidateSize(), 220); }
  if(f.tid && FAV.user && SHARED.ok){ if(PEOPLE.key!==`${tripOwner(f)}|${f.tid}`) PEOPLE.data=null; watchPeople(f,T); } else clearInterval(PEOPLE.timer);
  if(f.tid && window.TripPhotos){
    const box=document.getElementById('tripPhotos'); if(box) window.TripPhotos.mount(box, f.tid);
    const cnt=page.querySelector('[data-tp-photo-count]');
    if(cnt && window.TripPhotos.count) window.TripPhotos.count(f.tid).then(n=>{ if(n && cnt.isConnected) cnt.textContent=`${n} ${n===1?'zdjęcie':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'zdjęcia':'zdjęć'}`; }).catch(()=>{});
  }
  mountTripCity(f,T,day,back);
}
function openTripSheet(key, back=''){
  TRIPV.back=back;
  if(key.startsWith('step:')){ TRIPV.sheet='step'; TRIPV.step=key.slice(5); } else TRIPV.sheet=key;
  renderTripPage();
}
function closeTripSheet(){
  if(!TRIPV.sheet) return;
  const layer=document.querySelector('#tripPage [data-tp-sheet-layer]');
  // TRIPV.closing: a render during the fade (live locations, photos) must not open a new history entry for the sheet
  const done=()=>{ TRIPV.sheet=''; TRIPV.back=''; TRIPV.map=false; TRIPV.closing=false; TRIPMAP.el?.remove(); renderTripPage(); };
  TRIPV.closing=true;
  if(layer){ layer.classList.remove('show'); setTimeout(done, 150); } else done();
}
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape' || !TRIPV.sheet || S.sub!=='trip' || document.querySelector('.ask-layer, .modal.show')) return;
  e.preventDefault(); closeTripSheet();
});
/* ---------- Plan zwiedzania: w każdym mieście docelowym podróży (w jedną stronę, w obie i w etapach)
   zapisane przejazdy po mieście — miejsce, wybrane połączenie komunikacją, godzina — dodawane po kolei. ---------- */
// Miasta podróży, w których można się poruszać: przy samolocie miasto przylotu, bez samolotu każdy przystanek i cel.
function tripCities(T, f){
  const pt=x=>x?.lat!=null?{lat:x.lat, lon:x.lon}:null, hotel=T.hotel?.lat!=null?{lat:T.hotel.lat, lon:T.hotel.lon, label:T.hotel.name}:null;
  if(T.airport && !T.ground && !T.multi){
    const centre=pt(T.centre)||pt(T.dest)||pt(T.airport); if(!centre || !T.airport.zone) return [];
    return [{label:T.centre?.label||T.airport.city||f.to, centre, zone:T.airport.zone, code:T.airport.code,
      home:hotel||(T.dest?.lat!=null&&T.centre&&T.dest.lat!==T.centre.lat?{lat:T.dest.lat, lon:T.dest.lon, label:T.dest.label}:null)}];
  }
  // Bez samolotu jedziemy po Polsce; miasto osiągnięte lotem w podróży w etapach ma strefę swojego lotniska.
  const zoneOf=label=>(T.legs||[]).find(L=>L.kind==='flight' && L.to===label)?.snap?.airport?.zone || 'Europe/Warsaw';
  const stops=(T.stops||[]).filter(x=>x.lat!=null).map(x=>({label:x.label, centre:pt(x), zone:zoneOf(x.label), home:null}));
  const dest=pt(T.dest)?[{label:T.dest.label||f.to, centre:pt(T.dest), zone:zoneOf(T.dest.label||f.to), home:hotel}]:[];
  return [...stops, ...dest];
}
const localKey=c=>c.label;
// Kolejność planu ustala podróżny (strzałki); „Sortuj wg godziny” przywraca kolejność czasową.
// Plan trzymamy jako listę {city, items}: nazwa miasta („Warszawa Centralna”, „Kraków”) jest wartością, nie nazwą pola,
// bo serwer zapisuje tylko proste nazwy pól. Starszy zapis (obiekt miasto → lista) dalej się wczytuje.
const LOCAL_MAX=20; // tyle punktów na miasto (limit długości list przy zapisie)
function localGroups(T){ const L=T?.local; return Array.isArray(L)?L.filter(x=>x?.city&&Array.isArray(x.items)):Object.entries(L||{}).filter(([,v])=>Array.isArray(v)).map(([city,items])=>({city, items})); }
function localItems(T, key){ return (localGroups(T).find(x=>x.city===key)?.items||[]).slice(); }
function allLocalItems(T){ return localGroups(T).flatMap(x=>x.items); }
function withLocal(trip, key, items){ const groups=localGroups(trip).filter(x=>x.city!==key); if(items.length) groups.push({city:key, items:items.slice(-LOCAL_MAX)}); return {...trip, local:groups}; }
function saveLocal(f, key, items){ f.trip=withLocal(f.trip, key, items); saveFavorites().catch(e=>console.warn('Nie zapisano planu zwiedzania', e)); renderTripPage(); }
function localKeyOf(T, id){ return localGroups(T).find(x=>x.items.some(y=>y.id===id))?.city; }
function localList(T, c){ return localItems(T, localKey(c)); }
function localItemHtml(x, canEdit, i=0, n=1){
  const move=canEdit&&n>1?`<span class="lp-move"><button type="button" class="btn-ghost" data-lp-move="${esc(x.id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="Przesuń wyżej" title="Przesuń wyżej"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" class="btn-ghost" data-lp-move="${esc(x.id)}" data-dir="1" ${i===n-1?'disabled':''} aria-label="Przesuń niżej" title="Przesuń niżej"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button></span>`:'';
  const rides=(x.steps||[]).filter(s=>s.kind!=='walk');
  return `<li class="lp-item"><div class="lp-main"><b>${esc(x.from)} <span class="txt-red">→</span> ${esc(x.to)}</b>
      <small>${x.day?longDay(x.day,{weekday:'short', day:'numeric', month:'short'})+' · ':''}${esc(x.dep)} → ${esc(x.arr)} · ${fmtDuration(x.minutes)}${x.transfers?` · ${x.transfers} ${x.transfers===1?'przesiadka':'przesiadki'}`:' · bez przesiadek'}${x.proxy?` · <span class="lp-proxy">wg rozkładu z ${esc(fmtDay(x.proxy))}</span>`:''}</small>
      <span class="cp-lines">${rides.length?rides.map(lineChip).join(''):'<span class="cs-chip walk"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> pieszo</span>'}</span>
      <details><summary>Szczegóły</summary>${csSteps(x.steps||[])}</details></div>
    <div class="lp-actions">${move}${linkBtn(x.a&&x.b?gDir(x.a,x.b,x.walk?'walking':'transit'):'','diamond-turn-right','Google Maps')}<button type="button" class="btn-ghost" data-lp-show="${esc(x.id)}"><i class="fa-solid fa-map" aria-hidden="true"></i> Na mapie</button>${canEdit?`<button type="button" class="btn-ghost" data-lp-remove="${esc(x.id)}" aria-label="Usuń z planu"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>`:''}</div></li>`;
}
// Sekcja „Komunikacja i plan zwiedzania” na stronie podróży: wybór miasta, zapisane przejazdy i planer po mieście.
function cityExploreBox(f, T){
  const cities=tripCities(T,f); if(!cities.length) return '';
  const at=Math.min(TRIPV.cityAt??cities.length-1, cities.length-1), c=cities[at], list=localList(T,c), edit=!f.shared;
  const tabs=cities.length>1?`<div class="lp-tabs" role="tablist">${cities.map((x,i)=>`<button type="button" role="tab" class="lp-tab ${i===at?'on':''}" aria-selected="${i===at}" data-lp-city="${i}">${esc(x.label)}${localItems(T,localKey(x)).length?` <small>${localItems(T,localKey(x)).length}</small>`:''}</button>`).join('')}</div>`:'';
  return `<section class="tp-city"><div class="tp-city-head"><div><h4><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> Plan zwiedzania: ${esc(c.label)}</h4><small>Wyszukaj miejsce, wybierz najlepsze połączenie i dodaj je do planu — potem kolejne.</small></div>
      <button type="button" class="${TRIPV.city?'btn-ghost':'btn-grad'}" data-tp-city aria-expanded="${!!TRIPV.city}"><i class="fa-solid fa-${TRIPV.city?'chevron-up':'magnifying-glass-location'}" aria-hidden="true"></i> ${TRIPV.city?'Ukryj wyszukiwanie':'Szukaj miejsc i połączeń'}</button></div>
    ${tabs}${nearBox(f,c)}${aiBox(f,c)}${list.length?`${edit&&list.length>1?`<div class="lp-tools"><button type="button" class="btn-ghost" data-lp-sort="${esc(localKey(c))}"><i class="fa-solid fa-clock" aria-hidden="true"></i> Sortuj wg godziny</button></div>`:''}<ol class="lp-list">${list.map((x,i)=>localItemHtml(x,edit,i,list.length)).join('')}</ol>`:'<div class="empty-note lp-empty">Plan jest pusty. Kliknij „Szukaj miejsc i połączeń”, znajdź trasę i dodaj ją przyciskiem „Dodaj do planu”.</div>'}
    ${TRIPV.city?'<div class="city-slot"></div>':''}</section>`;
}
/* ---------- Plan od AI: Claude proponuje miejsca do zwiedzania w mieście podróży, na podstawie preferencji podróżnego,
   jego innych podróży, dni pobytu i pogody. Każde miejsce ma przycisk „Dojazd”, który otwiera planer komunikacji. ---------- */
const AIP={enabled:null, plans:new Map(), busy:'', err:new Map(), style:null, form:false};
const AI_INTERESTS=[['museums','Muzea','building-columns'],['history','Historia','landmark'],['architecture','Architektura','archway'],['art','Sztuka','palette'],['food','Lokalna kuchnia','utensils'],['cafes','Kawiarnie','mug-hot'],['nightlife','Życie nocne','martini-glass'],['nature','Parki i natura','tree'],['views','Widoki','binoculars'],['shopping','Zakupy','bag-shopping'],['kids','Z dziećmi','child-reaching'],['sport','Ruch i sport','person-biking'],['religious','Zabytki sakralne','church'],['hidden','Mniej znane miejsca','compass']];
const AI_CAT={sight:'landmark', museum:'building-columns', food:'utensils', cafe:'mug-hot', park:'tree', view:'binoculars', shopping:'bag-shopping', nightlife:'martini-glass', activity:'person-hiking', other:'location-dot'};
const AI_PACE=[['relaxed','Spokojne'],['balanced','Umiarkowane'],['packed','Intensywne']], AI_BUDGET=[['low','Oszczędnie'],['medium','Średnio'],['high','Bez ograniczeń']], AI_WALK=[['little','Mało'],['some','Trochę'],['lots','Dużo']];
const aiKey=(f,c)=>`${f.tid}|${c.label}`;
async function aiInit(){
  if(AIP.enabled!==null || !FAV.user) return; AIP.enabled=false;
  try{ const r=await fetch('/api/ai/status'); AIP.enabled=r.ok && !!(await r.json()).enabled; }catch(e){ console.warn('Plan od AI', e); }
  if(AIP.enabled) renderTripPage();
}
async function aiLoad(f, c){
  const key=aiKey(f,c); if(AIP.plans.has(key)) return; AIP.plans.set(key, undefined);
  try{ const r=await fetch('/api/ai/city-plan?'+new URLSearchParams({tid:f.tid, city:c.label})); const plan=r.ok?(await r.json()).plan||null:null; AIP.plans.set(key, plan?{...plan, savedAt:offlineCopy(r)}:null); }
  catch(e){ AIP.plans.set(key, null); }
  if(findTrip(TRIPV.id)===f) renderTripPage();
}
async function aiLoadStyle(){
  if(AIP.style) return;
  try{ const r=await fetch('/api/ai/style'); if(r.ok) AIP.style=(await r.json()).style; }catch(e){ console.warn('Preferencje', e); }
  AIP.style ||= {interests:[], pace:'balanced', budget:'medium', walking:'some', notes:''};
  renderTripPage();
}
const aiOpts=(list, v)=>list.map(([k,l])=>`<option value="${k}" ${k===v?'selected':''}>${l}</option>`).join('');
function aiFormHtml(){
  const s=AIP.style; if(!s) return `<div class="ai-form">${searching('Wczytuję preferencje…')}</div>`;
  return `<form class="ai-form" data-ai-form>
    <fieldset class="ai-chips"><legend>Co lubisz zwiedzać?</legend>${AI_INTERESTS.map(([k,l,i])=>`<label class="ai-chip"><input type="checkbox" name="interests" value="${k}" ${s.interests.includes(k)?'checked':''}><span><i class="fa-solid fa-${i}" aria-hidden="true"></i> ${l}</span></label>`).join('')}</fieldset>
    <div class="ai-selects"><label>Tempo<select name="pace">${aiOpts(AI_PACE,s.pace)}</select></label><label>Budżet<select name="budget">${aiOpts(AI_BUDGET,s.budget)}</select></label><label>Chodzenie pieszo<select name="walking">${aiOpts(AI_WALK,s.walking)}</select></label></div>
    <label class="ai-notes">O mnie <small>(zapamiętamy na kolejne podróże)</small><textarea name="notes" rows="2" maxlength="400" placeholder="np. jestem wegetarianinem, nie lubię tłumów, podróżuję z psem">${esc(s.notes||'')}</textarea></label>
    <label class="ai-notes">Życzenie na tę podróż <small>(tylko ten plan)</small><input name="note" maxlength="300" placeholder="np. jeden dzień na plażę, wieczór z widokiem na miasto"></label>
  </form>`;
}
function aiReadForm(box){
  const form=box?.querySelector('[data-ai-form]'); if(!form) return {};
  const style={interests:[...form.querySelectorAll('input[name=interests]:checked')].map(x=>x.value), pace:form.pace.value, budget:form.budget.value, walking:form.walking.value, notes:form.notes.value.trim()};
  AIP.style=style; return {style, note:form.note.value.trim()};
}
// 8b: ostrzeżenia z serwera: punkt nachodzi na następny albo wypada poza godzinami otwarcia z OSM.
function aiConflicts(d, si){
  const list=(d.conflicts||[]).filter(c=>c.index===si); if(!list.length) return '';
  return list.map(c=>`<small class="ai-warn" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${
    c.kind==='overlap'?L2(`Nachodzi na następny punkt o ${c.minutes} min`,`Runs into the next stop by ${c.minutes} min`)
    :c.kind==='closed'?L2('W ten dzień zamknięte (według OSM)','Closed on this day (according to OSM)')
    :L2('Poza godzinami otwarcia (według OSM)','Outside opening hours (according to OSM)')}</small>`).join('');
}
// Odpowiedź z zapisanej kopii (service worker bez połączenia): kiedy ją zapisano, żeby nie udawała świeżych danych.
function offlineCopy(r){ const at=r.headers.get('X-Podavo-Saved-At'); return at && (navigator.onLine===false || document.body.classList.contains('offline')) ? at : ''; }
function savedNote(at){
  if(!at) return '';
  const d=new Date(at); if(isNaN(d)) return '';
  const when=d.toLocaleString(isEn()?'en-GB':'pl-PL',{day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
  return `<p class="saved-copy"><i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i> ${esc(L2(`Bez połączenia: zapisana kopia z ${when}.`,`Offline: saved copy from ${when}.`))}</p>`;
}
function aiPlanHtml(p){
  const days=p.days.map((d,di)=>`<div class="ai-day"><h5>${esc(longDay(d.day,{weekday:'long', day:'numeric', month:'long'}))}${d.theme?` · <span>${esc(d.theme)}</span>`:''}</h5>${d.weatherNote?`<small class="ai-wx"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> ${esc(d.weatherNote)}</small>`:''}
    ${d.stops.filter(s=>s.lat!=null).length>=3?`<div class="ai-fit-row">${d.fitted?`<small class="ai-fit-note"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${L2(`Kolejność ułożona: ok. ${String(d.walkKm).replace('.',',')} km pieszo (szacunek z odległości)`,`Order fitted: about ${d.walkKm} km on foot (estimated from distance)`)}</small>`:''}<button type="button" class="btn-ghost ai-fit" data-ai-fit="${di}" ${AIP.fitting===d.day?'disabled':''}><i class="fa-solid fa-shuffle" aria-hidden="true"></i> ${AIP.fitting===d.day?L2('Układam…','Fitting…'):d.fitted?L2('Ułóż ponownie','Fit again'):L2('Ułóż trasę dnia','Fit the day’s route')}</button></div>`:''}
    <ol class="ai-stops">${d.stops.map((s,si)=>`<li class="ai-stop${(d.conflicts||[]).some(c=>c.index===si)?' warn':''}">${aiConflicts(d,si)}${s.walkMin?`<small class="ai-walk"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${L2(`ok. ${s.walkMin} min pieszo`,`about ${s.walkMin} min walk`)}</small>`:''}<span class="ai-time">${esc(s.time||'')}</span><i class="fa-solid fa-${AI_CAT[s.category]||'location-dot'} ai-cat" aria-hidden="true"></i>
      <div class="ai-stop-main"><b>${esc(s.name)}</b><small>${[s.minutes?`ok. ${fmtDuration(s.minutes)}`:'', s.priceNote, s.openingHours].filter(Boolean).map(esc).join(' · ')}</small>${s.why?`<p>${esc(s.why)}</p>`:''}${s.tip?`<p class="ai-tip"><i class="fa-regular fa-lightbulb" aria-hidden="true"></i> ${esc(s.tip)}</p>`:''}</div>
      <div class="ai-stop-actions"><button type="button" class="btn-ghost" data-ai-route="${di}:${si}"><i class="fa-solid fa-route" aria-hidden="true"></i> Dojazd</button>${linkBtn(s.lat!=null?`https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name+', '+p.city)}`,'map-location-dot','Mapa')}</div></li>`).join('')}</ol></div>`).join('');
  return `${savedNote(p.savedAt)}${p.summary?`<p class="ai-sum">${esc(p.summary)}</p>`:''}${days}${p.tips?.length?`<ul class="ai-tips">${p.tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}${p.source==='osm'?`<small class="cs-src ai-src">${L2('Miejsca wybrane z katalogu OpenStreetMap (© OpenStreetMap contributors, ODbL); godziny otwarcia według OSM.','Places chosen from the OpenStreetMap catalogue (© OpenStreetMap contributors, ODbL); opening hours as in OSM.')}</small>`:p.source==='model'?`<small class="cs-src ai-src">${L2('Nie mamy jeszcze katalogu miejsc dla tej okolicy: sprawdź nazwy i godziny przed wyjściem.','No place catalogue for this area yet: check names and hours before you go.')}</small>`:''}
    <small class="ai-foot">Zaproponowane przez AI${p.createdAt?` ${esc(new Date(p.createdAt).toLocaleDateString('pl-PL',{day:'numeric', month:'long'}))}`:''}. Godziny otwarcia i ceny sprawdź przed wyjściem.</small>`;
}
/* ---------- W okolicy (7b): miejsca z OpenStreetMap wokół noclegu (albo centrum miasta), z dojazdem jednym kliknięciem ---------- */
const NEAR_RADII=[1000,2000,3000,5000];
const NEAR={data:new Map(), busy:new Set(), err:new Map(), cat:'', limit:12, open:store('podavo.near.open')!==false, radius:NEAR_RADII.includes(+store('podavo.near.radius'))?+store('podavo.near.radius'):2000};
const nearPoint=c=>c.home?.lat!=null?{lat:c.home.lat, lon:c.home.lon, label:c.home.label||L2('Nocleg','Stay')}:{lat:c.centre.lat, lon:c.centre.lon, label:c.label};
const nearKey=c=>{ const p=nearPoint(c); return `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}|${NEAR.radius}|${isEn()?'en':'pl'}`; };
async function loadNear(c){
  const key=nearKey(c), p=nearPoint(c); if(NEAR.busy.has(key)) return;
  NEAR.busy.add(key); NEAR.err.delete(key);
  try{
    const r=await fetch('/api/places/nearby?'+new URLSearchParams({lat:(+p.lat).toFixed(4), lon:(+p.lon).toFixed(4), radius:String(NEAR.radius), lang:isEn()?'en':'pl'}));
    const body=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(body.error||'');
    NEAR.data.set(key, {...body, savedAt:offlineCopy(r)});
  }catch(e){ NEAR.err.set(key, e.message||L2('Miejsca w okolicy są chwilowo niedostępne.','Places nearby are unavailable right now.')); }
  finally{ NEAR.busy.delete(key); if(TRIPV.sheet==='city') renderTripPage(); }
}
function nearBox(f, c){
  if(!c?.centre) return '';
  const key=nearKey(c), d=NEAR.data.get(key), err=NEAR.err.get(key), from=nearPoint(c);
  if(NEAR.open && !d && !err && !NEAR.busy.has(key)) setTimeout(()=>loadNear(c),0);
  const body=!NEAR.open?'':err?`<div class="empty-note">${esc(err)} <button type="button" class="btn-ghost" data-near-retry>${L2('Spróbuj ponownie','Try again')}</button></div>`
    :!d?`<div class="empty-note">${L2('Szukam miejsc w okolicy…','Looking for places nearby…')}</div>`:savedNote(d.savedAt)+PVD.nearList(d,{t:L2, cat:NEAR.cat, limit:NEAR.limit});
  const range=`<label class="near-range"><span class="visually-hidden">${L2('Promień wyszukiwania','Search radius')}</span><i class="fa-solid fa-bullseye" aria-hidden="true"></i><select data-near-radius aria-label="${L2('Promień wyszukiwania','Search radius')}">${NEAR_RADII.map(r=>`<option value="${r}" ${r===NEAR.radius?'selected':''}>${r/1000} km</option>`).join('')}</select></label>`;
  return `<section class="near-box" aria-label="${L2('W okolicy','Nearby')}"><div class="near-head"><h5><i class="fa-solid fa-compass" aria-hidden="true"></i> ${L2('W okolicy','Nearby')} <small>${esc(from.label)}</small></h5>
    <div class="near-tools">${range}<button type="button" class="near-toggle" data-near-toggle aria-expanded="${NEAR.open}" aria-label="${NEAR.open?L2('Zwiń','Hide'):L2('Rozwiń','Show')}" title="${NEAR.open?L2('Zwiń','Hide'):L2('Rozwiń','Show')}"><i class="fa-solid fa-chevron-${NEAR.open?'up':'down'}" aria-hidden="true"></i></button></div></div>${body}</section>`;
}
function nearRoute(f, c, id){
  const p=NEAR.data.get(nearKey(c))?.places?.find(x=>x.id===id); if(!p) return;
  const from=nearPoint(c);
  if(!TRIPV.city){ TRIPV.city=true; renderTripPage(); }
  const form=CITY.el?.querySelector('.cp-form'); if(!form) return;
  setEnd('from', [from.lat,from.lon], from.label, true);
  setEnd('to', [p.lat,p.lon], p.name);
  CITY.el.scrollIntoView({behavior:'smooth', block:'start'});
}

function aiBox(f, c){
  if(!f.tid || f.shared || !FAV.user){ return ''; }
  if(AIP.enabled===null){ aiInit(); return ''; }
  if(!AIP.enabled) return '';
  const key=aiKey(f,c); if(!AIP.plans.has(key)) aiLoad(f,c);
  const p=AIP.plans.get(key), busy=AIP.busy===key, err=AIP.err.get(key);
  return `<div class="ai-box" aria-live="polite"><div class="ai-head"><div><h4><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Plan od AI: ${esc(c.label)}</h4><small>Miejsca dobrane do Twoich preferencji, poprzednich podróży, dni pobytu i pogody.</small></div>
      <div class="ai-actions"><button type="button" class="btn-ghost ${AIP.form?'on':''}" data-ai-style aria-expanded="${AIP.form}"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Preferencje</button>
      <button type="button" class="btn-grad" data-ai-go ${busy?'disabled':''}><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${p?'Zaproponuj od nowa':'Zaproponuj plan'}</button></div></div>
    ${AIP.form?aiFormHtml():''}
    ${busy?searching('Przygotowuję plan… zwykle trwa to do minuty.'):''}
    ${err?`<div class="empty-note ai-err" role="alert">${esc(err)}</div>`:''}
    ${p&&!busy?aiPlanHtml(p):!busy&&p===null&&!err?'<div class="empty-note">Kliknij „Zaproponuj plan”. Najpierw możesz ustawić swoje preferencje.</div>':''}</div>`;
}
// 8a: kolejność postojów dnia, która najmniej chodzi od noclegu; serwer zapisuje ją w planie i przelicza godziny.
async function aiFit(f, c, di){
  const key=aiKey(f,c), p=AIP.plans.get(key), d=p?.days?.[di]; if(!d || AIP.fitting) return;
  if(f.shared){ toast(L2('Kolejność może zmienić tylko właściciel podróży.','Only the trip owner can change the order.')); return; }
  AIP.fitting=d.day; renderTripPage();
  try{
    const start=c.home?.lat!=null?{lat:c.home.lat, lon:c.home.lon}:c.centre;
    const r=await fetch('/api/ai/city-plan-fit',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tid:f.tid, city:c.label, day:d.day, start})});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(body.error||'');
    AIP.plans.set(key, body.plan);
    toast(body.savedKm>0.1?L2(`Ułożono trasę: o ok. ${String(body.savedKm).replace('.',',')} km mniej pieszo.`,`Route fitted: about ${body.savedKm} km less walking.`):L2('Ta kolejność była już najkrótsza; godziny przeliczone.','This order was already the shortest; times recalculated.'));
  }catch(e){ toast(e.message||L2('Nie udało się ułożyć trasy.','Could not fit the route.')); }
  finally{ AIP.fitting=''; if(findTrip(TRIPV.id)===f) renderTripPage(); }
}
async function aiGenerate(f, c){
  const key=aiKey(f,c); if(AIP.busy) return;
  const box=document.querySelector('#tripPage .ai-box'), extra=aiReadForm(box);
  const T=f.trip, back=T?.ret?.day||(T?.ground||T?.multi?groundDates(f)?.back:'')||savedFlight(f)?.back||'';
  const day=T?.out?.day||(T?.ground||T?.multi?groundDates(f)?.day:'')||savedFlight(f)?.day||'';
  AIP.busy=key; AIP.err.delete(key); renderTripPage();
  try{
    const r=await fetch('/api/ai/city-plan',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tid:f.tid, city:c.label, local:localKey(c), centre:c.centre, home:c.home?{lat:c.home.lat, lon:c.home.lon}:null, homeLabel:c.home?.label||'', day, back, ...extra})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) AIP.err.set(key, d.error||'Plan od AI jest chwilowo niedostępny.');
    else { AIP.plans.set(key, d.plan); AIP.form=false; }
  }catch(e){ AIP.err.set(key, L2('Brak połączenia.','No connection.')); }
  finally{ AIP.busy=''; if(findTrip(TRIPV.id)===f) renderTripPage(); }
}
// „Dojazd”: z poprzedniego miejsca dnia (albo z noclegu / centrum) do wybranego, pół godziny przed proponowaną godziną.
function aiRoute(f, c, di, si){
  const p=AIP.plans.get(aiKey(f,c)), d=p?.days?.[di], s=d?.stops?.[si]; if(!s) return;
  const prev=si>0?d.stops[si-1]:null;
  const from=prev&&prev.lat!=null?{at:[prev.lat,prev.lon], label:prev.name}:c.home?{at:[c.home.lat,c.home.lon], label:c.home.label||'Nocleg'}:{at:[c.centre.lat,c.centre.lon], label:c.label};
  if(!TRIPV.city){ TRIPV.city=true; renderTripPage(); }
  const form=CITY.el?.querySelector('.cp-form'); if(!form) return;
  if(s.time){ const [h,m]=s.time.split(':').map(Number), x=Math.max(0,h*60+m-30); form.when.value=`${d.day}T${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`; }
  setEnd('from', from.at, from.label, true);
  if(s.lat!=null) setEnd('to', [s.lat,s.lon], s.name);
  else { CITY.ends.to=null; form.to.value=`${s.name}, ${c.label}`; drawEnds(); cityPlan(); }
  CITY.el.scrollIntoView({behavior:'smooth', block:'start'});
}
function aiCity(f){ const cities=tripCities(f.trip,f); return cities[Math.min(TRIPV.cityAt??cities.length-1, cities.length-1)]; }
function mountTripCity(f, T, day, back){
  const cities=tripCities(T,f);
  if(!TRIPV.city || !cities.length){ stopVehicles(); return; }
  const c=cities[Math.min(TRIPV.cityAt??cities.length-1, cities.length-1)];
  CITY.want={code:`${c.code||'city'}:${tidOf(f)}:${c.label}`, tid:tidOf(f), city:c.label, local:localKey(c), canSave:!f.shared, zone:c.zone, centre:c.centre, airport:null, home:c.home, day, back:back||null};
  mountCity();
}
function saveLocalTrip(i){
  const W=CITY.want, form=CITY.el.querySelector('.cp-form'), f=W?.tid?findTrip(W.tid):null;
  let t=CITY.trips?.[i];
  if(i==='walk' && CITY.walk){ // pieszo: wyjście o godzinie z formularza
    const when=form.when.value||'', dep=when.slice(11,16)||'', m=CITY.walk.minutes, end=dep?(([h,mm])=>{ const x=h*60+mm+m; return String(Math.floor(x/60)%24).padStart(2,'0')+':'+String(x%60).padStart(2,'0'); })(dep.split(':').map(Number)):'';
    t={walk:true, dep:{day:when.slice(0,10), clock:dep}, arr:{day:when.slice(0,10), clock:end}, minutes:m, transfers:0, walkMin:m, steps:[{kind:'walk', line:'', from:form.from.value.trim(), to:form.to.value.trim(), dep, arr:end, minutes:m}]};
  }
  if(!t || !f?.trip || f.shared) return;
  const item={id:Date.now().toString(36)+Math.random().toString(36).slice(2,5), from:form.from.value.trim(), to:form.to.value.trim(), a:CITY.ends.from?.at||null, b:CITY.ends.to?.at||null,
    day:t.dep.day||'', dep:t.dep.clock, arr:t.arr.clock, minutes:t.minutes, transfers:t.transfers, walkMin:t.walkMin||0, steps:(t.steps||[]).slice(0,12), ...(t.proxy?{proxy:t.proxy}:{}), ...(t.walk?{walk:true}:{}), savedAt:new Date().toISOString()};
  const before=localItems(f.trip, W.local);
  if(before.length>=LOCAL_MAX){ toast(`W planie zwiedzania jednego miasta mieści się ${LOCAL_MAX} punktów — usuń któryś, aby dodać nowy.`); return; }
  saveLocal(f, W.local, [...before, item]);
  toast(`Dodano do planu zwiedzania: ${item.from} → ${item.to}`);
}
// Zamiana miejscami z sąsiadem (dir -1 wyżej, 1 niżej).
function moveLocalTrip(f, id, dir){
  const key=localKeyOf(f.trip,id); if(key==null) return;
  const list=localItems(f.trip,key), i=list.findIndex(x=>x.id===id), j=i+dir; if(j<0 || j>=list.length) return;
  [list[i], list[j]]=[list[j], list[i]]; saveLocal(f, key, list);
  document.querySelector(`#tripPage [data-lp-move="${CSS.escape(id)}"][data-dir="${dir}"]:not([disabled])`)?.focus(); // klawiatura zostaje przy przesuwanym punkcie
}
function sortLocalTrips(f, key){ saveLocal(f, key, localItems(f.trip,key).sort((a,b)=>`${a.day} ${a.dep}`.localeCompare(`${b.day} ${b.dep}`))); }
function removeLocalTrip(f, id){ const key=localKeyOf(f.trip,id); if(key!=null) saveLocal(f, key, localItems(f.trip,key).filter(x=>x.id!==id)); }
// Zapisany przejazd z powrotem w planerze: oba punkty i godzina, od razu szukamy połączeń.
function showLocalTrip(f, id){
  const T=f.trip, x=allLocalItems(T).find(y=>y.id===id); if(!x) return;
  if(!TRIPV.city){ TRIPV.city=true; renderTripPage(); }
  const form=CITY.el?.querySelector('.cp-form'); if(!form) return;
  if(x.day && x.dep) form.when.value=`${x.day}T${x.dep}`;
  if(x.a) setEnd('from', x.a, x.from, true); else form.from.value=x.from;
  if(x.b) setEnd('to', x.b, x.to, true); else form.to.value=x.to;
  cityPlan(); CITY.el.scrollIntoView({behavior:'smooth', block:'start'});
}
// Podróż pociągiem, autobusem, samochodem albo w etapach: te same kroki co z samolotem
// (wyjazd, przyjazd, dojazd do hotelu, nocleg, powrót, w domu) — zmienia się tylko środek transportu.
const GSTEP_MAP={go:'ground', arr:'centre', xfer:'hotel', hotel:'hotel', ret:'ground', home:'home'};
// Stacja lub przystanek wsiadania i wysiadania z kroków przejazdu („Pociąg IC 3539: Rzeszów Główny → Warszawa Wschodnia”).
function rideEnds(g){
  const r=(g?.steps||[]).filter(x=>['train','bus','bus-simple'].includes(x.icon) && String(x.text||'').includes('→'));
  return {from:r.length?r[0].text.split('→')[0].split(': ').pop().trim():g?.from||'', to:r.length?r[r.length-1].text.split('→').pop().trim():g?.to||''};
}
// Wspólny widok: pierwszy i ostatni odcinek tam, powrót (jeśli jest).
function groundView(T){
  if(T.multi){
    const L0=T.legs[0], Ln=T.legs[T.legs.length-1], at=L=>L.kind==='flight'
      ? {day:L.day, leave:L.snap?.out?.dep||'', arrive:L.snap?.out?.arr||'', arrDay:L.arrDay||L.day, icon:'plane', from:L.snap?.out?.fromLabel||L.from, to:L.snap?.out?.toLabel||L.to}
      : {day:L.day, leave:L.g?.leave!=null?fmtClock(L.g.leave):'', arrive:L.g?.arrive!=null?fmtClock(L.g.arrive):'', arrDay:L.g?.arrive!=null?dayOfTs(L.g.arrive):L.day, icon:L.icon||L.g?.icon||'route', from:rideEnds(L.g).from||L.from, to:rideEnds(L.g).to||L.to};
    return {go:at(L0), arr:at(Ln), back:null, roundBack:null, title:T.legs.map(L=>L.title).join(' › ')};
  }
  const legs=T.ground.legs||[T.ground.out], g0=legs[0], gn=legs[legs.length-1], b=T.ground.back;
  const at=g=>({day:g.day, leave:g.leave!=null?fmtClock(g.leave):'', arrive:g.arrive!=null?fmtClock(g.arrive):'', arrDay:g.arrive!=null?dayOfTs(g.arrive):g.day, icon:g.icon||'route', from:rideEnds(g).from, to:rideEnds(g).to});
  return {go:at(g0), arr:at(gn), back:b?at(b):null, backG:b||null, roundBack:T.ground.roundBack||null, title:legs.map(g=>g.title).join(' › '), lastKind:gn.kind};
}
function groundFlow(T){
  const V=groundView(T), cur=TRIPV.step||'go', home=ptOf(T.home), dest=ptOf(T.dest), h=T.hotel;
  const pt=(key,icon,label,time,place,wx,cls='')=>`<button type="button" class="tp-point ${cls} ${key===cur?'on':''}" data-tp-step="${key}" aria-pressed="${key===cur}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><small>${label}</small><b>${esc(time||'—')}</b><span>${esc(place||'')}</span>${wx||''}</button>`;
  const pts=[
    pt('go','house','Wyjazd',`${fmtDay(V.go.day)} ${V.go.leave}`.trim(),T.home?.label,wxChip(home,V.go.day)),
    pt('arr',V.arr.icon,'Przyjazd',V.arr.arrive,V.arr.to,wxChip(dest,V.arr.arrDay)),
    pt('xfer','diamond-turn-right','Do hotelu',h?'trasa':'—',h?h.name:'najpierw wybierz hotel','',h?'':'soft'),
    h?pt('hotel','hotel','Nocleg',h.checkin?`${fmtDay(h.checkin)}–${fmtDay(h.checkout)}`:'hotel',h.name,''):pt('hotel','bed','Nocleg','dodaj hotel','szukaj lub wpisz','','soft')];
  if(V.back){ pts.push(pt('ret',V.back.icon,'Powrót',`${fmtDay(V.back.day)} ${V.back.leave}`.trim(),V.back.from,wxChip(dest,V.back.day))); pts.push(pt('home','house','W domu',V.back.arrive,T.home?.label,wxChip(home,V.back.arrDay))); }
  else if(V.roundBack) pts.push(pt('ret','rotate-left','Powrót',fmtDay(V.roundBack),'nie wybrano połączenia','','soft'));
  return `<nav class="tp-flow" aria-label="Przebieg podróży">${pts.join('<span class="tp-conn" aria-hidden="true"></span>')}</nav>`;
}
function groundStepPanel(T, f){
  const V=groundView(T), step=TRIPV.step||'go', home=ptOf(T.home), dest=ptOf(T.dest), h=T.hotel, hp=ptOf(h);
  const box=(icon,title,body)=>`<section class="tp-sec tp-panel"><h4><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${title}</h4><div class="tp-sec-body">${body}</div></section>`;
  const mode=k=>k==='car'?'driving':k==='walk'?'walking':'transit';
  const next=(key,text)=>`<div class="tp-where"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Dalej: <span>${text}</span> <button type="button" class="btn-ghost tp-next" data-tp-step="${key}">Zobacz <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>`;
  const legBody=(g,a,b)=>`<div class="tp-line"><div><b>${esc(g.title)}</b><small>${esc(g.from)} → ${esc(g.to)} · ${longDay(g.day,{weekday:'short', day:'numeric', month:'long'})}${g.leave!=null?` · wyjście ${fmtClock(g.leave)}`:''}${g.arrive!=null?` · na miejscu ${fmtClock(g.arrive)}`:''}${g.minutes?` · ${fmtDuration(g.minutes)}`:''}${g.km?` · ${fmtKm(g.km)}`:''}</small></div>
      <span class="tp-icons">${home&&dest?iconMap('ground','Trasa na mapie'):''}${iconLink(gDir(a,b,mode(g.kind)),'diamond-turn-right','Wskazówki (Google Maps)')}</span></div>${stepsHtml(g.steps||[])}`;
  if(step==='go'){
    if(T.multi) return box('route','Tam', multiTripBody(T)+next('arr','przyjazd'));
    const legs=T.ground.legs||[T.ground.out];
    const stop=k=>{ const x=T.stops?.[k]; return x?`<div class="trip-stop-note"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(x.label)}${x.stay?`: postój ${fmtStay(x.stay)}`:''}</div>`:''; };
    return box(V.go.icon, legs.length>1?'Tam':`Tam: ${esc(legs[0].title)}`, legs.map((g,k)=>(legs.length>1?`<h5 class="tp-leg-sub">Etap ${k+1}</h5>`:'')+legBody(g, g.a||(k?legs[k-1].b:home), g.b||(k===legs.length-1?dest:null))+(k<legs.length-1?stop(k):'')).join('')+next('arr','przyjazd'));
  }
  if(step==='arr') return box('location-dot',`Przyjazd: ${esc(V.arr.to)}`, `<div class="tp-line"><div><b>${esc(V.arr.arrive||'—')} · ${longDay(V.arr.arrDay,{weekday:'short', day:'numeric', month:'long'})}</b><small>${esc(V.arr.to)}</small></div><span class="tp-icons">${dest?iconMap('centre','Na mapie'):''}${iconLink(gPlace(null,V.arr.to),'diamond-turn-right','Google Maps')}</span></div>
      <div class="tp-where">${wxChip(dest,V.arr.arrDay)} <small>pogoda w dniu przyjazdu</small></div>${next('xfer','dojazd do hotelu')}`);
  if(step==='xfer'){
    const to=hp?hp.join(','):h?`${h.name}, ${h.address||T.dest?.label||''}`:'';
    const href=h?`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(V.arr.to)}&destination=${encodeURIComponent(to)}&travelmode=${V.lastKind==='car'?'driving':'transit'}`:'';
    return box('diamond-turn-right','Dojazd do hotelu', h?`<div class="tp-line"><div><b>${esc(V.arr.to)} → ${esc(h.name)}</b><small>${V.arr.arrive?`przyjazd ${esc(V.arr.arrive)}`:''}${h.address?` · ${esc(h.address)}`:''}</small></div><span class="tp-icons">${hp?iconMap('hotel','Hotel na mapie'):''}${iconLink(href,'diamond-turn-right','Wskazówki (Google Maps)')}</span></div>${next('hotel','nocleg')}`
      :`<div class="empty-note">Wybierz nocleg, a pokażemy tu drogę do hotelu.</div>${next('hotel','wybierz nocleg')}`);
  }
  if(step==='hotel') return box('hotel','Nocleg', hotelSection(f,T)+(V.back||V.roundBack?next('ret','powrót'):''));
  if(step==='ret'){
    if(V.backG) return box(V.back.icon,`Powrót: ${esc(V.backG.title)}`, legBody(V.backG,dest,home)+next('home','w domu'));
    if(V.roundBack) return box('rotate-left',`Powrót: ${longDay(V.roundBack,{weekday:'short', day:'numeric', month:'long'})}`, '<div class="empty-note tp-noreturn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Nie wybrano połączenia powrotnego. Kliknij „Edytuj w planerze”, aby je wybrać.</div>');
  }
  if(step==='home' && V.back) return box('house','W domu', `<div class="tp-line"><div><b>${esc(V.back.to)} → ${esc(T.home?.label||f.from)}</b><small>przyjazd ${esc(V.back.arrive||'—')} · ${longDay(V.back.arrDay,{weekday:'short', day:'numeric', month:'long'})}</small></div><span class="tp-icons">${home?iconMap('home','Na mapie'):''}${iconLink(gDir(null,home,'transit'),'diamond-turn-right','Wskazówki (Google Maps)')}</span></div>
      <div class="tp-where">${wxChip(home,V.back.arrDay)} <small>pogoda w dniu powrotu</small></div>`);
  TRIPV.step='go'; return groundStepPanel(T,f);
}
// Podróż w etapach na stronie podróży: każdy etap ze swoim środkiem transportu, lot razem z dojazdem na lotnisko i z lotniska.
function multiTripBody(T){
  const mode=k=>k==='car'?'driving':k==='walk'?'walking':'transit', n=T.legs.length;
  return T.legs.map((L,k)=>{
    const link=L.kind==='flight'?iconLink(gPlace(L.snap?.out?.fromPoint,(L.snap?.out?.fromLabel||'')+' airport'),'diamond-turn-right','Lotnisko w Google Maps'):iconLink(gDir(L.a,L.b,mode(L.g?.kind)),'diamond-turn-right','Wskazówki (Google Maps)');
    let body='';
    if(L.kind==='flight'){
      const o=L.snap?.out||{}, x=L.snap?.xfer, acc=L.snap?.access;
      body=`<small class="text-soft">${longDay(L.day,{weekday:'short', day:'numeric', month:'long'})} · lot ${esc(o.dep||'')} → ${esc(o.arr||'')} · ${esc(o.airlineName||'')}${o.price!=null?` · ${o.price} zł/os.`:''}${o.booking?` · <a href="${esc(o.booking)}" target="_blank" rel="noopener">u przewoźnika</a>`:''}</small>
        ${acc?.steps?.length?`<h5 class="tp-leg-sub">Dojazd na lotnisko${acc.title?': '+esc(acc.title):''}</h5>${stepsHtml(acc.steps)}`:''}
        <h5 class="tp-leg-sub">Lot</h5>${stepsHtml([{icon:'plane-departure', text:`${o.fromLabel||''} → ${o.toLabel||''}`, sub:`${o.dep||''} → ${o.arr||''} · ${o.airlineName||''}`}])}
        ${x?`<h5 class="tp-leg-sub">Z lotniska</h5>${stepsHtml([{icon:x.skip?'car-side':'bus', text:x.skip?'Ktoś mnie odbierze':(x.name||''), sub:x.skip?'':[x.minutes!=null?`ok. ${fmtDuration(x.minutes)}`:'', x.fare||''].filter(Boolean).join(' · ')}])}`:''}`;
    } else {
      const g=L.g||{};
      body=`<small class="text-soft">${longDay(L.day,{weekday:'short', day:'numeric', month:'long'})}${g.leave!=null?` · wyjście ${fmtClock(g.leave)}`:''}${g.arrive!=null?` · na miejscu ${fmtClock(g.arrive)}`:''}${g.minutes?` · ${fmtDuration(g.minutes)}`:''}${g.km?` · ${fmtKm(g.km)}`:''}</small>${stepsHtml(g.steps||[])}`;
    }
    const stop=k<n-1&&T.stops?.[k]?`<div class="trip-stop-note"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(T.stops[k].label)}${T.stops[k].stay?`: postój ${fmtStay(T.stops[k].stay)}`:''}</div>`:'';
    return `<section class="tp-card tp-ground"><div class="tp-ground-head"><h4><i class="fa-solid fa-${esc(L.icon||'route')}" aria-hidden="true"></i> Etap ${k+1}: ${esc(L.from)} → ${esc(L.to)}</h4><span class="tp-icons">${iconMap('ground','Trasa na mapie')}${link}</span></div><b class="tp-leg-title">${esc(L.title)}</b>${body}</section>${stop}`;
  }).join('');
}
function groundCosts(T){
  const n=Math.max(1,T.people||1), rows=[];
  if(T.multi){
    T.legs.forEach((L,k)=>rows.push({group:'Etapy', icon:L.icon, label:`Etap ${k+1}: ${L.from} → ${L.to} · ${L.title}`, value:L.cost, note:L.cost==null?'cena nieznana':L.kind==='flight'?'lot z dojazdami':''}));
    (T.stopHotels||[]).forEach(h=>{ if(h.price!=null) rows.push({group:'Nocleg', icon:'hotel', label:`${h.place?h.place+': ':''}${h.name}`, value:h.price, note:''}); });
    if(T.hotel?.price!=null) rows.push({group:'Nocleg', icon:'hotel', label:T.hotel.name, value:T.hotel.price, note:''});
    const total=Math.round(rows.reduce((a,r)=>a+(r.value||0),0));
    return {rows, total, people:n, perPerson:Math.round(total/n), missing:rows.some(r=>r.value==null)};
  }
  const legs=T.ground.legs||[T.ground.out];
  for(const [g,label] of [...legs.map((g,k)=>[g, legs.length>1?`Etap ${k+1}`:'Tam']), [T.ground.back,'Powrót']]){
    if(!g) continue;
    const car=g.kind==='car', value=g.cost==null?null:car?g.cost*Math.ceil(n/CAR_SEATS):g.cost*n;
    rows.push({group:'Przejazdy', icon:g.icon, label:`${label}: ${g.title}`, value, note:g.cost==null?'cena nieznana':car?`paliwo, do ${CAR_SEATS} osób w aucie`:n>1?`${n} × ${zl(g.cost)}`:''});
  }
  if(T.hotel?.price!=null) rows.push({group:'Nocleg', icon:'hotel', label:T.hotel.name, value:T.hotel.price, note:''});
  const total=Math.round(rows.reduce((a,r)=>a+(r.value||0),0));
  return {rows, total, people:n, perPerson:Math.round(total/n), missing:rows.some(r=>r.value==null)};
}
// Pogoda po drodze odświeża tylko swoją sekcję (mapa i reszta strony zostają).
function tripWeatherRefresh(){
  const f=findTrip(TRIPV.id), el=document.querySelector('#tripPage .wtl');
  if(f?.trip?.weather && el) el.outerHTML=weatherTimeline(f.trip.weather, tripWeatherRefresh);
}
const gDir=(a,b,mode)=>a&&b?`https://www.google.com/maps/dir/?api=1&origin=${a[0]},${a[1]}&destination=${b[0]},${b[1]}&travelmode=${mode}`:'';
const gPlace=(p,q='')=>p?`https://www.google.com/maps/search/?api=1&query=${p[0]},${p[1]}`:q?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`:'';
const linkBtn=(href,icon,label)=>href?`<a class="btn-ghost" href="${esc(href)}" target="_blank" rel="noopener"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${label}</a>`:'';
const mapBtn=(key,label='Na mapie')=>`<button type="button" class="btn-ghost" data-tp-map="${esc(key)}"><i class="fa-solid fa-map" aria-hidden="true"></i> ${label}</button>`;
/* ---------- Hotel: Booking.com (sandbox Demand API), link do wyszukiwania albo własny hotel ---------- */
const HOT=new Map();
// Link „Szukaj na Booking.com” z wybranym rodzajem noclegu i liczbą pokoi. Wybór pamięta ta przeglądarka; zmiana
// podmienia tylko adres linków (bez ponownego rysowania ekranu). Pokoi nie może być więcej niż dorosłych (Booking.com).
const BOOKING_TYPES=[['','Wszystkie noclegi'],['204','Hotele'],['201','Apartamenty'],['208','B&B i pensjonaty'],['203','Hostele'],['220','Domy wakacyjne']];
const BOOK_OPT={rooms:1, type:''};
try{ const o=JSON.parse(localStorage.getItem('podavo.bookingOpts')||'{}'); if(o.rooms>=1&&o.rooms<=8) BOOK_OPT.rooms=Math.round(o.rooms); if(BOOKING_TYPES.some(t=>t[0]===o.type)) BOOK_OPT.type=o.type; }catch(e){}
function bookingWithOpts(url){
  try{
    const u=new URL(url); if(!/(^|\.)booking\.com$/.test(u.hostname) || !u.pathname.startsWith('/searchresults')) return url;
    const adults=Math.max(1, +u.searchParams.get('group_adults')||1);
    u.searchParams.set('no_rooms', String(Math.min(BOOK_OPT.rooms, adults)));
    if(BOOK_OPT.type) u.searchParams.set('nflt', `ht_id=${BOOK_OPT.type}`); else u.searchParams.delete('nflt');
    return u.toString();
  }catch(e){ return url; }
}
function bookingSearchLink(link){
  if(!link) return '';
  const adults=(()=>{ try{ return Math.max(1, +new URL(link).searchParams.get('group_adults')||1); }catch(e){ return 1; } })();
  const type=`<label class="book-opt"><span>Rodzaj</span><select data-book-type>${BOOKING_TYPES.map(([v,l])=>`<option value="${v}"${v===BOOK_OPT.type?' selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
  const rooms=`<label class="book-opt"><span>Pokoje</span><input type="number" min="1" max="${adults}" value="${Math.min(BOOK_OPT.rooms, adults)}" data-book-rooms></label>`;
  return `<span class="book-opts">${type}${rooms}<a class="btn-ghost" href="${esc(bookingWithOpts(link))}" data-book-base="${esc(link)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Szukaj na Booking.com</a></span>`;
}
document.addEventListener('change', e=>{
  const t=e.target.closest('[data-book-type],[data-book-rooms]'); if(!t) return;
  if(t.matches('[data-book-type]')) BOOK_OPT.type=BOOKING_TYPES.some(x=>x[0]===t.value)?t.value:'';
  else { const v=Math.min(+t.max||8, 8, Math.max(1, Math.round(+t.value||1))); t.value=v; BOOK_OPT.rooms=v; }
  try{ localStorage.setItem('podavo.bookingOpts', JSON.stringify(BOOK_OPT)); }catch(e2){}
  document.querySelectorAll('a[data-book-base]').forEach(a=>{ a.href=bookingWithOpts(a.dataset.bookBase); });
  document.querySelectorAll('[data-book-type]').forEach(x=>{ if(x!==t) x.value=BOOK_OPT.type; });
});
function hotelQuery(T){
  const c=T.centre?.lat!=null?T.centre:T.dest?.lat!=null?T.dest:T.airport;
  // Pociąg, autobus lub samochód: zameldowanie w dniu dotarcia na miejsce, wymeldowanie w dniu powrotu.
  const legs=T.ground?(T.ground.legs||[T.ground.out]):T.multi?T.legs:[], last=legs[legs.length-1];
  const reached=last?(last.arrive!=null?dayOfTs(last.arrive):last.arrDay||last.g?.arrive!=null&&dayOfTs(last.g.arrive)||last.day):'';
  const checkin=(T.out?.arrDay)||T.out?.day||reached, back=T.ret?.day||T.ground?.back?.day||'', checkout=back||(checkin?addDays(checkin,1):'');
  return c?.lat!=null&&checkin?{lat:c.lat, lon:c.lon, checkin, checkout:checkout>checkin?checkout:addDays(checkin,1), adults:T.people||1, city:T.airport?.city||T.centre?.label||T.dest?.label||''}:null;
}
function hotelCard(h, actions){
  return `<div class="hotel-card">${h.photo?`<img src="${esc(h.photo)}" alt="" loading="lazy">`:'<span class="hotel-noimg"><i class="fa-solid fa-hotel" aria-hidden="true"></i></span>'}<div class="hotel-body">
    <b>${esc(h.name)}</b>${h.stars?`<span class="hotel-stars">${'★'.repeat(Math.round(h.stars))}</span>`:''}
    <small>${[h.address, h.km!=null?`${h.km} km od centrum`:''].filter(Boolean).map(esc).join(' · ')}</small>
    <div class="hotel-meta">${h.score?`<span class="hotel-score">${h.score.toFixed?h.score.toFixed(1):h.score}</span>${h.reviews?` <small>${h.reviews} opinii</small>`:''}`:''}${h.price!=null?`<b class="hotel-price">${Math.round(h.price)} ${esc(h.currency||'zł')}</b><small>za cały pobyt</small>`:''}</div>
    <div class="acc-links">${actions}</div></div></div>`;
}
function hotelSection(f, T){
  const h=T.hotel, q=hotelQuery(T), st=HOT.get(tidOf(f));
  if(h){
    const p=h.lat!=null?[h.lat,h.lon]:null, centre=T.xfer?.boardAt?null:(T.centre?.lat!=null?[T.centre.lat,T.centre.lon]:null), from=T.out?.toPoint;
    return `<div class="hotel-chosen">${hotelCard(h, `${p?mapBtn('hotel'):''}${linkBtn(gPlace(p, `${h.name}, ${h.address||T.airport?.city||''}`),'location-dot','Google Maps')}${linkBtn(gDir(from,p,'transit'),'diamond-turn-right','Z lotniska do hotelu')}${h.url?linkBtn(h.url,'arrow-up-right-from-square','Booking.com'):''}<button type="button" class="btn-ghost" data-tp-hotel-remove><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Usuń z podróży</button>`)}
      <small class="text-soft">${h.checkin?`Pobyt ${fmtDay(h.checkin)} – ${fmtDay(h.checkout)}`:''}${h.manual?' · dodany ręcznie':' · cena z Booking.com przy dodaniu'}</small></div>`;
  }
  if(!q) return '<div class="empty-note">Brak miejsca lub dat podróży do szukania hotelu.</div>';
  let body='', search='';
  if(!st) search=`<button type="button" class="btn-grad" data-tp-hotel-search><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Szukaj hotelu w ${esc(q.city||'mieście')} · ${fmtDay(q.checkin)} – ${fmtDay(q.checkout)}</button>`;
  else if(st.loading) body=searching('Szukam hoteli na Booking.com…');
  else if(st.error) body=`<div class="empty-note">${esc(st.error)}</div>`;
  else if(st.configured===false) body=`<div class="empty-note">Wyszukiwarka hoteli w aplikacji czeka na klucz Booking.com (BOOKING_API_KEY i BOOKING_AFFILIATE_ID na serwerze). Do tego czasu szukaj na Booking.com i dodaj wybrany hotel poniżej.</div>`;
  else if(!st.hotels?.length) body='<div class="empty-note">Booking.com nie znalazł wolnych pokoi w okolicy w tych dniach.</div>';
  else body=`${st.sandbox?'<small class="text-soft">Dane z piaskownicy Booking.com (sandbox) — testowe.</small>':''}<div class="hotel-list">${st.hotels.map(x=>hotelCard(x, `<button type="button" class="btn-grad" data-tp-hotel-add="${esc(x.id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Dodaj do podróży</button>${x.url?linkBtn(x.url,'arrow-up-right-from-square','Booking.com'):''}`)).join('')}</div>`;
  const link=st?.bookingUrl||`https://www.booking.com/searchresults.html?${new URLSearchParams({ss:q.city, checkin:q.checkin, checkout:q.checkout, group_adults:String(Math.min(8,Math.max(1,q.adults||1))), no_rooms:'1', group_children:'0'})}`;
  // Wyszukiwanie, Booking.com i „dodaj ręcznie” w jednym wierszu; wyniki i formularz pod nim.
  return `${body}<div class="hotel-bar">${search}${bookingSearchLink(link)}
    <details class="hotel-manual"${TRIPV.manual?' open':''}><summary>Mam już hotel — dodaj go ręcznie</summary>
      <form class="hotel-form" data-tp-hotel-form><input name="hname" placeholder="Nazwa hotelu" required maxlength="120"><input name="address" placeholder="Adres (pokażemy go na mapie)" maxlength="160"><input name="price" type="number" min="0" step="1" placeholder="Cena za pobyt (zł)"><input name="url" type="url" placeholder="Link do rezerwacji (opcjonalnie)" maxlength="300"><button class="btn-grad" type="submit"><i class="fa-solid fa-plus" aria-hidden="true"></i> Dodaj hotel</button></form></details></div>`;
}
async function searchHotels(f){
  const T=f.trip, q=hotelQuery(T); if(!q) return;
  const key=tidOf(f); HOT.set(key,{loading:true}); renderTripPage();
  try{
    const r=await fetch('/api/hotels?'+new URLSearchParams(q)); const d=await r.json().catch(()=>({}));
    HOT.set(key, r.ok?d:{error:d.error||'Wyszukiwarka hoteli jest chwilowo niedostępna.', bookingUrl:d.bookingUrl});
  }catch(e){ HOT.set(key,{error:'Wyszukiwarka hoteli jest chwilowo niedostępna.'}); }
  if(S.sub==='trip' && TRIPV.id===key) renderTripPage();
}
function setTripHotel(f, hotel){
  f.trip={...f.trip, hotel}; saveFavorites().catch(e=>console.warn('Nie zapisano hotelu', e));
  TRIPMAP.key=''; renderTripPage();
}
function tripCostsWithHotel(T){
  const c=T.costs; if(!c) return null;
  const h=T.hotel; if(!h || h.price==null) return c;
  const rows=[...c.rows, {group:'Nocleg', icon:'hotel', label:h.name, value:h.currency&&h.currency!=='PLN'?null:h.price, note:h.currency&&h.currency!=='PLN'?`${Math.round(h.price)} ${h.currency}`:'za cały pobyt'}];
  return {...c, rows, total:Math.round(rows.reduce((s,r)=>s+(r.value||0),0)), missing:c.missing||rows.some(r=>r.value==null)};
}
/* ---------- Nocleg w planerze: na ostatnim kroku (przed zapisem) hotel w miejscu docelowym, a w podróży w etapach
   także w każdym mieście z noclegiem po drodze. Szukamy przez Booking.com (Demand API, gdy serwer ma klucz), zawsze
   jest link do wyszukiwania na Booking.com z datami i można wpisać własny hotel. Wybór zapisuje się razem z podróżą. ---------- */
const STAY={holder:null, kind:'', ctx:null};
const MAX_NIGHTS=30;
// Miejsca noclegu dla bieżącego planu: [{key, city, lat, lon, checkin, nights}].
function planStaySlots(kind, H, ctx={}){
  const at=p=>{ const q=Array.isArray(p)?p:p?.lat!=null?[p.lat,p.lon]:null; return q&&q[0]!=null?{lat:+q[0], lon:+q[1]}:null; };
  const nightsOf=(a,b)=>a&&b&&b>a?Math.round((Date.parse(b)-Date.parse(a))/86400000):1;
  const slot=(key, city, p, checkin, checkout)=>p&&checkin?[{key, city, ...p, checkin, nights:Math.min(MAX_NIGHTS, Math.max(1, H.stayNights?.[key]||nightsOf(checkin, checkout)))}]:[];
  if(kind==='flight'){
    const f=ctx.f, d=ctx.d; if(!f) return [];
    const p=at(d?.target)||at(H.dest?.points?.[0])||(d?.airport?at(d.airport):null);
    // Cel przy samym lotnisku („Rzym Fiumicino”): serwer zamienia go na centrum miasta (target.centre), więc nocleg
    // szukamy w mieście („Rome”), nie przy lotnisku.
    const city=d?.target?.centre?(d.target.label||d.city):(H.to||d?.city||'');
    return slot('dest', city, p, (f.arrival||'').slice(0,10)||f.day, f.ret?.day||'');
  }
  if(kind==='ground'){
    const st=ctx.stages||[H], last=st[st.length-1], g=last.groundPick; if(!g) return [];
    const arrive=g.arrive!=null?dayOfTs(g.arrive):g.day;
    return slot('dest', last.to, at(last.dest?.points?.[0]), arrive, st.length===1?H.groundBack?.day||'':'');
  }
  // W etapach: każde miasto po drodze, w którym nocujemy (następny etap rusza innego dnia), i cel, jeśli to nie dom.
  const legs=H.legs||[], n=H.places.length-1, out=[];
  legs.forEach((L,k)=>{
    if(!L) return;
    const arrive=L.arrDay||L.day, next=legs[k+1];
    if(k<n-1){ if(next?.day && next.day>arrive) out.push(...slot(`p${k+1}`, H.places[k+1], at(L.b), arrive, next.day)); }
    else if(H.places[n]!==H.places[0]) out.push(...slot(`p${k+1}`, H.places[k+1], at(L.b), arrive, ''));
  });
  return out;
}
const stayCheckout=s=>addDays(s.checkin, s.nights);
const stayQuery=(s, people)=>({lat:s.lat.toFixed(5), lon:s.lon.toFixed(5), checkin:s.checkin, checkout:stayCheckout(s), adults:String(Math.min(8,Math.max(1,people||1))), city:s.city||''});
const stayKey=(s, people)=>'stay|'+new URLSearchParams(stayQuery(s, people));
function stayPeople(kind, H){ return Math.max(1, kind==='multi'?+document.getElementById('plPeople')?.value||1:H.people||1); }
// Hotel wybrany w planerze; przy edycji zapisanej podróży — ten, który już w niej był (dopóki go nie usunięto).
function stayHotel(H, key){
  if(H.stayHotels && key in H.stayHotels) return H.stayHotels[key];
  const ed=S.editing?.tid?FAV.items.find(x=>x.type==='trip'&&x.tid===S.editing.tid)?.trip:null; if(!ed) return null;
  return ed.stopHotels?.find(x=>x.key===key) || (key==='dest'||ed.multi&&key===`p${ed.legs?.length||0}`?ed.hotel||null:null);
}
function stayLink(s, people){
  const k=stayKey(s, people), st=HOT.get(k), q=stayQuery(s, people);
  if(st?.bookingUrl) return st.bookingUrl;
  if(!HOT.has(k+'|link')){ HOT.set(k+'|link', 1);
    fetch('/api/hotels?'+new URLSearchParams({...q, link:'1'})).then(r=>r.ok?r.json():null).then(d=>{ if(d?.bookingUrl){ HOT.set(k,{...(HOT.get(k)||{}), linkOnly:!HOT.get(k), bookingUrl:d.bookingUrl}); rerenderStay(); } }).catch(()=>{}); }
  return `https://www.booking.com/searchresults.html?${new URLSearchParams({ss:q.city||`${q.lat},${q.lon}`, checkin:q.checkin, checkout:q.checkout, group_adults:q.adults, no_rooms:'1', group_children:'0'})}`;
}
function staySlotHtml(H, s, people, many){
  const h=stayHotel(H, s.key), k=stayKey(s, people), st=HOT.get(k), live=st&&!st.linkOnly?st:null, link=stayLink(s, people);
  const nights=`<label class="stay-nights">Nocy <input type="number" min="1" max="${MAX_NIGHTS}" value="${s.nights}" data-stay-nights="${esc(s.key)}" aria-label="Liczba nocy w ${esc(s.city)}"></label>`;
  const head=`<div class="stay-head"><b><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(s.city||'Na miejscu')}</b><small>${fmtDay(s.checkin)} – ${fmtDay(stayCheckout(s))}</small>${h?'':nights}</div>`;
  if(h) return `<div class="stay-slot" data-stay-slot="${esc(s.key)}">${head}<div class="hotel-chosen">${hotelCard(h, `${h.url?linkBtn(h.url,'arrow-up-right-from-square',h.manual?'Rezerwacja':'Zarezerwuj na Booking.com'):''}<button type="button" class="btn-ghost" data-stay-remove="${esc(s.key)}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Zmień nocleg</button>`)}</div></div>`;
  let body='', search=`<button type="button" class="btn-ghost stay-search" data-stay-search="${esc(s.key)}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Szukaj noclegu</button>`;
  if(live?.loading){ body=searching('Szukam noclegów na Booking.com…'); search=''; }
  else if(live?.error) body=`<div class="empty-note">${esc(live.error)}</div>`;
  else if(live?.configured===false){ body='<div class="empty-note">Wyszukiwarka noclegów w aplikacji czeka na klucz Booking.com. Szukaj na Booking.com przyciskiem obok i dodaj wybrany hotel ręcznie.</div>'; search=''; }
  else if(live && !live.hotels?.length){ body='<div class="empty-note">Booking.com nie znalazł wolnych pokoi w okolicy w tych dniach.</div>'; search=''; }
  else if(live){ search=''; body=`${live.sandbox?'<small class="text-soft">Dane z piaskownicy Booking.com (sandbox) — testowe.</small>':''}<div class="hotel-list">${live.hotels.slice(0,many?4:6).map(x=>hotelCard(x, `<button type="button" class="btn-grad" data-stay-add="${esc(s.key)}" data-stay-id="${esc(x.id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Wybierz</button>${x.url?linkBtn(x.url,'arrow-up-right-from-square','Booking.com'):''}`)).join('')}</div>`; }
  return `<div class="stay-slot" data-stay-slot="${esc(s.key)}">${head}${body}<div class="hotel-bar">${search}${bookingSearchLink(link)}
    <details class="hotel-manual"><summary>Mam już nocleg — dodaj ręcznie</summary>
      <form class="hotel-form" data-stay-form="${esc(s.key)}"><input name="hname" placeholder="Nazwa hotelu" required maxlength="120"><input name="address" placeholder="Adres (pokażemy go na mapie)" maxlength="160"><input name="price" type="number" min="0" step="1" placeholder="Cena za pobyt (zł)"><input name="url" type="url" placeholder="Link do rezerwacji (opcjonalnie)" maxlength="300"><button class="btn-grad" type="submit"><i class="fa-solid fa-plus" aria-hidden="true"></i> Dodaj nocleg</button></form></details></div></div>`;
}
// Sekcja „Nocleg” na ostatnim kroku planera: kind 'flight' (H = etap z lotem), 'ground' (H = pierwszy etap) albo 'multi' (H = S.multi).
function planStayBox(kind, H, ctx={}){
  STAY.holder=H; STAY.kind=kind; STAY.ctx=ctx;
  const slots=planStaySlots(kind, H, ctx); if(!slots.length) return '';
  const people=stayPeople(kind, H), chosen=slots.map(s=>stayHotel(H, s.key)).filter(Boolean);
  const cost=chosen.filter(h=>h.price!=null && (!h.currency||h.currency==='PLN')).reduce((a,h)=>a+h.price,0);
  return `<section class="plan-stay" data-stay-box><div class="stay-title"><h4 class="trip-title"><i class="fa-solid fa-bed" aria-hidden="true"></i> Nocleg <small>(opcjonalnie)</small></h4>${cost?`<small><span>Noclegi razem</span>: <b>${zl(cost)}</b></small>`:''}</div>
    <p class="text-soft stay-intro">Dodaj nocleg do planu — zapisze się razem z podróżą. Rezerwację potwierdzasz na Booking.com.</p>
    ${slots.map(s=>staySlotHtml(H, s, people, slots.length>1)).join('')}</section>`;
}
function rerenderStay(){
  const box=document.querySelector('#planResults [data-stay-box]'); if(!box || !STAY.holder) return;
  const html=planStayBox(STAY.kind, STAY.holder, STAY.ctx);
  if(html) box.outerHTML=html; else box.remove();
}
function staySlot(key){ return planStaySlots(STAY.kind, STAY.holder, STAY.ctx).find(s=>s.key===key); }
function setStayHotel(key, hotel){
  const H=STAY.holder; if(!H) return;
  H.stayHotels={...(H.stayHotels||{}), [key]:hotel};
  rerenderStay();
}
async function searchStay(key){
  const s=staySlot(key); if(!s) return;
  const people=stayPeople(STAY.kind, STAY.holder), k=stayKey(s, people), link=HOT.get(k)?.bookingUrl;
  HOT.set(k,{loading:true, bookingUrl:link}); rerenderStay();
  try{
    const r=await fetch('/api/hotels?'+new URLSearchParams(stayQuery(s, people))); const d=await r.json().catch(()=>({}));
    HOT.set(k, r.ok?d:{error:d.error||'Wyszukiwarka noclegów jest chwilowo niedostępna.', bookingUrl:d.bookingUrl||link});
  }catch(e){ HOT.set(k,{error:'Wyszukiwarka noclegów jest chwilowo niedostępna.', bookingUrl:link}); }
  rerenderStay();
}
// Hotele do zapisu z podróżą: hotel = cel (jak dotąd), stopHotels = noclegi po drodze w podróży w etapach.
function stayForTrip(kind, H, ctx, before){
  const slots=planStaySlots(kind, H, ctx), out={};
  const pick=s=>{ const h=stayHotel(H, s.key); return h?{...h, key:s.key, place:s.city, checkin:s.checkin, checkout:stayCheckout(s)}:null; };
  const destKey=kind==='multi'?`p${H.places.length-1}`:'dest', dest=slots.find(s=>s.key===destKey);
  const destHotel=dest?pick(dest):(H.stayHotels && destKey in H.stayHotels?null:before?.trip?.hotel||null);
  if(destHotel) out.hotel=destHotel;
  const stops=slots.filter(s=>s.key!==destKey).map(pick).filter(Boolean);
  if(stops.length) out.stopHotels=stops;
  return out;
}
document.getElementById('planResults').addEventListener('click', e=>{
  const sr=e.target.closest('[data-stay-search]'); if(sr){ searchStay(sr.dataset.staySearch); return; }
  const sa=e.target.closest('[data-stay-add]'); if(sa){
    const s=staySlot(sa.dataset.stayAdd); if(!s) return;
    const h=HOT.get(stayKey(s, stayPeople(STAY.kind, STAY.holder)))?.hotels?.find(x=>String(x.id)===sa.dataset.stayId);
    if(h){ setStayHotel(s.key, h); toast(`${L2('Nocleg','Stay')}: ${h.name}.`); } return;
  }
  const rm=e.target.closest('[data-stay-remove]'); if(rm){ setStayHotel(rm.dataset.stayRemove, null); return; }
});
document.getElementById('planResults').addEventListener('change', e=>{
  const nn=e.target.closest('[data-stay-nights]'); if(!nn || !STAY.holder) return;
  const v=Math.min(MAX_NIGHTS, Math.max(1, Math.round(+nn.value||1)));
  STAY.holder.stayNights={...(STAY.holder.stayNights||{}), [nn.dataset.stayNights]:v}; rerenderStay();
});
document.getElementById('planResults').addEventListener('submit', async e=>{
  const form=e.target.closest('[data-stay-form]'); if(!form) return;
  e.preventDefault();
  const s=staySlot(form.dataset.stayForm); if(!s) return;
  const name=form.hname.value.trim(), address=form.address.value.trim(), price=form.price.value!==''?Number(form.price.value):null, url=form.url.value.trim();
  if(!name) return;
  let lat=null, lon=null;
  if(address){
    const r=await fetch('/api/geocode?'+new URLSearchParams({q:s.city&&!address.toLowerCase().includes(s.city.toLowerCase())?`${address}, ${s.city}`:address, scope:'world'})).then(x=>x.ok?x.json():null).catch(()=>null);
    const p=r?.places?.[0]?.points?.[0]; if(p){ lat=p[0]; lon=p[1]; }
  }
  setStayHotel(s.key, {id:'manual', manual:true, name, address, lat, lon, price, currency:'PLN', url:/^https:\/\//.test(url)?url:''});
  toast(`${L2('Nocleg','Stay')}: ${name}${address&&lat==null?L2(' (adresu nie znaleźliśmy na mapie)',' (address not found on the map)'):''}.`);
});
/* ---------- Mapa podróży: dom, lotniska, dojazd do centrum i hotel ---------- */
const TRIPMAP={el:null, map:null, layer:null, key:'', marks:{}, base:[], baseKey:null};
function mountTripMap(f, T){
  const slot=document.querySelector('#tripPage .tp-map-slot'); if(!slot) return;
  if(!TRIPMAP.el){ TRIPMAP.el=document.createElement('div'); TRIPMAP.el.className='tp-map'; }
  slot.appendChild(TRIPMAP.el);
  if(!TRIPMAP.map){ TRIPMAP.map=L.map(TRIPMAP.el,{zoomControl:true, maxZoom:18}); TRIPMAP.map.attributionControl.setPrefix(false); TRIPMAP.layer=L.layerGroup().addTo(TRIPMAP.map); }
  pickBaseLayer(TRIPMAP.map, TRIPMAP);
  setTimeout(()=>TRIPMAP.map.invalidateSize(),0);
  const key=`${tidOf(f)}|${T.hotel?.name||''}|${T.savedAt||''}`; if(TRIPMAP.key===key) return;
  TRIPMAP.key=key; TRIPMAP.layer.clearLayers(); TRIPMAP.marks={};
  const pts=[], P=(x)=>Array.isArray(x)&&x[0]!=null?x:x?.lat!=null?[x.lat,x.lon]:null;
  const mark=(name,p,icon,color,label)=>{ if(!p) return; pts.push(p); TRIPMAP.marks[name]=L.marker(p,{icon:L.divIcon({className:'tp-pin', html:`<span style="background:${color}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`, iconSize:[28,28], iconAnchor:[14,14]})}).bindPopup(`<b>${esc(label)}</b>`).addTo(TRIPMAP.layer); };
  const line=(a,b,opt)=>{ if(a&&b) L.polyline(Array.isArray(opt?.pts)?opt.pts:[a,b],{color:opt?.color||'#555', weight:opt?.weight||3, dashArray:opt?.dash||null, opacity:.85}).addTo(TRIPMAP.layer); };
  const home=P(T.home), dep=P(T.out?.fromPoint), arr=P(T.out?.toPoint)||P(T.airport), board=P(T.xfer?.boardAt), centre=P(T.centre)||P(T.dest), hotel=P(T.hotel), retDep=P(T.ret?.fromPoint), retArr=P(T.ret?.toPoint);
  mark('home',home,'house','#FF6B5B',`Start: ${T.home?.label||''}`);
  mark('out-from',dep,'plane-departure','#2a5bd7',T.out?.fromLabel||'Lotnisko wylotu');
  mark('out-to',arr,'plane-arrival','#2a5bd7',T.out?.toLabel||'Lotnisko przylotu');
  if(retDep && (!arr || retDep[0]!==arr[0])) mark('ret-from',retDep,'plane-departure','#7a4bd1',T.ret?.fromLabel||'Lotnisko powrotu');
  if(retArr && (!dep || retArr[0]!==dep[0])) mark('ret-to',retArr,'plane-arrival','#7a4bd1',T.ret?.toLabel||'Lotnisko powrotu');
  TRIPMAP.marks['ret-from']=TRIPMAP.marks['ret-from']||TRIPMAP.marks['out-to']; TRIPMAP.marks['ret-to']=TRIPMAP.marks['ret-to']||TRIPMAP.marks['out-from'];
  if(board) mark('board',board,'location-dot','#1a7f4b',`Odjazd do centrum: ${T.xfer?.board||''}`);
  mark('centre',centre,'city','#F5A524',T.centre?.label||T.dest?.label||'Centrum');
  mark('hotel',hotel,'hotel','#b26b00',T.hotel?.name||'Hotel');
  if(T.ground||T.multi){
    (T.stops||[]).forEach((x,k)=>{ if(x.lat!=null) mark('stop'+k,[x.lat,x.lon],'location-dot','#2878D0',x.label); });
    const way=[home, ...(T.stops||[]).map(x=>x.lat!=null?[x.lat,x.lon]:null), centre].filter(Boolean);
    for(let k=0;k<way.length-1;k++) line(way[k],way[k+1],{color:'#2878D0', weight:4, dash:(T.multi?T.legs.map(L=>L.kind==='flight'?'flight':L.g?.kind):(T.ground.legs||[T.ground.out]).map(g=>g.kind))[k]==='car'?null:'8 8'});
  }
  line(home,dep,{dash:'6 8'});
  if(dep&&arr) line(dep,arr,{pts:exploreArc(dep,arr,1), color:'#2a5bd7', weight:2.5, dash:'2 6'});
  line(arr,board,{dash:'2 6', color:'#1a7f4b'}); line(board||arr,centre,{color:'#1a7f4b', weight:4}); line(centre,hotel,{dash:'4 6', color:'#b26b00'});
  if(pts.length) TRIPMAP.map.fitBounds(L.latLngBounds(pts),{padding:[30,30], maxZoom:13}); else TRIPMAP.map.setView([50,15],4);
}
// Mapa podróży wczytuje kafelki dopiero, gdy ktoś o nią poprosi (przycisk, „na mapie” przy kroku albo osoba).
function tripMapBox(){
  return TRIPV.map
    ? `<section class="tp-map-box"><div class="tp-map-head"><h4><i class="fa-solid fa-map" aria-hidden="true"></i> Mapa podróży</h4><button type="button" class="btn-ghost" data-tp-map-hide><i class="fa-solid fa-eye-slash" aria-hidden="true"></i> Schowaj mapę podróży</button></div><div class="tp-map-slot"></div><small class="text-soft">Kliknij punkt podróży u góry, aby pokazać go na mapie.</small></section>`
    : `<section class="tp-map-box tp-map-off"><h4><i class="fa-solid fa-map" aria-hidden="true"></i> Mapa podróży</h4><button type="button" class="btn-ghost" data-tp-map-show><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> Pokaż mapę podróży</button><small class="text-soft">Trasa i uczestnicy na mapie. Mapa wczytuje się dopiero po kliknięciu.</small></section>`;
}
function showTripPageMap(){
  const f=findTrip(TRIPV.id); if(!f?.trip) return false;
  if(TRIPV.sheet!=='map'){ const from=TRIPV.sheet==='step'?'step:'+(TRIPV.step||'go'):TRIPV.sheet; openTripSheet('map', from); drawPeople(f.trip); }
  return true;
}
// Chowa mapę podróży; kafelki przestają się wczytywać, a mapa wraca po „Pokaż mapę podróży”.
function hideTripPageMap(){
  if(TRIPV.sheet==='map') closeTripSheet();
}
function showOnTripMap(key, scroll=true, open=false){
  if(!TRIPV.map && !(open && showTripPageMap())) return;
  const m=TRIPMAP.map; if(!m) return;
  const groups={access:['home','out-from'], xfer:['out-to','board','centre'], 'ret-to':['ret-to','home'], ground:['home','centre']};
  const names=groups[key]||[key], marks=names.map(n=>TRIPMAP.marks[n]).filter(Boolean);
  if(!marks.length) return;
  setTimeout(()=>{ if(marks.length===1){ m.setView(marks[0].getLatLng(), 14); marks[0].openPopup(); } else m.fitBounds(L.latLngBounds(marks.map(x=>x.getLatLng())),{padding:[40,40], maxZoom:15}); }, 350);
}
PEOPLE_EL.addEventListener('change', e=>{
  const sw=e.target.closest('[data-loc-viewer]'); if(!sw) return;
  const f=findTrip(TRIPV.id); if(f) setLocationViewer(f, sw.dataset.locViewer, sw.checked, sw);
});
PEOPLE_EL.addEventListener('click', e=>{
  const f=findTrip(TRIPV.id); if(!f) return;
  const person=e.target.closest('[data-person]'); if(person){ PEOPLE.focus=person.dataset.person; peopleModal?.hide(); showTripPageMap(); setTimeout(()=>drawPeople(f.trip), 250); return; }
  const rm=e.target.closest('[data-person-remove]'); if(rm){
    askConfirm(L2(`Usunąć ${rm.dataset.personName||'tę osobę'} z tej podróży?`,`Remove ${rm.dataset.personName||'this person'} from this trip?`), {detail:L2('Ta osoba przestanie widzieć podróż i lokalizacje uczestników.','They will no longer see the trip or anyone’s location.'), ok:L2('Usuń z podróży','Remove from trip'), danger:true})
      .then(ok=>{ if(ok) fetch(tripApi(f)+'/members/'+encodeURIComponent(rm.dataset.personRemove),{method:'DELETE'}).then(()=>{ loadShared(); refreshPeople(f,f.trip); }); });
    return;
  }
  if(e.target.closest('[data-trip-leave]')){
    askConfirm(L2('Opuścić tę podróż?','Leave this trip?'), {detail:L2('Zniknie z Twoich podróży, a Twoja lokalizacja przestanie być widoczna.','It will disappear from your trips and your location will stop being shown.'), ok:L2('Opuść podróż','Leave trip'), danger:true})
      .then(ok=>{ if(!ok) return; fetch(tripApi(f)+'/members/'+encodeURIComponent(FAV.user.id),{method:'DELETE'}).then(async()=>{ store('onward.sharing', sharingList().filter(x=>!(x.owner===tripOwner(f)&&x.tid===f.tid))); peopleModal?.hide(); await loadShared(); goPage('podroz','moje'); }); });
  }
});
/* ---------- Podpowiedzi osób przy udostępnianiu: znajomi z podróży oraz konta, których e-mail zaczyna się od wpisanego tekstu ---------- */
const INV={timer:null, items:[], active:-1, seq:0};
function inviteList(){ return document.getElementById('tripInviteList'); }
function closeInviteList(){ const ul=inviteList(), input=document.getElementById('tripInvite'); if(ul){ ul.hidden=true; ul.innerHTML=''; } input?.setAttribute('aria-expanded','false'); INV.items=[]; INV.active=-1; }
function renderInviteList(){
  const ul=inviteList(), input=document.getElementById('tripInvite'); if(!ul||!input) return;
  if(!INV.items.length){ closeInviteList(); return; }
  ul.innerHTML=INV.items.map((p,i)=>`<li role="option" id="inv-${i}" class="${i===INV.active?'on':''}" data-inv="${i}" aria-selected="${i===INV.active}"><span class="tp-avatar sm" style="background:${personColor(p.id)}">${esc(initials(p.name))}</span><span><b>${esc(p.name||'—')}</b><small>${esc(p.email)}${p.contact?' · '+L2('wspólne podróże','shared trips before'):''}</small></span></li>`).join('');
  ul.hidden=false; input.setAttribute('aria-expanded','true');
  if(INV.active>=0) input.setAttribute('aria-activedescendant','inv-'+INV.active); else input.removeAttribute('aria-activedescendant');
}
function pickInvite(i){
  const p=INV.items[i], input=document.getElementById('tripInvite'); if(!p||!input) return;
  input.value=p.contact?p.email:`${p.name} (${p.email})`; input.dataset.userId=p.id; input.dataset.label=input.value;
  closeInviteList(); input.focus();
}
async function suggestPeople(q){
  const seq=++INV.seq;
  try{
    const r=await fetch('/api/trips/people?'+new URLSearchParams({q})); if(!r.ok || seq!==INV.seq) return;
    const taken=new Set((PEOPLE.data?.members||[]).map(m=>m.id));
    INV.items=((await r.json()).people||[]).filter(p=>!taken.has(p.id)); INV.active=-1; renderInviteList();
  }catch(e){ console.warn('Podpowiedzi osób', e); }
}
PEOPLE_EL.addEventListener('input', e=>{
  if(e.target.id!=='tripInvite') return;
  const input=e.target; if(input.value!==input.dataset.label){ delete input.dataset.userId; delete input.dataset.label; }
  clearTimeout(INV.timer); const q=input.value.trim();
  if(!q){ closeInviteList(); return; }
  INV.timer=setTimeout(()=>suggestPeople(q), 220);
});
PEOPLE_EL.addEventListener('keydown', e=>{
  if(e.target.id!=='tripInvite' || !INV.items.length) return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); const n=INV.items.length; INV.active=(INV.active+(e.key==='ArrowDown'?1:-1)+n)%n; renderInviteList(); }
  else if(e.key==='Enter' && INV.active>=0){ e.preventDefault(); pickInvite(INV.active); }
  else if(e.key==='Escape'){ e.stopPropagation(); closeInviteList(); }
});
PEOPLE_EL.addEventListener('mousedown', e=>{ const li=e.target.closest('[data-inv]'); if(li){ e.preventDefault(); pickInvite(+li.dataset.inv); } });
PEOPLE_EL.addEventListener('focusout', e=>{ if(e.target.id==='tripInvite') setTimeout(closeInviteList, 150); });
PEOPLE_EL.addEventListener('submit', async e=>{
  const form=e.target.closest('[data-trip-invite]'); if(!form) return;
  e.preventDefault();
  const f=findTrip(TRIPV.id), input=form.querySelector('input'), msg=form.parentElement.querySelector('.tp-invite-msg'), btns=[...form.querySelectorAll('button')];
  if(!f) return;
  const withLocation=e.submitter?.dataset.withLocation==='1';
  msg.textContent=''; msg.className='tp-invite-msg';
  if(withLocation && !(await locationAllowed())){ msg.textContent=L2('Bez zgody na lokalizację na tym urządzeniu możesz udostępnić podróż tylko bez lokalizacji.','Without location permission on this device you can only share without location.'); msg.className='tp-invite-msg err'; return; }
  const btn={set disabled(v){ btns.forEach(b=>b.disabled=v); }};
  btn.disabled=true;
  const picked=input.dataset.userId&&input.value===input.dataset.label?{userId:input.dataset.userId}:{email:input.value.trim()};
  fetch('/api/trips/'+encodeURIComponent(f.tid)+'/members',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...picked, withLocation})})
    .then(async r=>{ const body=await r.json().catch(()=>({})); if(!r.ok){ msg.textContent=body.error||L2('Nie udało się udostępnić podróży.','Could not share the trip.'); msg.className='tp-invite-msg err'; return; }
      input.value=''; delete input.dataset.userId; delete input.dataset.label; closeInviteList();
      const done=body.member.status==='accepted'?L2(`${body.member.name} już jest w tej podróży.`,`${body.member.name} is already on this trip.`)
        :withLocation?L2(`Wysłano zaproszenie do: ${body.member.name}. Po akceptacji zobaczy podróż i Twoją lokalizację.`,`Invitation sent to ${body.member.name}. Once accepted, they will see the trip and your location.`)
        :L2(`Wysłano zaproszenie do: ${body.member.name}. Po akceptacji zobaczy podróż (bez Twojej lokalizacji).`,`Invitation sent to ${body.member.name}. Once accepted, they will see the trip (without your location).`);
      if(body.member.seesMyLocation){ const s2=await fetch(tripApi(f)+'/location-sharing',{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({viewerId:body.member.id, enabled:true})}).then(x=>x.ok?x.json():null).catch(()=>null); rememberSending(f, s2); }
      PEOPLE.adding=false; await loadShared(); await refreshPeople(f, f.trip);
      const m2=document.querySelector('#tripPeople .tp-invite-msg'); if(m2){ m2.className='tp-invite-msg ok'; m2.textContent=done; } })
    .catch(()=>{ msg.textContent=L2('Brak połączenia.','No connection.'); msg.className='tp-invite-msg err'; })
    .finally(()=>{ btn.disabled=false; });
}, true);
document.getElementById('tripPage').addEventListener('click', e=>{
  const f=findTrip(TRIPV.id); if(!f) return;
  if(e.target.closest('[data-tp-book]')){ f.status='booked'; navCounts(); saveFavorites().catch(err=>console.warn('Nie zapisano podróży', err)); toast('Zapisano w „Moje podróże”.'); setSubpage('trip'); return; }
  if(e.target.closest('[data-tp-plan]')){ openInPlanner(f); return; }
  if(e.target.closest('[data-tp-share]')){ openPeople(f); return; }
  if(e.target.closest('[data-tp-remove]')){ askConfirm(L2('Usunąć tę podróż?','Delete this trip?'), {detail:f.title||`${f.from} → ${f.to}`, ok:L2('Usuń podróż','Delete trip'), danger:true}).then(ok=>{ if(!ok) return; const booked=f.status==='booked'; FAV.items=FAV.items.filter(x=>x!==f); saveFavorites().catch(err=>console.warn('Nie zapisano', err)); renderFavorites(); syncStars(); goPage('podroz', booked?'moje':'ulubione', 'podroz'); }); return; }
  if(e.target.closest('[data-ai-go]')){ const c=aiCity(f); if(c) aiGenerate(f,c); return; }
  if(e.target.closest('[data-ai-style]')){ if(AIP.form) aiReadForm(document.querySelector('#tripPage .ai-box')); AIP.form=!AIP.form; if(AIP.form&&!AIP.style) aiLoadStyle(); else renderTripPage(); return; }
  const af=e.target.closest('[data-ai-fit]'); if(af){ const c=aiCity(f); if(c) aiFit(f,c,+af.dataset.aiFit); return; }
  const ar=e.target.closest('[data-ai-route]'); if(ar){ const c=aiCity(f), [di,si]=ar.dataset.aiRoute.split(':').map(Number); if(c) aiRoute(f,c,di,si); return; }
  const lc=e.target.closest('[data-lp-city]'); if(lc){ TRIPV.cityAt=+lc.dataset.lpCity; renderTripPage(); return; }
  const lr=e.target.closest('[data-lp-remove]'); if(lr){ removeLocalTrip(f, lr.dataset.lpRemove); return; }
  const lm=e.target.closest('[data-lp-move]'); if(lm){ moveLocalTrip(f, lm.dataset.lpMove, +lm.dataset.dir); return; }
  const lo=e.target.closest('[data-lp-sort]'); if(lo){ sortLocalTrips(f, lo.dataset.lpSort); return; }
  const ls=e.target.closest('[data-lp-show]'); if(ls){ showLocalTrip(f, ls.dataset.lpShow); return; }
  if(e.target.closest('[data-tp-city]')){ TRIPV.city=!TRIPV.city; renderTripPage(); if(TRIPV.city) setTimeout(()=>document.querySelector('#tripPage .city-panel')?.scrollIntoView({behavior:'smooth', block:'start'}),80); return; }
  const ts=e.target.closest('[data-tp-step]'); if(ts){ openTripSheet('step:'+ts.dataset.tpStep); return; }
  const nc=e.target.closest('[data-near-cat]'); if(nc){ NEAR.cat=nc.dataset.nearCat; NEAR.limit=12; renderTripPage(); return; }
  if(e.target.closest('[data-near-more]')){ NEAR.limit+=12; renderTripPage(); return; }
  if(e.target.closest('[data-near-toggle]')){ NEAR.open=!NEAR.open; store('podavo.near.open', NEAR.open); renderTripPage(); return; }
  if(e.target.closest('[data-near-retry]')){ const c=aiCity(f); if(c){ NEAR.err.delete(nearKey(c)); renderTripPage(); } return; }
  const nr=e.target.closest('[data-near-route]'); if(nr){ const c=aiCity(f); if(c) nearRoute(f,c,nr.dataset.nearRoute); return; }
  const na=e.target.closest('[data-near-about]'); if(na){ const c=aiCity(f), p=c&&NEAR.data.get(nearKey(c))?.places?.find(x=>x.id===na.dataset.nearAbout); if(p) openAbout({name:String(p.wikipedia).replace(/^[a-z]{2,3}:/,''), lat:p.lat, lon:p.lon}); return; }
  if(e.target.closest('[data-tp-about]')){ const c=f.trip?tripCities(f.trip,f)[0]:null; if(c?.centre) openAbout({name:c.label, lat:c.centre.lat, lon:c.centre.lon}); return; }
  const sh=e.target.closest('[data-tp-sheet]'); if(sh){ openTripSheet(sh.dataset.tpSheet); return; }
  if(e.target.closest('[data-tp-sheet-close]') || e.target.matches('[data-tp-sheet-layer]')){ closeTripSheet(); return; }
  if(e.target.closest('[data-tp-sheet-back]')){ openTripSheet(TRIPV.back||''); return; }
  const tm=e.target.closest('[data-tp-map]'); if(tm){ showOnTripMap(tm.dataset.tpMap, false, true); return; }
  if(e.target.closest('[data-tp-map-hide]')){ hideTripPageMap(); return; }
  if(e.target.closest('[data-tp-map-show]')){ showTripPageMap(); return; }
  if(e.target.closest('[data-tp-hotel-search]')){ searchHotels(f); return; }
  const ha=e.target.closest('[data-tp-hotel-add]'); if(ha){ const st=HOT.get(tidOf(f)), h=st?.hotels?.find(x=>String(x.id)===ha.dataset.tpHotelAdd), q=hotelQuery(f.trip); if(h){ setTripHotel(f,{...h, checkin:q?.checkin||'', checkout:q?.checkout||''}); toast(`Dodano hotel: ${h.name}.`); } return; }
  if(e.target.closest('[data-tp-hotel-remove]')){ askConfirm(L2('Usunąć hotel z tej podróży?','Remove the hotel from this trip?'), {detail:f.trip?.hotel?.name||'', ok:L2('Usuń hotel','Remove hotel'), danger:true}).then(ok=>{ if(!ok) return; const {hotel, ...rest}=f.trip; f.trip=rest; saveFavorites().catch(err=>console.warn('Nie zapisano', err)); TRIPMAP.key=''; renderTripPage(); }); return; }
  const rf=e.target.closest('[data-fav-refresh]'); if(rf){ const fl=savedFlight(f); if(fl) refreshSavedPrice(rf.dataset.favRefresh, fl).then(()=>{ if(S.sub==='trip') renderTripPage(); }); return; }
  const fa=e.target.closest('[data-fav-alert]'); if(fa){ const fl=savedFlight(f); if(fl) openAlertDialog({...fl, price:FAVP.get(fa.dataset.favAlert)?.price??f.flight?.price??null, label:tripName(f)}); }
});
// W okolicy: promień wyszukiwania (1–5 km), zapamiętany na tym urządzeniu.
document.addEventListener('change', e=>{
  const t=e.target.closest('[data-near-radius]'); if(!t) return;
  const r=+t.value; if(!NEAR_RADII.includes(r)) return;
  NEAR.radius=r; NEAR.limit=12; store('podavo.near.radius', r); renderTripPage();
});
document.getElementById('tripPage').addEventListener('submit', async e=>{
  const form=e.target.closest('[data-tp-hotel-form]'); if(!form) return;
  e.preventDefault();
  const f=findTrip(TRIPV.id); if(!f?.trip) return;
  const name=form.hname.value.trim(), address=form.address.value.trim(), price=form.price.value!==''?Number(form.price.value):null, url=form.url.value.trim();
  if(!name) return;
  let lat=null, lon=null;
  if(address){
    const city=f.trip.airport?.city||f.trip.centre?.label||'';
    const r=await fetch('/api/geocode?'+new URLSearchParams({q:city&&!address.toLowerCase().includes(city.toLowerCase())?`${address}, ${city}`:address, scope:'world'})).then(x=>x.ok?x.json():null).catch(()=>null);
    const p=r?.places?.[0]?.points?.[0]; if(p){ lat=p[0]; lon=p[1]; }
  }
  const q=hotelQuery(f.trip);
  setTripHotel(f,{id:'manual', manual:true, name, address, lat, lon, price, currency:'PLN', url:/^https:\/\//.test(url)?url:'', checkin:q?.checkin||'', checkout:q?.checkout||''});
  toast(`Dodano hotel: ${name}${address&&lat==null?' (adresu nie znaleźliśmy na mapie)':''}.`);
});
function savedPlan(f){
  if(f.plan?.out) return {...f.plan, tid:f.tid||''};
  const m=/^f:([^|]*\|[^|]*\|[A-Z]{3}\|[A-Z]{3}\|\d{4}-\d{2}-\d{2}\|(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?):(.*)$/.exec(f.id||'');
  return m?{out:m[1], ret:'', access:m[2]}:null;
}
function openFavorite(f){
  const kind=favKind(f);
  if(f.type==='trip'){ openTrip(tidOf(f)); return; }
  if(f.type==='route'){ openInPlanner(f); return; }
  openSavedItem(f, kind);
}
// Zapisana trasa albo podróż w planerze: te same miejsca i daty, a przy podróży te same loty i wybory.
function openInPlanner(f){
  goPage('podroz');
  S.editing={tid:f.tid||'', label:`${f.from} → ${f.to}`}; renderEditBadge();
  S.placeChoice={}; clearVias(); plFrom.value=f.from; plTo.value=f.to;
  if(f.trip?.multi){ const kinds={flight:['plane','car'], ground:null}; enterMultiForm({from:f.from, steps:f.trip.legs.map(L=>({to:L.to, date:L.day>=ymdOf(0)?L.day:'', modes:L.kind==='flight'?['bus','pks','train','plane','car']:undefined}))}); document.querySelector('.search-box')?.scrollIntoView({behavior:'smooth', block:'center'}); return; }
  (f.trip?.stops||[]).forEach(x=>{ addVia(); const row=viaRows().at(-1); row.querySelector('input').value=x.label; const days=x.stay&&x.stay%1440===0; row.querySelector('.pl-stay input').value=days?x.stay/1440:(x.stay||0); row.querySelector('.pl-stay-unit').value=days?'1440':'1'; });
  const fl=f.type==='trip'?(savedFlight(f)||groundDates(f)):null;
  if(fl?.day){
    document.querySelector(`[data-round="${fl.back?1:0}"]`)?.click();
    plDate.value=fl.day; if(fl.back) plBack.value=fl.back; plTime.value='';
    S.restore=savedPlan(f);
  }
  const g=f.trip?.ground; S.restoreGround=g?{legs:g.legs||[g.out], back:g.back||null}:null; // wybrane połączenia wracają do planera
  document.getElementById('planForm').requestSubmit();
}
function openSavedItem(f, kind){
  if(f.type==='line' && kind!=='kolej'){ goPage(kind); if(GT.routes.has(f.id)) openLine(f.id); return; }
  goPage(kind, 'rozklad');
  if(f.type==='line'){
    const today=ymdOf(0), train=TR.trains.find(t=>t.label===f.id && t.date===today);
    if(train) openTrain(train.key);
  } else if(kind==='kolej'){
    const id=RAIL_IDS.find(i=>RAIL_ST[i][0]===f.name); if(id==null) return;
    TR.station=id; TR.page=null; document.getElementById('trStation').value=String(id); renderBoard();
  } else setTimetableStop(f.name);
}document.addEventListener('click', e=>{
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
  loadShared(); startSending(); loadInbox();
  setInterval(()=>{ if(!document.hidden) loadInbox(); }, 120000);
  // Zmiany zrobione bez internetu są nowsze niż kopia na serwerze: wysyłamy je zamiast łączyć.
  if(store('onward.favsPending')){ if(navigator.onLine!==false) await saveFavorites(); renderFavorites(); return; }
  const r=await fetch('/api/favorites'); if(!r.ok) return;
  const {favorites}=await r.json(), known=new Set(favorites.map(favKey)), local=FAV.items.filter(f=>!known.has(favKey(f)));
  FAV.items=[...favorites, ...local].slice(0,50);
  if(local.length) await saveFavorites(); else store('rzbus.favs', FAV.items);
  renderFavorites(); if(S.sub==='moje'||S.sub==='trip') setSubpage(S.sub);
}).catch(e=>console.warn('Nie wczytano ulubionych', e));

window.addEventListener('online', ()=>{ document.body.classList.remove('offline'); if(FAV.user && store('onward.favsPending')) saveFavorites(); });
window.addEventListener('offline', ()=>document.body.classList.add('offline'));
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
// Powrót ma własne strony: „Późniejsze” przesuwa tylko listę powrotów.
function backPager(P, back, railBack){
  const deps=[...back.map(o=>o.dep), ...railBack.map(r=>r.leave)], last=deps.length?Math.max(...deps):null, hist=P.round.history||[];
  P.round.lastDep=last;
  if(last==null && !hist.length) return '';
  return `<div class="pager">${hist.length?'<button class="btn-ghost" type="button" data-back-page="prev">← Wcześniejsze</button>':''}${last!=null?'<button class="btn-ghost" type="button" data-back-page="next">Późniejsze →</button>':''}</div>`;
}
function planPager(P, results){
  const last=results[results.length-1]; P.lastDep=last?last.dep:null;
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
  if(!TT.stop){ lineSel.innerHTML='<option value="">Wszystkie linie</option>'; el.innerHTML=''; return; }
  const all=timetableRows();
  const routes=[...new Set(all.map(d=>d.t.route))].map(routeById).sort((a,b)=>natSort(a.short,b.short));
  if(TT.line && !routes.some(r=>r.id===TT.line)) TT.line='';
  lineSel.innerHTML='<option value="">Wszystkie linie</option>'+routes.map(r=>`<option value="${esc(r.id)}">Linia ${esc(r.short)}</option>`).join('');
  lineSel.value=TT.line;
  const rows=TT.line ? all.filter(d=>d.t.route===TT.line) : all, now=nowSec();
  const head=`<div class="plan-head"><span>${esc(TT.stop)} ${favButton({type:'stop',view:S.agency,name:TT.stop})}</span><span class="text-soft">${esc(dayLabel(TT.day))} · ${rows.length} odjazdów · rozkład planowy</span></div>`;
  const estimate=estimatedAgencies(dayInfo(TT.day)).filter(agency=>agency===S.agency), note=estimate.length?estimateNote(estimate,dayInfo(TT.day)):'';
  if(!rows.length){ el.innerHTML=head+note+'<div class="empty-note">'+stateIll(assetPaths.noDepartures)+'Brak odjazdów w tym dniu.</div>'; return; }
  const p=paginate(rows, TT.page??(TT.day===0?pageOfNow(rows,TT_PAGE,d=>d.dep,now):1), TT_PAGE);
  // 4d: ta sama tablica odjazdów co w innych miastach (PVT.departureBoard, model Departure), z rozkładu GTFS w przeglądarce.
  // Rozkład jest planowy, więc wiersze nie pokazują opóźnień; wiersz otwiera linię, gwiazdka ją zapisuje.
  const deps=p.rows.map(d=>{ const r=routeById(d.t.route), last=GT.stopGroupOf.get(d.st[d.st.length-1].stop)||'', clock=`0000-00-00T${fmtClock(d.dep)}`;
    return {line:r.short, headsign:d.t.headsign||last, mode:'bus', scheduled:clock, expected:clock, at:d.dep*1000, realtime:'scheduled', color:lineColor(r.short,r.color,r.agency), textColor:'#fff', route:r.id}; });
  el.innerHTML=head+note+PVT.departureBoard(deps, {t:L2, now:TT.day===0?now*1000:0, open:x=>['data-route',x.route], after:x=>lineStar(x.route)})+pagerHtml(p, TT.day===0);
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
document.getElementById('ttReset').addEventListener('click', ()=>{ TT.day=0; document.getElementById('ttDay').value='0'; document.getElementById('ttErr').textContent=''; setTimetableStop(''); });
document.getElementById('ttResults').addEventListener('click', e=>{
  const pg=e.target.closest('[data-page]'); if(pg){ TT.page=+pg.dataset.page; renderTimetable(); return; }
  if(e.target.closest('[data-page-now]')){ TT.page=null; renderTimetable(); return; }
  const b=e.target.closest('[data-route]'); if(b) openLine(b.dataset.route);
});

/* ---------- Podpowiedzi podczas pisania ---------- */
// Przystanki z bazy: w podróży tylko te w pobliżu (at = [lat,lon]) i dworce, których nazwa zaczyna się od wpisanego tekstu,
// żeby „Gdańska” nie podsuwała przystanków z 48 miast naraz.
const STOP_NEAR_M=40000;
function stopMatches(q, at){
  const f=foldText(q.trim()), names=S.agency==='podroz' ? allStopNames() : [...GT.groups.keys()].filter(groupInView);
  const rank=n=>{ const t=foldText(n); return t.startsWith(f)?0 : t.split(/[\s.,\-\/()]+/).some(w=>w.startsWith(f))?1 : t.includes(f)?2 : -1; };
  let hits=names.map(n=>({n, m:rank(n), d:0})).filter(x=>x.m>=0);
  if(at && S.agency==='podroz') hits=hits.map(x=>{ const p=stopPoint(x.n); return {...x, d:p?hav(at,p):Infinity}; })
    .filter(x=>x.d<=STOP_NEAR_M || (x.m===0 && !GT.groups.has(x.n)));
  return hits.sort((a,b)=>a.m-b.m || a.d-b.d || natSort(a.n,b.n)).slice(0,5).map(x=>x.n);
}
// Gdzie jest użytkownik (ostatnia znana pozycja z mapy lub widżetu pogody); bez niej Rzeszów.
function myBias(){
  const me=PK.me; if(me?.length===2) return me;
  const spot=store('onward.wxSpot'); return spot && Number.isFinite(+spot.lat) && Number.isFinite(+spot.lon) ? [+spot.lat,+spot.lon] : null;
}
const SG_KIND={street:['fa-road','ulica'], address:['fa-location-dot','adres'], miejsce:['fa-location-dot','miejsce'], poi:['fa-location-dot','miejsce'], station:['fa-train','stacja'], airport:['fa-plane','lotnisko'], city:['fa-city','miasto'], area:['fa-map','okolica'], przystanek:['fa-bus-simple','przystanek'], lot:['fa-plane','lot']};
function setBusy(input, on){
  const box=input.closest('.pl-inp'); if(!box) return; // np. pola planera po mieście: bez kółka
  let spin=box.querySelector('.pl-spin');
  if(on && !spin){ spin=document.createElement('span'); spin.className='mini-spin pl-spin'; spin.setAttribute('role','status'); spin.setAttribute('aria-label','Szukam adresu…'); spin.title='Szukam adresu…'; input.after(spin); }
  if(!on && spin) spin.remove();
}
// Podpowiedzi, które są adresem: ulica (z numerem), miasto, okolica albo miasto za granicą.
const ADDRESS_KINDS=new Set(['street','address','city','area','lot']);
function attachSuggest(input, {streets, onPick, local:suggest, near, field, addressOnly}){ // addressOnly(): tylko adresy, bez przystanków i miejsc // near(): [lat,lon] — podpowiedzi z okolic innego miasta; field(): pole planera
  const box=document.createElement('ul'); box.className='suggest-list'; box.id=input.id+'List'; box.setAttribute('role','listbox'); box.hidden=true;
  (input.closest('.pl-field')||input.closest('.cp-field')||input.parentElement).appendChild(box);
  input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-controls',box.id); input.setAttribute('aria-expanded','false'); input.autocomplete='off';
  let items=[], active=-1, timer=null, req=0;
  const close=()=>{ clearTimeout(timer); req++; setBusy(input,false); box.hidden=true; active=-1; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); };
  const draw=()=>{
    box.innerHTML=items.map((it,i)=>{ const [icon,kind]=SG_KIND[it.kind]||['fa-location-dot',it.kind||''];
      return `<li id="${box.id}-${i}" role="option" aria-selected="${i===active}" class="sg-item${i===active?' active':''}" data-i="${i}"><i class="fa-solid ${icon} sg-ico" aria-hidden="true"></i><span class="sg-text"><span class="sg-main">${esc(it.main||it.label)}</span><small class="sg-sub"><span class="sg-kind">${esc(kind)}</span>${it.sub?' · '+esc(it.sub):''}</small></span></li>`; }).join('');
    box.hidden=!items.length; input.setAttribute('aria-expanded', String(!box.hidden));
    if(active>=0) input.setAttribute('aria-activedescendant', box.id+'-'+active); else input.removeAttribute('aria-activedescendant');
  };
  const pick=it=>{
    input.value=it.label; close();
    // Wybrane z listy miejsce (np. sklep albo dworzec) trafia do planera dokładnie tam, gdzie leży, bez ponownego szukania po nazwie.
    const f=field?.(); if(f){ if(it.point) S.placeChoice[f]={q:it.label, place:{label:it.label, locality:'', points:[it.point]}}; else delete S.placeChoice[f]; }
    if(onPick) onPick(it);
  };
  const abroad=q=>{
    if(input.id==='ttStop') return [];
    const f=foldText(q.trim()), code=q.trim().toUpperCase();
    return foreignPlaces().filter(p=>foldText(p.label).startsWith(f) || (code.length===3 && p.code===code))
      .sort((a,b)=>natSort(a.label,b.label)).slice(0,2).map(p=>{ const [main,...rest]=p.label.split(', '); return {label:p.label, main, sub:rest.join(', '), kind:'lot'}; });
  };
  input.addEventListener('input', ()=>{
    clearTimeout(timer); const q=input.value.trim(), my=++req;
    if(q.length<2){ items=[]; close(); return; }
    const at=streets ? (near?.()||myBias()) : null;
    const onlyAddr=!!addressOnly?.();
    const local=suggest ? suggest(q) : onlyAddr ? abroad(q) : [...abroad(q), ...stopMatches(q, at||(streets?[50.0378,22.0049]:null)).slice(0, streets?3:5).map(label=>({label, kind:'przystanek'}))];
    items=local; active=-1; draw();
    if(!streets) return;
    setBusy(input,true);
    timer=setTimeout(async()=>{
      try{
        const r=await fetch('/api/streets?q='+encodeURIComponent(q)+(at?'&near='+at.map(x=>(+x).toFixed(4)).join(','):'')); if(!r.ok) return;
        const {suggestions, places}=await r.json();
        if(my!==req) return;
        // Jak w mapach: najpierw prawdziwe miejsca (sklepy, dworce, ulice, miasta), potem najwyżej dwa pasujące przystanki z rozkładu.
        const found=suggestions.map((label,i)=>({label, kind:places?.[i]?.kind||(onlyAddr?'address':'miejsce'), main:places?.[i]?.main, sub:places?.[i]?.sub, point:places?.[i]?.point||null}))
          .filter(it=>!onlyAddr || ADDRESS_KINDS.has(it.kind));
        const seen=new Set(found.map(it=>foldText(it.label)));
        items=[...found, ...local.filter(it=>!seen.has(foldText(it.label))).slice(0,2)]; active=-1; draw();
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
  const s=Object.values(RAIL_ST).find(x=>x[0]===name); return s?[s[1],s[2]]:RAIL_BY_NAME.get(name)||null;
}
function stopPlace(name){ const p=stopPoint(name); return {label:name, names:[name], walk:new Map(), isStop:true, points:p?[p]:[]}; }
function streetPlace(place, approximate){
  const stops=nearbyStops(place).map(x=>({...x, dist:Math.round(x.dist*WALK_FACTOR)})); // do czasu, aż znamy prawdziwe dojście
  return {label:place.label, place, approximate:!!approximate, points:place.points, names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist])), nearest:stops[0]};
}
// Przystanki, do których da się dojść: liczymy drogę pieszą po ścieżkach, a nie w linii prostej,
// bo przystanek bliski w linii prostej bywa za rzeką lub polem. Brane są też dalsze przystanki,
// żeby kilkaset metrów spaceru mogło zastąpić przesiadkę.
const WALK_STOP_M=1200, WALK_SEARCH_M=1500, WALK_REACH_M=3000, WALK_CANDIDATES=16, walkCache=new Map();
const coordOf=g=>g.lat.toFixed(5)+','+g.lon.toFixed(5);
async function refineWalks(place){
  if(!place?.place || place.isStop || !place.points?.length || !GT.loaded) return place;
  const p=place.points[0];
  const all=[...GT.groups.values()].filter(g=>g.lat!=null && groupInView(g.name)).map(g=>({g, d:hav(p,[g.lat,g.lon])})).sort((x,y)=>x.d-y.d);
  // Za granicą albo daleko od rozkładu nie ma przystanku, do którego da się dojść, więc nie podsuwamy żadnego.
  const near=all.filter(x=>x.d<=WALK_SEARCH_M), reach=all.filter(x=>x.d<=WALK_REACH_M), cand=(near.length>=3?near:reach.slice(0,3)).slice(0,WALK_CANDIDATES);
  if(!cand.length) return Object.assign(place, {names:[], walk:new Map(), nearest:null});
  const coords=[...new Set(cand.map(x=>coordOf(x.g)))], key=p[0].toFixed(5)+','+p[1].toFixed(5)+'|'+coords.join(';');
  if(!walkCache.has(key)){
    try{
      const r=await fetch(`/api/walk?from=${p[0].toFixed(5)},${p[1].toFixed(5)}&to=${coords.join(';')}`);
      if(!r.ok) throw new Error('HTTP '+r.status);
      walkCache.set(key, (await r.json()).meters);
    }catch(e){ console.warn('Dojście do przystanków', e); walkCache.set(key, null); }
  }
  const meters=walkCache.get(key), byCoord=new Map(coords.map((c,i)=>[c, meters?.[i]]));
  const walked=cand.map(x=>{ const m=byCoord.get(coordOf(x.g)); return {name:x.g.name, dist:m!=null?m:Math.round(x.d*WALK_FACTOR)}; }).sort((x,y)=>x.dist-y.dist);
  const keep=walked.filter(x=>x.dist<=WALK_STOP_M), stops=(keep.length>=3?keep:walked.slice(0,3)).slice(0,12);
  return Object.assign(place, {names:stops.map(x=>x.name), walk:new Map(stops.map(x=>[x.name,x.dist])), nearest:stops[0], walkRouted:!!meters});
}
function stationPlace(name){ return Object.assign(streetPlace({label:name, points:stopPlace(name).points}), {station:name, isStop:true}); }
async function geocodeStreet(q, world){
  const r=await fetch('/api/geocode?q='+encodeURIComponent(q)+(world?'&scope=world':''));
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
// Najpierw Polska, potem reszta świata. „Gdańsk” nie może trafić na przystanek „Gdańska”, stąd sprawdzenie nazwy miasta przed przystankiem.
// „Rzeszów D.A.” to cały dworzec, czyli wszystkie jego stanowiska.
function stopFamily(text){
  const q=text.toLowerCase(), names=[...GT.groups.keys()].filter(n=>groupInView(n) && n.toLowerCase().startsWith(q+' ') && /^\d+$/.test(n.slice(q.length+1)));
  if(!names.length) return null;
  const pts=names.map(stopPoint), mean=i=>pts.reduce((sum,x)=>sum+x[i],0)/pts.length;
  return {label:names[0].slice(0,q.length), names, walk:new Map(), isStop:true, points:[[mean(0),mean(1)]]};
}
function placeTitle(field){ return field==='from'?'Skąd':field==='to'?'Dokąd':'Przystanek'; }
async function resolvePlace(text, field){
  const q=(text||'').trim(), title=placeTitle(field);
  if(!q) return {error:`Wpisz adres, przystanek lub miasto w polu „${title}”.`};
  // „Skąd?” w planerze podróży sprawdzamy tylko jako adres: bez przystanków, stacji i miejsc z mapy.
  const addrOnly=field==='from' && S.agency==='podroz';
  const exact=!addrOnly && allStopNames().find(n=>n.toLowerCase()===q.toLowerCase());
  if(exact) return GT.groups.has(exact) ? stopPlace(exact) : stationPlace(exact);
  const abroad=foreignPlaces().find(p=>p.label.toLowerCase()===q.toLowerCase()) || airportPlace(q,false);
  if(abroad) return streetPlace(abroad);
  const chosen=S.placeChoice[field];
  if(chosen && chosen.q===q) return streetPlace(chosen.place, chosen.approximate);
  const family=addrOnly?null:stopFamily(q), partialStop=()=>{ if(addrOnly) return null; if(family) return family; const n=resolveStop(q); if(n) return stopPlace(n); const s=resolveStation(q); return s?stationPlace(s):null; };
  // Wynik musi mieć coś wspólnego z wpisaną nazwą: „Sztokholm” nie może trafić na lokal „Sztokholm” przy Wielkopolskiej 68 w Gdańsku.
  const words=foldName(q.split(',')[0]).split(' ').filter(w=>w.length>=4), related=p=>!words.length || words.some(w=>foldName(p.label).includes(w));
  try{
    // Samo miasto lotniska za granicą (np. „Sztokholm”): środek miasta ze świata, gdy leży blisko lotniska; inaczej lotnisko.
    const city=!/\d/.test(q) && airportPlace(q,true);
    if(city){
      const world=(await geocodeStreet(q,true).catch(()=>({places:[]}))).places.find(p=>related(p) && hav(p.points[0], city.points[0])<=80000);
      return streetPlace(world||city);
    }
    const found=await geocodeStreet(q), near={...found, places:found.places.filter(related)};
    const same=near.places.find(p=>p.label.toLowerCase()===q.toLowerCase()); // sama nazwa miasta: ulica o tej nazwie w innej wsi nie jest wątpliwością
    if(same) return streetPlace(same, near.approximate);
    if(family) return family;
    if(near.places.length===1) return streetPlace(near.places[0], near.approximate);
    if(near.places.length>1) return {choose:near.places, approximate:near.approximate, field, q};
    const top=(await geocodeStreet(q,true)).places[0];
    if(top && top.label.toLowerCase().startsWith(q.toLowerCase())) return streetPlace(top);
    const airport=airportPlace(q,true); if(airport) return streetPlace(airport);
    // Pierwszy wynik ze świata bierzemy tylko wtedy, gdy ma coś wspólnego z wpisaną nazwą (np. nie „Wielkopolska 68, Gdańsk” dla „Sztokholm”).
    return partialStop() || (top && related(top) ? streetPlace(top) : {error:`Nie znaleziono miejsca „${q}” (pole „${title}”). Sprawdź pisownię albo wpisz samo miasto.`});
  }catch(e){
    console.warn('Wyszukiwanie miejsc', e);
    return partialStop() || {error:addrOnly?`Wyszukiwarka adresów jest chwilowo niedostępna. Spróbuj ponownie za chwilę.`:`Wyszukiwarka adresów jest chwilowo niedostępna. W polu „${title}” wpisz nazwę przystanku.`};
  }
}
function renderPlaceChoice(r){
  S.placeOptions=r;
  document.getElementById('planResults').innerHTML=`<div class="place-choice"><div class="plan-head"><span>„${esc(r.q)}”: której lokalizacji szukasz? (${placeTitle(r.field)})</span></div>
    ${r.choose.map((p,i)=>`<button type="button" class="btn-ghost" data-place="${i}">${esc(p.label)}</button>`).join('')}</div>`;
}
let planReq=0;
function tripStart(){
  const today=ymdOf(0), date=plDate.value && plDate.value>today ? plDate.value : '', arriving=plWhen.value==='arr';
  if(!date && !plTime.value) return {at:null, date:''};
  const [h,m]=(plTime.value||(date?'00:00':'08:00')).split(':').map(Number); // sama data: wszystkie połączenia tego dnia
  const off=date ? Math.round((Date.parse(date)-Date.parse(today))/86400000) : 0;
  let at=dayInfo(off).base+h*3600+m*60;
  if(!date && at<nowSec()-(arriving?0:3600)) at+=86400;
  if(!arriving) return {at, date};
  const day=dayOfTs(at);
  return {at:null, by:at, date:day>today?day:''};
}
function viaRows(){ return [...document.querySelectorAll('#plStops .pl-stop')]; }
function renumberVias(){
  viaRows().forEach((row,i)=>{ row.querySelector('.pl-via-label').textContent=S.agency==='podroz'?`Miejsce ${i+1}`:`Przystanek ${i+1}`; });
  const addStop=document.getElementById('plAddStop'); if(addStop) addStop.disabled=viaRows().length>=MAX_VIAS;
}
function addVia(){
  const id=++viaSeq, row=document.createElement('div');
  row.className='pl-stop'; row.dataset.field='via'+id;
  row.innerHTML=`<div class="pl-field"><label class="pl-via-label" for="plVia${id}"></label><div class="pl-inp"><input id="plVia${id}" placeholder="Adres, przystanek, stacja lub miasto"></div></div>
    <div class="pl-field pl-stay"><label for="plViaStay${id}">Postój</label><div class="pl-inp"><input id="plViaStay${id}" type="number" min="0" max="999" value="30"><select class="pl-stay-unit" aria-label="Jednostka postoju"><option value="1" selected>min</option><option value="60">godz.</option><option value="1440">dni</option><option value="10080">tyg.</option></select></div></div>
    <button type="button" class="pl-stop-remove" data-remove-via title="Usuń przystanek" aria-label="Usuń przystanek"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
  document.getElementById('plStops').appendChild(row);
  if(S.agency==='podroz'){ row.querySelector('.pl-stay input').value='1'; row.querySelector('.pl-stay-unit').value='1440'; } // w podróży postój to zwykle dzień lub więcej
  const input=row.querySelector('input'); attachSuggest(input, {streets:true, field:()=>row.dataset.field});
  renumberVias(); input.focus();
}
function clearVias(){ document.getElementById('plStops').innerHTML=''; renumberVias(); }
// Na stronie autobusów planer szuka tylko autobusów miejskich.
// „Autobus” obejmuje autobusy miejskie i podmiejskie (osobnego wyboru „Podmiejskie” już nie ma).
function busModes(list){ const out=new Set(list); if(out.has('bus')) out.add('pks'); else out.delete('pks'); return out; }
function readModes(){ return S.agency==='ztm' ? new Set(['bus','pks']) : busModes([...document.querySelectorAll('#plModes input:checked')].map(x=>x.value)); }
function newStage(origin, dest, shared){
  const a=origin.points[0], b=dest.points[0], restore=S.restore; S.restore=null; // zapisany plan trafia do pierwszego etapu
  return {restore, from:origin.label, to:dest.label, origin, dest, km:a&&b?hav(a,b)/1000:null, stay:0, round:null, history:[], flightPage:1, openFlight:null, access:new Map(), carTo:new Map(), railLinks:new Map(), open:new Set(), ...shared};
}
document.getElementById('planForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const err=document.getElementById('planErr'), hint=document.getElementById('planHint'); err.textContent='';
  if(!GT.loaded){ err.textContent='Rozkład jazdy jeszcze się wczytuje — spróbuj za chwilę.'; return; }
  const allowed=readModes(); if(!allowed.size){ err.textContent='Zaznacz co najmniej jeden środek transportu.'; return; }
  if(plDate.value>lastPlanDay() || (plRound.checked && plBack.value>lastPlanDay())){ err.textContent=`Podróż można zaplanować najpóźniej na ${fmtDay(lastPlanDay())}.${lastPlanDay().slice(0,4)}.`; return; }
  if(plWhen.value==='arr' && !plTime.value){ err.textContent='Podaj godzinę, o której chcesz być na miejscu.'; return; }
  if(S.agency==='podroz' && !plDate.value){ err.textContent=plRound.checked?'Wybierz termin podróży: datę wylotu i powrotu.':'Wybierz datę wyjazdu.'; if(plRound.checked) openRange(); else openDatePicker(plDate); return; }
  if(plDate.value && plDate.value<ymdOf(0)){ err.textContent='Data wyjazdu nie może być w przeszłości.'; return; }
  const legRun=S.multiLeg; S.multiLeg=false;
  if(S.agency==='podroz' && !legRun){
    const raw=viaRows().map(row=>({label:row.querySelector('input').value.trim(), stay:Math.max(0,+row.querySelector('.pl-stay input').value||0)*(+row.querySelector('.pl-stay-unit')?.value||1)})).filter(v=>v.label);
    if(raw.length){
      if(!plFrom.value.trim() || !plTo.value.trim()){ err.textContent='Podaj, skąd zaczynasz i dokąd jedziesz na końcu.'; return; }
      startMulti(plFrom.value.trim(), raw, plTo.value.trim(), plDate.value); return;
    }
    if(S.multi){ S.multi=null; renderMultiBar(); }
  }
  const req=++planReq, go=e.currentTarget.querySelector('.pl-go'), view=S.agency;
  go.disabled=true; go.classList.add('busy'); hint.textContent='';
  const round=readReturn(); if(round?.error){ err.textContent=round.error; go.disabled=false; go.classList.remove('busy'); return; }
  S.plan=null; S.planView={picked:{}, sort:S.planView.sort}; document.getElementById('planResults').innerHTML=searching('Sprawdzam adresy…');
  try{
    const vias=viaRows().map(row=>({field:row.dataset.field, input:row.querySelector('input'), stay:Math.max(0,+row.querySelector('.pl-stay input').value||0)*(+row.querySelector('.pl-stay-unit')?.value||1)})).filter(v=>v.input.value.trim());
    const fields=[{field:'from',input:plFrom}, ...vias, {field:'to',input:plTo}], places=[];
    for(const f of fields){
      setBusy(f.input,true);
      const place=await resolvePlace(f.input.value,f.field).finally(()=>setBusy(f.input,false));
      places.push(place); if(place.error||place.choose) break;
    }
    if(req!==planReq || view!==S.agency) return;
    const stopped=places.find(x=>x.error||x.choose);
    if(stopped){ S.plan=null; document.getElementById('planResults').innerHTML=''; if(stopped.error) err.textContent=stopped.error; else renderPlaceChoice(stopped); return; }
    if(places.some((p,i)=>i && p.label===places[i-1].label)){ err.textContent='Dwa kolejne miejsca podróży są takie same.'; document.getElementById('planResults').innerHTML=''; return; }
    fields.forEach((f,i)=>{ const p=places[i]; f.input.value=p.label; if(p.place) S.placeChoice[f.field]={q:p.label, place:p.place, approximate:p.approximate}; });
    document.getElementById('planResults').innerHTML=searching('Szukam połączeń…');
    await Promise.all(places.map(refineWalks));
    if(req!==planReq || view!==S.agency) return;
    const {at,by,date}=tripStart();
    const stages=places.slice(1).map((dest,i)=>Object.assign(newStage(places[i],dest,{allowed,date,people:planPeople()}), {stay:vias[i]?.stay||0}));
    const last=stages[stages.length-1];
    stages[0].at=at; last.round=round; last.home=places[0];
    S.plan={stages, by}; store(planKey(view), {from:places[0].label,to:last.to});
    const RG=S.restoreGround; S.restoreGround=null;
    if(RG && RG.legs.length===stages.length){ stages.forEach((P,k)=>{ P.groundPick=RG.legs[k]||null; }); if(RG.back && last.round) last.groundBack=RG.back; }
    for(const P of stages) if(wantsFlights(P)) loadTripFlights(P);
    runPlan(true);
  }finally{ if(req===planReq){ go.disabled=false; go.classList.remove('busy'); refreshStopList(); } }
});
const [plFrom,plTo,plTime,plWhen,plDate,plRound,plBack]=['plFrom','plTo','plTime','plWhen','plDate','plRound','plBack'].map(id=>document.getElementById(id));
// Godzina na telefonach i tabletach: dwie listy (godzina, minuty) zamiast systemowego zegara. Systemowe okno
// Androida przy większym rozmiarze tekstu ucina przycisk „Ustaw”. Pole #plTime zostaje jedynym źródłem wartości:
// listy je ustawiają (z input/change), a każde wpisanie plTime.value z kodu odświeża listy.
(function timeSelects(){
  if(!window.matchMedia?.('(pointer:coarse)').matches || !plTime) return;
  const box=plTime.closest('.pl-inp'); if(!box) return;
  const two=n=>String(n).padStart(2,'0');
  const hm=document.createElement('span'); hm.className='pl-hm';
  hm.innerHTML=`<select id="plHour" aria-label="Godzina"><option value="">Teraz</option>${Array.from({length:24},(_,h)=>`<option value="${two(h)}">${two(h)}</option>`).join('')}</select>`
    +`<span aria-hidden="true">:</span><select id="plMin" aria-label="Minuty">${Array.from({length:12},(_,i)=>`<option value="${two(i*5)}">${two(i*5)}</option>`).join('')}</select>`;
  box.classList.add('pl-hm-on'); box.appendChild(hm);
  const [hSel,mSel]=hm.querySelectorAll('select');
  const sync=()=>{
    const [h='',m='00']=(plTime.value||'').split(':');
    if(m && ![...mSel.options].some(o=>o.value===m)) mSel.add(new Option(m,m));
    hSel.value=plTime.value?h:''; mSel.value=plTime.value?m:'00'; mSel.disabled=!plTime.value;
  };
  const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
  Object.defineProperty(plTime,'value',{configurable:true, get(){ return d.get.call(this); }, set(v){ d.set.call(this,v); sync(); }});
  hm.addEventListener('change', ()=>{
    plTime.value=hSel.value?`${hSel.value}:${mSel.value||'00'}`:'';
    plTime.dispatchEvent(new Event('input',{bubbles:true})); plTime.dispatchEvent(new Event('change',{bubbles:true}));
  });
  sync();
})();
const MAX_VIAS=5; let viaSeq=0;
document.getElementById('plAddStop')?.addEventListener('click', ()=>{ if(S.agency==='podroz') enterMultiForm({addStep:true}); else addVia(); });
document.getElementById('plStops').addEventListener('click', e=>{ const b=e.target.closest('[data-remove-via]'); if(b){ delete S.placeChoice[b.closest('.pl-stop').dataset.field]; b.closest('.pl-stop').remove(); renumberVias(); } });
{ const saved=store('rzbus.plan.modes'); if(Array.isArray(saved)) setPlanModes(saved); }
// Liczba osób: koszty liczą się od nowa w tym samym planie (bez nowego wyszukiwania).
const planPeople=()=>Math.min(9,Math.max(1,+document.getElementById('plPeople')?.value||1));
{ const saved=+store('rzbus.plan.people'); if(saved>=1&&saved<=9) document.getElementById('plPeople').value=String(saved); }
document.getElementById('plPeople').addEventListener('change', ()=>{
  store('rzbus.plan.people', planPeople());
  if(!S.plan) return;
  for(const P of S.plan.stages) P.people=planPeople();
  runPlan(false);
});
document.getElementById('plModes').addEventListener('change', ()=>{
  store('rzbus.plan.modes',[...readModes()]); syncPrefer();
  const allowed=readModes(); if(!S.plan || !allowed.size) return;
  // Ten sam plan, inne środki transportu: dojazdy liczą się od nowa, krok i miejsce na stronie zostają.
  for(const P of S.plan.stages){ P.allowed=new Set(allowed); P.access=new Map(); P.carTo=new Map(); P.railLinks=new Map(); }
  const box=document.getElementById('planResults'); box.style.minHeight=box.offsetHeight+'px'; S.holdY=window.scrollY;
  runPlan(false);
});
document.getElementById('plPrefer').addEventListener('change', e=>{ store('rzbus.plan.prefer', e.target.value); if(S.plan) document.getElementById('planForm').requestSubmit(); });
document.getElementById('plRadius').addEventListener('change', e=>{ store('rzbus.plan.radius', e.target.value); if(S.plan) document.getElementById('planForm').requestSubmit(); });
// Linie lotnicze sprzedają bilety mniej więcej rok naprzód i tak daleko da się zaplanować podróż.
const PLAN_DAYS_AHEAD=366, RAIL_DAYS_AHEAD=90;
function lastPlanDay(){ return ymdOf(PLAN_DAYS_AHEAD); }
// Powrót w dniu wyjazdu też jest możliwy; domyślnie trzy dni później.
function syncReturn(){
  const round=plRound.checked && S.agency==='podroz';
  document.querySelectorAll('.trip-return-fields').forEach(e=>{ e.hidden=!round; });
  document.querySelectorAll('.one-way-date').forEach(e=>{ e.hidden=round; });
  document.getElementById('planForm').classList.toggle('round', round);
  const multi=document.body.classList.contains('multi-form') && S.agency==='podroz';
  document.querySelectorAll('[data-round]').forEach(b=>{ const on=!multi&&(b.dataset.round==='1')===plRound.checked; b.classList.toggle('on',on); b.setAttribute('aria-pressed',String(on)); });
  document.querySelectorAll('[data-trip-kind="multi"]').forEach(b=>{ b.classList.toggle('on',multi); b.setAttribute('aria-pressed',String(multi)); });
  { const mf=document.getElementById('multiForm'); if(mf) mf.hidden=!multi; }
  plDate.min=ymdOf(0); plDate.max=lastPlanDay(); plBack.max=lastPlanDay();
  document.getElementById('trDate').min=ymdOf(0); document.getElementById('trDate').max=lastPlanDay();
  document.getElementById('plLimit').textContent='';
  const start=plDate.value||ymdOf(0);
  plBack.min=start; if(plDate.value && (!plBack.value || plBack.value<start)) plBack.value=addDays(start,3);
  if(typeof syncRange==='function') syncRange();
  if(typeof syncPrefer==='function') syncPrefer();
}
function readReturn(){
  if(!plRound.checked || S.agency!=='podroz') return null;
  const start=plDate.value||ymdOf(0);
  if(!plBack.value || plBack.value<start) return {error:'Data powrotu nie może być wcześniejsza niż data wyjazdu.'};
  const off=Math.round((Date.parse(plBack.value)-Date.parse(ymdOf(0)))/86400000);
  return {back:plBack.value, at:dayInfo(off).base}; // cały dzień powrotu, od północy
}
[plRound,plDate].forEach(e=>e.addEventListener('change', syncReturn));
/* ---------- Kalendarze ON/WARD: biały, granatowe nagłówki, wybrany dzień niebieski, zakres jasnoniebieski,
   dziś turkusowy, najtańsze znane dni z bursztynową kropką ---------- */
// Ceny powrotu z ostatniego wyszukiwania (dzień → najniższa cena), do wyróżnień w kalendarzu.
function backPrices(){ const P=S.plan?.stages.find(x=>wantsFlights(x) && x.flights?.backDays); return P?new Map(P.flights.backDays.map(d=>[d.day,d.cheapest])):null; }
// Najtańsze dni: do 10% powyżej najniższej znanej ceny.
function dealDays(prices){
  if(!prices) return new Map();
  const known=[...prices].filter(([,p])=>p!=null&&p>0); if(!known.length) return new Map();
  const min=Math.min(...known.map(([,p])=>p));
  return new Map(known.filter(([,p])=>p<=min*1.1));
}
function calMonthHtml(ym, {min='', max='', lo='', hi='', prices=null, attr='data-day', focus=''}={}){
  const today=ymdOf(0), deals=dealDays(prices);
  const [y,m]=ym.split('-').map(Number), first=new Date(Date.UTC(y,m-1,1)), lead=(first.getUTCDay()+6)%7, days=new Date(Date.UTC(y,m,0)).getUTCDate();
  let cells='<span class="rng-pad"></span>'.repeat(lead);
  for(let d=1;d<=days;d++){
    const day=`${ym}-${String(d).padStart(2,'0')}`, off=(min&&day<min)||(max&&day>max), deal=deals.get(day);
    const cls=[day===lo?'from':'', day===hi?'to':'', lo&&!hi&&day===lo?'only':'', lo&&hi&&day>lo&&day<hi?'in':'', day===today?'today':'', deal!=null&&!off?'deal':''].join(' ');
    const label=`${d} ${calMonth(m)} ${y}${day===today?' · '+L2('dziś','today'):''}${deal!=null?' · '+L2('najtaniej','cheapest')+' '+deal+' zł':''}`;
    cells+=`<button type="button" class="rng-day ${cls}" ${attr}="${day}" ${off?'disabled':''} tabindex="${day===focus?0:-1}" aria-label="${esc(label)}" ${day===lo||day===hi?'aria-pressed="true"':''} title="${deal!=null?esc(L2('Najtaniej','Cheapest')+': '+deal+' zł'):''}">${d}</button>`;
  }
  return `<div class="rng-month"><b>${calMonth(m)} ${y}</b><div class="rng-grid" role="grid">${L2(RNG_DAYS,RNG_DAYS_EN).map(x=>`<span class="rng-dow">${x}</span>`).join('')}${cells}</div></div>`;
}
// Klawiatura w kalendarzu: strzałki przesuwają o dzień/tydzień, Enter wybiera, Esc zamyka.
function calKeys(e, attr, move){
  const b=e.target.closest(`[${attr}]`); if(!b) return false;
  const step={ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7}[e.key]; if(!step) return false;
  e.preventDefault();
  const next=addDays(b.getAttribute(attr), step);
  move(next);
  return true;
}

/* ---------- Termin podróży w obie strony: jeden kalendarz, pierwszy klik to wylot, drugi powrót ---------- */
const RNG={open:false, month:null, start:'', end:'', hover:''};
const RNG_MONTHS=['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
const RNG_DAYS=['pn','wt','śr','cz','pt','so','nd'];
const RNG_MONTHS_EN=['January','February','March','April','May','June','July','August','September','October','November','December'];
const RNG_DAYS_EN=['mo','tu','we','th','fr','sa','su'];
function calMonth(m){ return L2(RNG_MONTHS[m-1], RNG_MONTHS_EN[m-1]); }
// Kalendarz zawsze mieści się w oknie: pod polem, a gdy brakuje miejsca — nad nim; na telefonie środek ekranu (CSS).
function placePop(pop, anchor){
  if(!pop || pop.hidden || !anchor) return;
  if(matchMedia('(max-width:700px)').matches){ pop.style.cssText=''; return; }
  const vw=document.documentElement.clientWidth, vh=window.innerHeight, r=anchor.getBoundingClientRect(), gap=8, edge=12;
  pop.style.position='fixed'; pop.style.transform='none'; pop.style.right='auto'; pop.style.maxHeight=(vh-2*edge)+'px'; pop.style.overflow='auto';
  pop.style.left='0px'; pop.style.top='0px';
  const w=Math.min(pop.offsetWidth, vw-2*edge), h=pop.offsetHeight;
  const left=Math.max(edge, Math.min(r.left, vw-w-edge));
  let top=r.bottom+gap;
  if(top+h>vh-edge) top=r.top-gap-h>=edge ? r.top-gap-h : Math.max(edge, vh-h-edge);
  pop.style.left=left+'px'; pop.style.top=top+'px';
}
function placeOpenCalendars(){
  const dp=document.getElementById('dpPop'); if(dp && !dp.hidden && DP.input) placePop(dp, DP.input.closest('.pl-field')||DP.input);
  const rp=document.getElementById('rngPop'); if(rp && !rp.hidden) placePop(rp, document.getElementById('plRange')?.closest('.pl-field'));
}
addEventListener('resize', ()=>placeOpenCalendars());
addEventListener('scroll', ()=>placeOpenCalendars(), {passive:true, capture:true});
function rangeLabel(){
  const a=plDate.value, b=plBack.value;
  if(!a) return '<span class="rng-empty">Wybierz daty</span>';
  const n=b?Math.round((Date.parse(b)-Date.parse(a))/86400000)+1:0;
  return `<b>${fmtDay(a)}</b>${b?` – <b>${fmtDay(b)}</b> <small>· ${n} ${n===1?'dzień':'dni'}</small>`:''}`;
}
function syncRange(){ const b=document.getElementById('plRange'); if(b) b.innerHTML=`<i class="fa-regular fa-calendar" aria-hidden="true"></i> ${rangeLabel()}`; }
function openRange(){
  RNG.open=true; RNG.start=plDate.value||''; RNG.end=plDate.value?plBack.value||'':''; RNG.hover='';
  RNG.month=(RNG.start||ymdOf(0)).slice(0,7);
  renderRange();
}
function closeRange(){ RNG.open=false; const pop=document.getElementById('rngPop'); if(pop) pop.hidden=true; document.getElementById('plRange')?.setAttribute('aria-expanded','false'); }
function monthAdd(ym, n){ const [y,m]=ym.split('-').map(Number), d=new Date(Date.UTC(y,m-1+n,1)); return d.toISOString().slice(0,7); }
function renderRange(){
  const pop=document.getElementById('rngPop'); if(!pop) return;
  const today=ymdOf(0), last=lastPlanDay(), lo=RNG.start, hi=RNG.end||(RNG.start&&RNG.hover>RNG.start?RNG.hover:'');
  const prices=RNG.start&&!RNG.end?backPrices():planPrices();
  const month=ym=>calMonthHtml(ym, {min:today, max:last, lo, hi, prices, attr:'data-rng-day'});
  const step=RNG.start&&!RNG.end?'Teraz wybierz dzień powrotu':'Wybierz dzień wylotu';
  pop.innerHTML=`<div class="rng-head"><button type="button" class="rng-nav" data-rng-move="-1" ${RNG.month<=today.slice(0,7)?'disabled':''} aria-label="Poprzedni miesiąc">‹</button><span>${step}</span><button type="button" class="rng-nav" data-rng-move="1" ${monthAdd(RNG.month,1)>=last.slice(0,7)?'disabled':''} aria-label="Następny miesiąc">›</button></div>
    <div class="rng-months">${month(RNG.month)}${month(monthAdd(RNG.month,1))}</div>
    <div class="rng-foot"><span>${RNG.start?`${fmtDay(RNG.start)}${hi?` – ${fmtDay(hi)} · ${Math.round((Date.parse(hi)-Date.parse(RNG.start))/86400000)+1} dni`:''}`:''}</span><button type="button" class="btn-ghost" data-rng-close>Zamknij</button></div>`;
  pop.hidden=false; document.getElementById('plRange')?.setAttribute('aria-expanded','true');
  placePop(pop, document.getElementById('plRange')?.closest('.pl-field'));
}
function pickRangeDay(day){
  if(!RNG.start || RNG.end || day<RNG.start){ RNG.start=day; RNG.end=''; renderRange(); return; }
  RNG.end=day; plDate.value=RNG.start; plBack.value=RNG.end; syncReturn(); syncRange(); closeRange();
  document.getElementById('planErr').textContent='';
}
document.getElementById('plRange').addEventListener('click', e=>{ e.stopPropagation(); if(RNG.open) closeRange(); else openRange(); });
document.getElementById('rngPop').addEventListener('click', e=>{
  e.stopPropagation();
  const d=e.target.closest('[data-rng-day]'); if(d){ pickRangeDay(d.dataset.rngDay); return; }
  const mv=e.target.closest('[data-rng-move]'); if(mv){ RNG.month=monthAdd(RNG.month,+mv.dataset.rngMove); renderRange(); return; }
  if(e.target.closest('[data-rng-close]')) closeRange();
});
document.getElementById('rngPop').addEventListener('mouseover', e=>{
  const d=e.target.closest('[data-rng-day]'); if(!d || !RNG.start || RNG.end || d.dataset.rngDay===RNG.hover) return;
  RNG.hover=d.dataset.rngDay;
  const hi=RNG.hover>RNG.start?RNG.hover:'';
  document.querySelectorAll('#rngPop [data-rng-day]').forEach(b=>{ const x=b.dataset.rngDay; b.classList.toggle('in', !!hi && x>RNG.start && x<hi); b.classList.toggle('to', x===hi); });
});
document.addEventListener('click', e=>{ if(RNG.open && !e.target.closest('#rngPop') && !e.target.closest('#plRange')) closeRange(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && RNG.open) closeRange(); });
document.getElementById('rngPop').addEventListener('keydown', e=>calKeys(e, 'data-rng-day', day=>{
  if(day.slice(0,7)<RNG.month) RNG.month=monthAdd(RNG.month,-1); else if(day.slice(0,7)>monthAdd(RNG.month,1)) RNG.month=monthAdd(RNG.month,1);
  renderRange(); document.querySelector(`#rngPop [data-rng-day="${day}"]`)?.focus();
}));

/* ---------- Pojedyncza data (wyjazd w jedną stronę, dzień pociągu): ten sam kalendarz zamiast systemowego ---------- */
const DP={input:null, month:'', focus:''};
function dpPop(){
  let pop=document.getElementById('dpPop');
  if(!pop){
    pop=document.createElement('div'); pop.id='dpPop'; pop.className='rng-pop dp-pop'; pop.hidden=true; pop.setAttribute('role','dialog');
    pop.addEventListener('click', e=>{
      e.stopPropagation();
      const d=e.target.closest('[data-dp-day]'); if(d){ pickDate(d.dataset.dpDay); return; }
      const mv=e.target.closest('[data-dp-move]'); if(mv){ DP.month=monthAdd(DP.month,+mv.dataset.dpMove); renderDatePicker(); return; }
      if(e.target.closest('[data-dp-today]')){ pickDate(ymdOf(0)); return; }
      if(e.target.closest('[data-dp-clear]')){ pickDate(''); return; }
      if(e.target.closest('[data-dp-close]')) closeDatePicker(true);
    });
    pop.addEventListener('keydown', e=>{
      if(e.key==='Escape'){ e.stopPropagation(); closeDatePicker(true); return; }
      calKeys(e, 'data-dp-day', day=>{ DP.focus=day; DP.month=day.slice(0,7); renderDatePicker(); pop.querySelector(`[data-dp-day="${day}"]`)?.focus(); });
    });
  }
  return pop;
}
function openDatePicker(input){
  closeRange();
  const pop=dpPop(), field=input.closest('.pl-field')||input.parentElement;
  if(pop.parentElement!==field) field.appendChild(pop);
  DP.input=input; DP.focus=input.value||(input.min&&input.min>ymdOf(0)?input.min:ymdOf(0)); DP.month=DP.focus.slice(0,7);
  pop.setAttribute('aria-label', (field.querySelector('label')?.textContent||L2('Wybierz datę','Pick a date')).trim());
  renderDatePicker();
  input.setAttribute('aria-expanded','true');
  setTimeout(()=>pop.querySelector('[tabindex="0"]')?.focus({preventScroll:true}),0);
}
function closeDatePicker(refocus){
  const pop=document.getElementById('dpPop'); if(!pop||pop.hidden) return;
  pop.hidden=true; DP.input?.setAttribute('aria-expanded','false'); if(refocus) DP.input?.focus({preventScroll:true});
}
function renderDatePicker(){
  const pop=dpPop(), input=DP.input; if(!input) return;
  const min=input.min||'', max=input.max||'', prices=input===plDate?planPrices():null;
  pop.innerHTML=`<div class="rng-head"><button type="button" class="rng-nav" data-dp-move="-1" ${min&&DP.month<=min.slice(0,7)?'disabled':''} aria-label="${L2('Poprzedni miesiąc','Previous month')}">‹</button><span>${esc((input.closest('.pl-field')?.querySelector('label')?.textContent||'').trim())}</span><button type="button" class="rng-nav" data-dp-move="1" ${max&&DP.month>=max.slice(0,7)?'disabled':''} aria-label="${L2('Następny miesiąc','Next month')}">›</button></div>
    <div class="rng-months">${calMonthHtml(DP.month, {min, max, lo:input.value, prices, attr:'data-dp-day', focus:DP.focus})}</div>
    <div class="rng-foot"><span class="dp-legend">${prices&&dealDays(prices).size?`<i class="dp-dot" aria-hidden="true"></i> ${L2('najtańsze dni','cheapest days')}`:''}</span><span class="dp-actions"><button type="button" class="btn-ghost" data-dp-today>${L2('Dziś','Today')}</button>${input.id==='trDate'&&input.value?`<button type="button" class="btn-ghost" data-dp-clear>${L2('Wyczyść','Clear')}</button>`:''}<button type="button" class="btn-ghost" data-dp-close>${L2('Zamknij','Close')}</button></span></div>`;
  if(!pop.querySelector('[tabindex="0"]')) pop.querySelector('.rng-day:not([disabled])')?.setAttribute('tabindex','0');
  pop.hidden=false;
  placePop(pop, input.closest('.pl-field')||input);
}
function pickDate(day){
  const input=DP.input; if(!input) return;
  if(day && ((input.min&&day<input.min)||(input.max&&day>input.max))) return;
  input.value=day; closeDatePicker(true);
  input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
}
// Systemowy wybór daty zastępujemy naszym kalendarzem; pole nadal przechowuje datę RRRR-MM-DD jak wcześniej.
for(const input of [plDate, document.getElementById('trDate')]){
  if(!input) continue;
  input.readOnly=true; input.classList.add('dp-input'); input.setAttribute('role','combobox'); input.setAttribute('aria-haspopup','dialog'); input.setAttribute('aria-expanded','false');
  input.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); const pop=document.getElementById('dpPop'); if(pop&&!pop.hidden&&DP.input===input) closeDatePicker(false); else openDatePicker(input); });
  input.addEventListener('keydown', e=>{ if(['Enter',' ','ArrowDown'].includes(e.key)){ e.preventDefault(); openDatePicker(input); } });
}
document.addEventListener('click', e=>{ const pop=document.getElementById('dpPop'); if(pop && !pop.hidden && !e.target.closest('#dpPop') && !e.target.closest('.dp-input')) closeDatePicker(false); });
document.querySelectorAll('[data-round]').forEach(b=>b.addEventListener('click', ()=>{ document.body.classList.remove('multi-form'); plRound.checked=b.dataset.round==='1'; syncReturn(); }));
document.querySelectorAll('[data-trip-kind="multi"]').forEach(b=>b.addEventListener('click', ()=>enterMultiForm()));
attachSuggest(plFrom, {streets:true, field:()=>'from', addressOnly:()=>S.agency==='podroz'});
attachSuggest(plTo, {streets:true, field:()=>'to'});
attachSuggest(document.getElementById('ttStop'), {streets:false, onPick:it=>setTimetableStop(it.label)});
document.getElementById('plSwap').addEventListener('click', ()=>{ const a=plFrom.value; plFrom.value=plTo.value; plTo.value=a; S.placeChoice={from:S.placeChoice.to, to:S.placeChoice.from}; });
document.getElementById('plGeo').addEventListener('click', ()=>{
  const err=document.getElementById('planErr'); err.textContent='';
  if(S.agency==='podroz') return fillMyAddress(err);
  if(!GT.loaded){ err.textContent='Rozkład jeszcze się wczytuje.'; return; }
  const places=[...GT.groups.values()].filter(g=>groupInView(g.name));
  const pick=(lat,lon)=>{ let best=null,bd=1e12; for(const g of places){ const d=hav([lat,lon],[g.lat,g.lon]); if(d<bd){bd=d;best=g;} } if(best){ plFrom.value=best.name; err.textContent=`Najbliższy przystanek: ${best.name} (${Math.round(bd)} m)`; } };
  try{ navigator.geolocation.getCurrentPosition(p=>pick(p.coords.latitude,p.coords.longitude), ()=>{ const c=map.getCenter(); pick(c.lat,c.lng); err.textContent+= ' — brak dostępu do lokalizacji, użyto środka mapy.'; }, {timeout:8000}); }
  catch(e){ const c=map.getCenter(); pick(c.lat,c.lng); }
});
// Planer podróży: „Skąd?” = adres, pod którym jestem (ulica i numer z dokładnej pozycji), a nie najbliższy przystanek.
// Bez zgody na lokalizację nic nie zgadujemy ze środka mapy — prosimy o wpisanie adresu.
function fillMyAddress(err){
  const btn=document.getElementById('plGeo');
  if(!navigator.geolocation){ err.textContent=L2('To urządzenie nie podaje lokalizacji. Wpisz adres.','This device does not share its location. Type an address.'); return; }
  btn.disabled=true; setBusy(plFrom,true);
  const done=()=>{ btn.disabled=false; setBusy(plFrom,false); };
  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude, lon=pos.coords.longitude;
    try{
      const r=await fetch('/api/geocode/reverse?'+new URLSearchParams({lat:lat.toFixed(5), lon:lon.toFixed(5)}));
      const place=r.ok?(await r.json())?.place:null;
      if(!place?.label) throw new Error('HTTP '+r.status);
      plFrom.value=place.label;
      S.placeChoice.from={q:place.label, place:{label:place.label, locality:place.locality||'', points:[[lat,lon]]}};
      PK.me=[lat,lon];
      if((pos.coords.accuracy||0)>300) err.textContent=L2(`Lokalizacja jest przybliżona (ok. ${Math.round(pos.coords.accuracy)} m). Sprawdź adres.`,`Your location is approximate (about ${Math.round(pos.coords.accuracy)} m). Check the address.`);
    }catch(e){ console.warn('Adres z lokalizacji', e); err.textContent=L2('Nie udało się ustalić adresu. Wpisz go ręcznie.','Could not find your address. Type it in.'); }
    finally{ done(); }
  }, e=>{ done(); err.textContent=e?.code===1?L2('Przeglądarka nie zezwala na lokalizację. Wpisz adres.','Your browser blocks location. Type an address.'):L2('Nie udało się ustalić położenia. Wpisz adres.','Could not find your position. Type an address.'); },
  {enableHighAccuracy:true, timeout:15000, maximumAge:0});
}
document.getElementById('planResults').addEventListener('input', e=>{ if(e.target.matches('[data-trip-title]')){ const P=S.multi&&!S.plan?S.multi:stageOf(e.target); if(P) P.tripTitle=e.target.value; } });
document.getElementById('planResults').addEventListener('change', e=>{
  if(e.target.matches('[data-filter-group]')){ S.planView.picked=readFilters(document.getElementById('planFilters')); applyPlanView(); }
  else if(e.target.id==='planSort'){ S.planView.sort=e.target.value; applyPlanView(); }
});
document.getElementById('planResults').addEventListener('click', e=>{
  if(e.target.closest('[data-clear-filters]')){ S.planView.picked={}; applyPlanView(); return; }
  const shift=e.target.closest('#planResults [data-shift]'); if(shift){ const box=shift.closest('.date-strip').querySelector('.ds-days'); const dayW=box.querySelector('.ds-day')?.offsetWidth||box.clientWidth/7; box.scrollBy({left:+shift.dataset.shift*dayW*7, behavior:'smooth'}); return; }
  const day=e.target.closest('#planResults [data-day]');
  if(day && day.closest('.date-strip')?.dataset.strip==='back'){ plBack.value=day.dataset.day; syncReturn(); document.getElementById('planForm').requestSubmit(); return; }
  if(day){ // powrót przesuwa się razem z wyjazdem, żeby liczba dni się nie zmieniła
    const away=plRound.checked&&plBack.value?Math.round((Date.parse(plBack.value)-Date.parse(plDate.value||ymdOf(0)))/86400000):null;
    plDate.value=day.dataset.day; if(away!=null) plBack.value=addDays(day.dataset.day,away);
    syncReturn(); document.getElementById('planForm').requestSubmit(); return;
  }
  const rr=e.target.closest('[data-row-refresh]'); if(rr){ e.preventDefault(); const P=stageOf(rr), f=FL.byKey.get(rr.dataset.rowRefresh); if(P&&f) updateFare(P,f); return; }
  const fl=e.target.closest('[data-flight]'); if(fl){ openFlight(fl.dataset.flight); return; }
  const ask=e.target.closest('[data-ask-airlines]'); if(ask){ askAirlines(stageOf(ask)); return; }
  const pt=e.target.closest('[data-pick-time]');
  if(pt){
    const P=stageOf(pt), f=FL.byKey.get(pt.dataset.pickTime), card=pt.closest('.fl-card')?.querySelector('[data-open-flight]')?.dataset.openFlight;
    if(P&&f){ f.departure=pt.dataset.time; runPlan(false); }
    return;
  }
  const al=e.target.closest('[data-alert-fare]'); if(al){ const f=FL.byKey.get(al.dataset.alertFare); if(f) openAlertDialog(alertFromFare(f)); return; }
  const wt=e.target.closest('[data-wizz-time]'); if(wt){ const P=stageOf(wt), f=FL.byKey.get(wt.dataset.wizzTime); if(P&&f) wizzTimePrice(P,f); return; }
  const upd=e.target.closest('[data-update-fare]'); if(upd){ const P=stageOf(upd), f=FL.byKey.get(upd.dataset.updateFare); if(P&&f) updateFare(P,f); return; }
  const ex=e.target.closest('[data-expand]'); if(ex){ toggleCard(ex,stageOf(ex).open); return; }
  const cs=e.target.closest('[data-cs-sort]'); if(cs){ const P=stageOf(cs); P.csSort=cs.dataset.csSort; runPlan(false); return; }
  if(e.target.closest('[data-cs-retry]')){ for(const [k,v] of XOPT) if(v?.error||v?.note==='centre-unknown'||(v&&!v.loading&&!v.options?.length)) XOPT.delete(k); runPlan(false); return; }
  const cp=e.target.closest('[data-cs-pick]'); if(cp){ const P=stageOf(cp); P.xferPick=P.xferPick===cp.dataset.csPick?null:cp.dataset.csPick; P.saved=null; runPlan(false); return; }
  const ts=e.target.closest('[data-trip-save]'); if(ts){ saveMyTrip(stageOf(ts), ts.dataset.tripSave, ts.closest('.cs-save')?.querySelector('[data-trip-title]')?.value); return; }
  const mn=e.target.closest('[data-multi-next]'); if(mn){
    const M=S.multi, P=S.plan?.stages[0]; if(!M||!P) return;
    const leg=multiLegOf(P, mn.dataset.multiNext); if(!leg) return;
    M.legs[M.cur]=leg;
    const d=document.querySelector('[data-multi-date]')?.value; if(d) M.dates[M.cur+1]=d;
    if(M.cur>=M.places.length-2) showMultiSave(); else runLeg(M.cur+1);
    return;
  }
  const md=e.target.closest('[data-multi-date]'); if(md){ e.preventDefault(); openDatePicker(md); return; }
  const ms=e.target.closest('[data-multi-save]'); if(ms){ saveMultiTrip(ms.dataset.multiSave, ms.closest('.cs-save')?.querySelector('[data-trip-title]')?.value); return; }
  const ml=e.target.closest('[data-multi-leg]'); if(ml){ runLeg(+ml.dataset.multiLeg); return; }
  const gp=e.target.closest('[data-ground-pick]'); if(gp){
    const P=stageOf(gp), x=S.groundOpts?.[+gp.dataset.groundPick]; if(!P||!x) return;
    const slot=x.dir==='back'?'groundBack':'groundPick';
    P[slot]=P[slot]?.key===x.key?null:groundSnap(P,x); if(!P.groundPick) P.groundBack=null;
    if(P.groundPick && S.plan.stages.length===1 && S.plan.stages.every(x=>x.groundPick)) setTimeout(()=>document.querySelector('.ground-next.ready')?.scrollIntoView({behavior:'smooth', block:'nearest'}),80);
    P.saved=null; runPlan(false); return;
  }
  const gs=e.target.closest('[data-ground-step]'); if(gs){ if(!S.plan) return; S.plan.groundStep=+gs.dataset.groundStep; runPlan(false); document.getElementById('planResults')?.scrollIntoView({behavior:'smooth', block:'start'}); return; }
  const gv=e.target.closest('[data-ground-save]'); if(gv){ saveGroundTrip(S.plan, gv.dataset.groundSave, gv.closest('.cs-save')?.querySelector('[data-trip-title]')?.value); return; }
  const to=e.target.closest('[data-trip-open]'); if(to){ e.preventDefault(); openTrip(to.dataset.tripOpen); return; }
  const fs=e.target.closest('[data-flight-step]'); if(fs){ const P=stageOf(fs); P.flightStep=+fs.dataset.flightStep; if(P.flightStep<4) P.planOpen=undefined; runPlan(false); document.querySelector('[data-sec="plane"]')?.scrollIntoView({behavior:'smooth', block:'start'}); return; }
  const of=e.target.closest('[data-open-flight]'); if(of){ const P=stageOf(of); P.planOpen=!P.planOpen; runPlan(false); return; }
  const pf=e.target.closest('[data-pick-flight]'); if(pf){ const P=stageOf(pf); if(pf.dataset.pickFlight==='out') P.selOut=pf.dataset.key; else P.selRet=pf.dataset.key; P.flightStep=1; runPlan(false); return; }
  const rd=e.target.closest('[data-radius]'); if(rd){ const sel=document.getElementById('plRadius'); sel.value=rd.dataset.radius; store('rzbus.plan.radius', rd.dataset.radius); document.getElementById('planForm').requestSubmit(); return; }
  const ap=e.target.closest('[data-acc-pick]'); if(ap){ const P=stageOf(ap); (P.accessPick||(P.accessPick=new Map())).set(ap.dataset.accPick, ap.dataset.accId); runPlan(false); return; }
  const jl=e.target.closest('[data-jl]'); if(jl){ openJourneyDetail(jl.dataset.jl); return; }
  const inf=e.target.closest('[data-pv-info]'); if(inf){ openInfo(inf.dataset.pvInfo); return; }
  const fp=e.target.closest('[data-page]'); if(fp){ stageOf(fp).flightPage=+fp.dataset.page; runPlan(false); return; }
  const tr=e.target.closest('[data-train]'); if(tr){ openTrain(tr.dataset.train); return; }
  const bp=e.target.closest('[data-back-page]');
  if(bp){ const P=stageOf(bp); if(!P?.round) return; const R=P.round; R.history=R.history||[];
    if(bp.dataset.backPage==='next'){ R.history.push(R.from||0); R.from=R.lastDep+60; } else R.from=R.history.pop()||0;
    runPlan(false); return; }
  const pp=e.target.closest('[data-plan-page]');
  if(pp){ const P=stageOf(pp); if(pp.dataset.planPage==='next'){ P.history.push(P.at); P.at=P.lastDep+60; } else P.at=P.history.pop(); runPlan(false); return; }
  const pl=e.target.closest('[data-place]'); if(pl){ const r=S.placeOptions; S.placeChoice[r.field]={q:r.q, place:r.choose[+pl.dataset.place], approximate:r.approximate}; document.getElementById('planForm').requestSubmit(); return; }
  const b=e.target.closest('[data-bus]'); if(b){ const v=S.vehicles.get(b.dataset.bus); if(v){ setMapOpen(true); map.setView([v.lat,v.lon],16); openBus(v.id);} return; }
  const rt=e.target.closest('[data-route]'); if(rt) openTripMap(S.planRoutes[+rt.dataset.route]);
});


/* ============================================================
   TRASA NA MAPIE: okno z przebiegiem wybranego połączenia
   ============================================================ */
const LEG_COLORS=['#DA291C','#1E5AA8','#1F7A4D'];
function shapeSlice(tid, i, j){
  const t=GT.trips.get(tid); const st=GT.stopTimes.get(tid);
  const stopPts=st.slice(i,j+1).map(x=>GT.stops.get(x.stop)).filter(Boolean).map(p=>[p.lat,p.lon]);
  const sh=t && t.shape && GT.shapes.get(t.shape);
  if(!sh || sh.length<2 || stopPts.length<2) return stopPts;
  const near=(pt,from)=>{ let bi=from, bd=1e12; for(let k=from;k<sh.length;k++){ const d=hav(pt,sh[k]); if(d<bd){bd=d;bi=k;} } return bi; };
  const a=near(stopPts[0],0), b=near(stopPts[stopPts.length-1],a);
  return b>a ? [stopPts[0], ...sh.slice(a,b+1), stopPts[stopPts.length-1]] : stopPts;
}
/* ---------- Trasa na mapie: każdy odcinek ma własny kolor, ikonę i przystanki ---------- */
const tripMapEl=document.getElementById('tripMapModal'), tripMapModal=new bootstrap.Modal(tripMapEl);
const TM={map:null, base:[], baseKey:null, layer:null, route:null, segments:[], tracks:null};
const WALK_COLOR='#1F7A4D', TRAIN_COLOR='#181818', CAR_COLOR='#5C5C5C', MAX_STATION_LABELS=12;
function stopLatLng(id){ const p=GT.stops.get(id); return p?[p.lat,p.lon]:null; }
function stationLatLng(id){ const s=RAIL_ST[id]; return s?[s[1],s[2]]:RAIL_BY_ID.get(+id)||null; }
function closestPoint(points, to){ return [...points].sort((a,b)=>hav(a,to)-hav(b,to))[0]||null; }
function walkSegment(a, b, title, sub){
  if(!a || !b || hav(a,b)<20) return null;
  return {mode:'walk', icon:'person-walking', color:WALK_COLOR, pts:[a,b], title, sub:sub||walkText(Math.round(hav(a,b))), stops:[]};
}
function carSegment(a, b, title, sub){
  if(!a || !b) return null;
  return {mode:'car', icon:'car', color:CAR_COLOR, pts:[a,b], title, sub:sub||`ok. ${fmtKm(hav(a,b)/1000*ROAD_FACTOR)}`, stops:[]};
}
function busSegment(l){
  const delay=(l.L&&l.L.delay)||0;
  const stops=l.st.slice(l.i,l.j+1).map(x=>({point:stopLatLng(x.stop), name:GT.stops.get(x.stop)?.name, time:l.base+x.dep+delay})).filter(s=>s.point);
  return {mode:'bus', icon:'bus', color:l.color, pts:shapeSlice(l.tid,l.i,l.j), title:`${AGENCY_NAMES[l.agency]||'Autobus'} ${l.short}: ${l.from} → ${l.to}`, sub:`${fmtClock(l.predDep)} – ${fmtClock(l.predArr)} · przystanki: ${stops.length}`, stops};
}
// Tor bierzemy z trasy, na której leży najwięcej stacji tego pociągu; bez takiej trasy łączymy stacje prostą.
function trackBetween(tracks, ids){
  const a=ids[0], b=ids[ids.length-1]; let best=null, score=0, span=Infinity;
  for(const t of tracks){
    const i=t.at[a], j=t.at[b]; if(i==null || j==null || i===j) continue;
    const on=ids.filter(id=>t.at[id]!=null).length, length=Math.abs(j-i);
    if(on>score || (on===score && length<span)){ score=on; span=length; best=i<j ? t.points.slice(i,j+1) : t.points.slice(j,i+1).reverse(); }
  }
  return best;
}
function trainSegment(r){
  const all=r.t.stops, route=all.slice(all.indexOf(r.a),all.indexOf(r.b)+1), start=railName(r.a.id), end=railName(r.b.id), stops=route.map(x=>({point:stationLatLng(x.id), name:railName(x.id), time:x===r.b?r.arr:x.predDep??x.predArr})).filter(s=>s.point);
  if(stops.length<2) return null;
  return {mode:'train', icon:'train', color:TRAIN_COLOR, pts:trackBetween(TM.tracks||[],route.map(x=>x.id))||stops.map(s=>s.point), title:`Pociąg ${r.t.label}: ${start} → ${end}`, sub:`${fmtClock(r.dep)} – ${fmtClock(r.arr)} · stacje: ${stops.length}`, stops};
}
function transitSegments(o, from, to, arrive='Dojdź na miejsce'){
  const out=[], l0=o.legs[0], lz=o.legs[o.legs.length-1];
  out.push(walkSegment(from, stopLatLng(l0.st[l0.i].stop), `Idź na przystanek ${l0.from}`, o.walkFrom&&walkText(o.walkFromM)));
  o.legs.forEach((l,k)=>{
    const prev=o.legs[k-1];
    if(prev) out.push(walkSegment(stopLatLng(prev.st[prev.j].stop), stopLatLng(l.st[l.i].stop), `Przesiadka: ${l.from}`));
    out.push(busSegment(l));
  });
  out.push(walkSegment(stopLatLng(lz.st[lz.j].stop), to, arrive, o.walkTo&&walkText(o.walkToM)));
  return out;
}
function tripSegments({kind, o, r, origin, dest, sub}){
  const a=origin.points[0], b=dest.points[0];
  if(kind==='walk') return [walkSegment(a,b,'Idź pieszo',sub)];
  if(kind==='car') return [carSegment(a,b,'Jedź samochodem',sub)];
  if(kind==='transit'){
    const l0=o.legs[0], lz=o.legs[o.legs.length-1], first=stopLatLng(l0.st[l0.i].stop), last=stopLatLng(lz.st[lz.j].stop);
    return transitSegments(o, o.walkFrom&&first?closestPoint(origin.points,first):null, o.walkTo&&last?closestPoint(dest.points,last):null);
  }
  const start=stationLatLng(railParts(r)[0].a.id), end=stationLatLng(r.b.id), out=[];
  if(r.access) out.push(...transitSegments(r.access, r.access.walkFrom&&start?closestPoint(origin.points,start):null, start, `Dojdź na stację ${r.from}`));
  else if(r.walkFrom) out.push(walkSegment(start&&closestPoint(origin.points,start), start, `Idź na stację ${r.from}`, walkText(r.walkFrom)));
  else if(r.startDist>RAIL_WALK_M || (r.startDist==null && isStreet(origin))) out.push(carSegment(start&&closestPoint(origin.points,start), start, `Dojedź na stację ${r.from}`));
  out.push(...railParts(r).map(trainSegment));
  if(r.egress) out.push(...transitSegments(r.egress, end, r.egress.walkTo&&end?closestPoint(dest.points,end):null));
  else if(r.walkTo>RAIL_WALK_M || (!r.walkTo && isStreet(dest))) out.push(carSegment(end, end&&closestPoint(dest.points,end), 'Dojedź do celu'));
  else if(r.walkTo) out.push(walkSegment(end, end&&closestPoint(dest.points,end), 'Dojdź do celu', walkText(r.walkTo)));
  return out;
}
const segmentMiddle=pts=>pts[Math.floor(pts.length/2)];
function segmentIcon(seg){ return L.divIcon({className:'bus-pin-wrap', html:`<span class="seg-icon" style="--k:${seg.color}"><i class="fa-solid fa-${seg.icon}" aria-hidden="true"></i></span>`, iconSize:[24,24], iconAnchor:[12,12]}); }
function endPin(point, color, html, cls){ return L.marker(point,{icon:L.divIcon({className:'bus-pin-wrap',html:`<div class="key-stop ${cls}" style="--k:${color}"><span class="ks-dot"></span><span class="ks-lbl">${html}</span></div>`,iconSize:[16,16],iconAnchor:[8,8]}), zIndexOffset:3000, interactive:false}); }
// Dojścia i dojazdy rysujemy od razu w linii prostej, a gdy przyjdzie prawdziwa droga, zastępujemy nią linię.
async function followStreets(seg, lines, icon){
  try{
    const r=await fetch(`/api/path?mode=${seg.mode}&from=${pointParam(seg.pts[0])}&to=${pointParam(seg.pts[seg.pts.length-1])}`); if(!r.ok) return;
    const {points}=await r.json(); if(!points?.length) return;
    seg.pts=points; lines.forEach(l=>l.setLatLngs(points)); icon.setLatLng(segmentMiddle(points));
  }catch(e){ console.warn('Droga na mapie', e); }
}
function drawTripRoute(){
  if(TM.layer) TM.map.removeLayer(TM.layer);
  const route=TM.route, segments=tripSegments(route).filter(s=>s&&s.pts.length>1), layers=[];
  TM.segments=segments;
  for(const seg of segments){
    const halo=L.polyline(seg.pts,{color:'#fff',weight:9,opacity:.9,interactive:false});
    const line=L.polyline(seg.pts,{color:seg.color,weight:5,opacity:1,dashArray:seg.mode==='walk'?'1 10':null}).bindTooltip(esc(seg.title),{className:'bus-tip',sticky:true});
    const icon=L.marker(segmentMiddle(seg.pts),{icon:segmentIcon(seg), zIndexOffset:2000, interactive:false});
    layers.push(halo,line,icon);
    seg.stops.forEach((s,k)=>{ const edge=k===0||k===seg.stops.length-1, named=seg.mode==='train'&&seg.stops.length<=MAX_STATION_LABELS;
      layers.push(L.circleMarker(s.point,{radius:edge?6:4,color:seg.color,weight:edge?3:2,fillColor:'#fff',fillOpacity:1}).bindTooltip(`${esc(s.name)} · ${fmtClock(s.time)}`,{className:named?'station-tip':'bus-tip',direction:named?'bottom':'top',permanent:named})); });
    if(seg.mode==='walk'||seg.mode==='car') followStreets(seg,[halo,line],icon);
  }
  const first=segments[0], last=segments[segments.length-1];
  if(first) layers.push(endPin(first.pts[0],'#DA291C',`<b>Start</b> ${esc(route.origin.label)}`,'start'));
  if(last) layers.push(endPin(last.pts[last.pts.length-1],'#181818',`<b>Cel</b> ${esc(route.dest.label)}`,'end'));
  const live=trainMarkers(route); layers.push(...live.layers);
  TM.layer=L.layerGroup(layers).addTo(TM.map);
  document.getElementById('tripMapInfo').innerHTML=segments.length?`${live.note?`<div class="trip-estimate">${esc(live.note)}</div>`:''}<div class="small text-soft mb-2">Kliknij odcinek, aby go przybliżyć.</div>${segments.map((s,i)=>`<button type="button" class="seg-row" data-seg="${i}"><span class="seg-icon" style="--k:${s.color}"><i class="fa-solid fa-${s.icon}" aria-hidden="true"></i></span><span><b>${esc(s.title)}</b><small>${esc(s.sub)}</small>${s.mode==='train'?`<ol class="seg-stops">${s.stops.map(x=>`<li><time>${fmtClock(x.time)}</time> ${esc(x.name)}</li>`).join('')}</ol>`:''}</span></button>`).join('')}`:'<div class="empty-note">Nie mamy współrzędnych tej trasy.</div>';
  fitTripSegments(segments);
}
function fitTripSegments(segments){ const pts=segments.flatMap(s=>s.pts); if(pts.length) TM.map.fitBounds(L.latLngBounds(pts),{padding:[50,50],maxZoom:17}); }
function openTrainMap(key){
  const t=TR.trains.find(x=>x.key===key); if(!t) return;
  const a=t.stops[0], b=t.stops[t.stops.length-1];
  openTripMap({kind:'train', r:{t, a, b, dep:a.predDep, arr:b.predArr??b.predDep, from:t.from, to:t.to}, origin:{label:`${t.label}: ${t.from}`, points:[]}, dest:{label:t.to, points:[]}, wholeTrain:true});
}
// PKP nie podaje GPS pociągów, więc miejsce wyliczamy z rozkładu i ostatniego opóźnienia.
function trainMarkers(route){
  if(route.kind!=='train') return {layers:[], note:''};
  const running=railParts(route.r).map(part=>({t:part.t, pos:trainPosition(part.t)})).filter(x=>x.pos);
  const layers=running.map(({t,pos})=>L.marker([pos.lat,pos.lon],{icon:segmentIcon({color:'#DA291C', icon:'train'}), zIndexOffset:2500}).bindTooltip(`${esc(t.label)} · pozycja szacunkowa`,{className:'bus-tip',direction:'top',permanent:true}));
  const note=running.length?'Pozycja pociągu jest szacunkowa: PKP nie udostępnia GPS, więc liczymy ją z rozkładu i ostatniego opóźnienia.':route.wholeTrain?'Ten pociąg nie jest teraz w trasie.':'';
  return {layers, note};
}
function openTripMap(route){
  TM.route=route;
  document.getElementById('tripMapTitle').textContent=`${route.origin.label} → ${route.dest.label}`;
  tripMapModal.show();
}
async function loadRailTracks(){
  try{ const r=await fetch('/assets/app.rail-tracks.json'); if(!r.ok) throw new Error('HTTP '+r.status); TM.tracks=await r.json(); }
  catch(e){ console.warn('Tory na mapie', e); TM.tracks=[]; }
}
tripMapEl.addEventListener('shown.bs.modal', async ()=>{
  if(!TM.map){ TM.map=L.map('tripMap',{zoomControl:true, maxZoom:20}).setView(RZ_CENTER,13); TM.map.attributionControl.setPrefix(false); }
  TM.map.invalidateSize(); pickBaseLayer(TM.map,TM);
  if(!TM.tracks && TM.route.kind==='train') await loadRailTracks();
  drawTripRoute();
});
document.getElementById('tripMapInfo').addEventListener('click', e=>{ const b=e.target.closest('[data-seg]'); if(b) fitTripSegments([TM.segments[+b.dataset.seg]]); });
function resetMapView(){
  clearRouteLayer(); S.query=''; S.lineSet=null; document.getElementById('mapTitle').textContent=VIEWS[S.agency].map||'Mapa na żywo'; document.getElementById('lineSearch').value='';
  renderMarkers(); renderLateList(); renderLineNotice();
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
function pickBaseLayer(m, B=PK){
  const key=pickBaseKey(); if(B.baseKey===key && B.base.length) return;
  B.baseKey=key; for(const l of B.base) m.removeLayer(l); B.base=[];
  const addProvider=(provKey)=>{ const prov=TILE_PROVIDERS[provKey]||TILE_PROVIDERS.esri; const defs=(isDark()&&prov.dark)?prov.dark:prov.light;
    defs.forEach((d,i)=>{ const layer=new SmartTiles(d.url,{maxZoom:19, maxNativeZoom:d.maxNative||19, subdomains:d.sub||'abc', attribution:i===0?prov.attr:''}); layer.addTo(m); layer.bringToBack(); B.base.push(layer); }); };
  if(CFG.tiles==='podavo' && !isDark()){
    PODAVO_MAP.podavoLayer().then(l=>{ if(B.baseKey!==key) return; l.addTo(m); B.base.push(l); }).catch(()=>{ if(B.baseKey===key) addProvider('esri'); });
    return;
  }
  if(CFG.tiles==='google' && CFG.gkey && !gmFailed){
    ensureGoogle(CFG.gkey).then(()=>{
      if(B.baseKey!==key) return;
      const g=L.gridLayer.googleMutant({type:'roadmap', maxZoom:20, styles: isDark()?GM_DARK:[{featureType:'poi',stylers:[{visibility:'off'}]}]});
      g.addTo(m); if(CFG.traffic) g.addGoogleLayer('TrafficLayer'); B.base.push(g);
    }).catch(()=>{ if(B.baseKey===key) addProvider('esri'); });
  } else addProvider(CFG.tiles==='google'||CFG.tiles==='podavo' ? 'esri' : CFG.tiles);
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
  if(!PK.map){ PK.map=L.map('pickMap',{zoomControl:true, maxZoom:20}).setView(RZ_CENTER,13); PK.map.attributionControl.setPrefix(false); }
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
// Stacje w całej Polsce, tylko do rysowania tras i liczenia odległości.
// Nazwy z tej listy służą też za zapas, gdy słownik stacji z rozkładu PKP PLK przyjdzie pusty.
const RAIL_BY_ID=new Map(), RAIL_BY_NAME=new Map(), RAIL_NAMES=new Map();
let railStationsLoading=null;
async function loadRailStations(){
  try{
    const r=await fetch('/assets/app.rail-stations.json'); if(!r.ok) throw new Error('HTTP '+r.status);
    for(const [id,name,lat,lon] of await r.json()){
      if(!RAIL_BY_ID.has(id)){ RAIL_BY_ID.set(id,[lat,lon]); RAIL_BY_NAME.set(name,[lat,lon]); }
      RAIL_NAMES.set(id,name); if(!TR.names.has(id)) TR.names.set(id,name); // wyszukiwarka stacji korzysta z TR.names
    }
    if(TR.trains.length){ renderBoard(); renderTrainRoute(); }
    applySavedCity();
  }
  catch(e){ console.warn('Stacje kolejowe', e); }
}
const RAIL_IDS = Object.keys(RAIL_ST).filter(k=>RAIL_ST[k][3]).map(Number);
const RAIL_SEARCH_HOURS = 24, RAIL_BY_HOURS = 14; // cała doba odjazdów, kolejne strony pod „Późniejsze”
const HOME_STATION_ID = 82669;
const TR = {mode:'off', trains:[], days:new Map(), shifted:new Map(), names:new Map(), carriers:new Map(), err:null, ts:null, timer:null, station:HOME_STATION_ID, query:'', tab:'dep', sel:null, busy:false};
const TRAIN_STATUS = {S:'jeszcze nie wyruszył', P:'w trasie', C:'zakończył bieg', X:'odwołany', Q:'częściowo odwołany'};
function railName(id){ return TR.names.get(+id) || (RAIL_ST[id]&&RAIL_ST[id][0]) || RAIL_NAMES.get(+id) || ('stacja '+id); }
function ymdOf(off){ const d=dayInfo(off); return d.ymd.slice(0,4)+'-'+d.ymd.slice(4,6)+'-'+d.ymd.slice(6,8); }
function dateMid(dstr){ const x=String(dstr).slice(0,10).split('-').map(Number); return midnightEpoch(x[0],x[1],x[2]); }
function parseLocalDT(v){
  if(!v) return null; const s=String(v);
  if(/(Z|[+-]\d\d:?\d\d)$/.test(s)) { const t=Date.parse(s); return isNaN(t)?null:t/1000; }
  const m=s.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/); if(!m) return null;
  return midnightEpoch(+m[1],+m[2],+m[3]) + (+m[4])*3600 + (+m[5])*60 + (+(m[6]||0));
}
function dictVal(v){ return v==null ? null : (typeof v==='string' ? v : (v.name||v.nm||v.description||null)); }
async function plkGet(route, params){
  const r=await withTimeout(fetch('/api/plk/'+route+(params?'?'+new URLSearchParams(params):'')), 30000);
  if(r.ok){ if(route==='operations') TR.fetchedAt=Date.parse(r.headers.get('x-fetched-at'))/1000||null; return r.json(); }
  const error=new Error((await r.json().catch(()=>null))?.error||'Dane PKP PLK nie są jeszcze gotowe.');
  error.fatal=r.status===503||r.status===429||r.status===401||r.status===403;
  throw error;
}
// Serwer trzyma rozkład całego kraju w zwartej postaci; przeglądarka pobiera go raz i sprawdza tylko, czy się zmienił.
async function plkSchedules(){
  const today=ymdOf(0), [current, previous]=await Promise.all([plkGet('schedules',{date:today}), plkGet('schedules',{date:ymdOf(-1)}).catch(e=>{ console.warn('Rozkład z wczoraj', e.message); return null; })]);
  return {today, days:[...(previous?[{date:ymdOf(-1), data:previous}]:[]), {date:today, data:current}]}; // wczorajszy jest tylko dla pociągów jadących po północy
}
function addRailDictionary(data){
  for(const [id,name,lat,lon] of data.stations){
    TR.names.set(id,name);
    if(lat!=null && !RAIL_BY_ID.has(id)){ RAIL_BY_ID.set(id,[lat,lon]); RAIL_BY_NAME.set(name,[lat,lon]); }
  }
  for(const [code,name] of data.carriers) TR.carriers.set(code,name);
}
function buildTrains(days, ops){
  const out=[], opsBy=new Map(), today=ymdOf(0), mid=todayMidnight();
  for(const o of ops||[]) opsBy.set(`${o[0]}/${o[1]}|${o[2]}`, o);
  for(const {date,data} of days){
    addRailDictionary(data);
    const base=dateMid(date);
    for(const [sid,oid,cat,num,name,carrier,stops] of data.trains){
      const tail=stops[stops.length-1];
      if(date<today && base+(tail[1]??tail[2])<mid) continue; // z wczoraj zostają tylko pociągi jadące po północy
      const key=`${sid}/${oid}|${date}`, o=opsBy.get(key), live=new Map((o?o[4]:[]).map(x=>[x[0],x]));
      out.push(finishTrain({key, date, cat, num, name, carrier, status:o?o[3]:null, stops:stops.map(([id,arr,dep,pl,tr])=>{ const q=live.get(id);
        return {id, pArr:arr==null?null:base+arr, pDep:dep==null?null:base+dep, aArr:parseLocalDT(q&&q[3]), aDep:parseLocalDT(q&&q[4]), dArr:q?q[1]:null, dDep:q?q[2]:null, cf:!!(q&&q[5]), cn:!!(q&&q[6]), pl:pl||'', tr:tr||''}; })}));
    }
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
// PKP nie zawsze oznacza koniec biegu, więc pociąg znika też kilka minut po przyjeździe na stację końcową.
const TRAIN_GONE_SEC=300;
function trainEnded(t, now){
  const last=t.stops[t.stops.length-1], end=last && (last.aArr||last.predArr||last.pArr);
  return end!=null && end<now-TRAIN_GONE_SEC;
}
function trainPosition(t){
  const now=nowSec(); const st=t.stops;
  if(t.cancelled || t.status==='C' || trainEnded(t,now)) return null;
  let i=-1; for(let k=0;k<st.length;k++){ const x=st[k]; const left = x.aDep || (x.cf && x.predDep) || (x.predDep && x.predDep<=now ? x.predDep : null); if(left && left<=now) i=k; else if((x.predArr||x.predDep) > now) break; }
  if(i<0){ const a=st[0], first=a&&stationLatLng(a.id); if(first && a.predDep && a.predDep-now<600 && a.predDep>now-60) return {lat:first[0], lon:first[1], at:a.id, next:st[1]&&st[1].id, bearing:null, waiting:true}; return null; }
  const A=st[i], B=st[i+1];
  if(!B) return null;
  const ca=stationLatLng(A.id), cb=stationLatLng(B.id);
  const t0=A.aDep || A.predDep, t1=B.aArr || B.predArr || B.predDep;
  if(ca && cb && t0 && t1){ const f=Math.min(1,Math.max(0,(now-t0)/Math.max(60,t1-t0))); return {lat:ca[0]+(cb[0]-ca[0])*f, lon:ca[1]+(cb[1]-ca[1])*f, at:null, next:B.id, bearing:bearingOf(ca,cb)}; }
  if(ca && !cb && now-t0<120) return {lat:ca[0], lon:ca[1], at:A.id, next:B.id, bearing:null};
  if(!ca && cb && t1-now<240 && t1-now>-60) return {lat:cb[0], lon:cb[1], at:null, next:B.id, bearing:null, approaching:true};
  return null;
}
function trainDelayNow(t){ let d=null; for(const x of t.stops){ if(x.cf || x.aDep || x.aArr) d=x.delay; } if(d==null){ const n=t.stops.find(x=>x.delay!=null); d=n?n.delay:null; } return d; }
/* ---------- tablica odjazdów / przyjazdów ---------- */
const foldText=text=>String(text).toLowerCase().replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
// Szukamy też po stacjach na trasie: „Kraków” znajdzie pociąg do Przemyśla z Wrocławia przez Kraków.
function boardMatches(row, query){
  if(!query) return true;
  const t=row.t;
  t.searchText??=foldText([t.cat, t.num, t.label, t.name, t.from, t.to, TR.carriers.get(t.carrier), ...t.stops.map(x=>railName(x.id))].filter(Boolean).join(' '));
  return t.searchText.includes(foldText(query));
}
function boardRows(stationId, kind){
  const rows=[], mid=todayMidnight(), many=typeof stationId?.has==='function';
  for(const t of TR.trains){
    const idx=many?t.stops.findIndex((x,i)=>stationId.has(x.id) && (kind==='dep'?i<t.stops.length-1&&!stationId.has(t.stops[i+1]?.id):i>0)):t.stops.findIndex(x=>x.id===stationId); if(idx<0) continue;
    const x=t.stops[idx];
    if(kind==='dep'){ if(idx===t.stops.length-1 || x.pDep==null) continue; }
    else { if(idx===0 || x.pArr==null) continue; }
    const plan = kind==='dep'?x.pDep:x.pArr, pred = kind==='dep'?x.predDep:x.predArr;
    if(plan<mid || plan>=mid+86400) continue;
    rows.push({t, x, idx, plan, pred, delay:x.delay, cn: x.cn || t.cancelled, ...(many?{station:railName(x.id)}:{})});
  }
  return rows.sort((a,b)=>a.pred-b.pred);
}
const foldedNames=new Map();
function foldedStation(id){ if(!foldedNames.has(id)) foldedNames.set(id,foldText(railName(id))); return foldedNames.get(id); }
// „Wszystkie stacje”: jeden wiersz na pociąg, przy szukanej stacji albo przy najbliższej, najchętniej w okolicy Rzeszowa.
function trainRowStop(t, kind, now, query){
  const mid=todayMidnight(), last=t.stops.length-1;
  const ahead=t.stops.map((x,idx)=>({x,idx})).filter(({x,idx})=>{
    const plan=kind==='dep'?x.pDep:x.pArr, pred=kind==='dep'?x.predDep:x.predArr;
    return plan!=null && plan>=mid && plan<mid+86400 && pred>=now-90 && (kind==='dep'?idx<last:idx>0);
  });
  const near=ahead.find(({x})=>RAIL_ST[x.id]);
  if(!query) return near||ahead[0]||null;
  const q=foldText(query), isStop=x=>foldedStation(x.id).includes(q);
  if(t.stops.some(isStop)) return ahead.find(({x})=>isStop(x))||null; // minął już tę stację, więc nie jest wynikiem
  return near||ahead[0]||null;
}
function allStationRows(kind, query, now){
  const rows=[];
  for(const t of TR.trains){
    const stop=trainRowStop(t,kind,now,query); if(!stop) continue;
    const {x,idx}=stop;
    rows.push({t, x, idx, plan:kind==='dep'?x.pDep:x.pArr, pred:kind==='dep'?x.predDep:x.predArr, delay:x.delay, cn:x.cn||t.cancelled, station:railName(x.id)});
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
  const modeTxt = TR.mode==='live' ? `Dane PKP PLK · aktualizacja ${TR.ts?fmtClock(TR.ts):'—'} · co 20 min` : TR.mode==='demo' ? 'Przykładowe dane (brak klucza PKP PLK lub brak połączenia)' : TR.mode==='loading' ? 'Pobieranie danych PKP PLK…' : '';
  info.innerHTML = (TR.station==='all'||TR.station==='city'?'':favButton({type:'stop',view:'kolej',name:railName(TR.station)})+' ') + esc(modeTxt) + (TR.err?` · <span class="txt-red">${esc(TR.err)}</span>`:'');
  const banner = TR.mode==='demo' ? `<div class="line-notice" style="margin:0 0 12px"><div><span class="ln-badge off">i</span>Nie udało się pobrać danych PKP PLK — pokazuję przykładowy rozkład.</div></div>` : '';
  const now=nowSec(), all=(TR.station==='all'?allStationRows(TR.tab,TR.query,now):boardRows(TR.station==='city'?(TR.cityIds||new Set()):TR.station,TR.tab)).filter(r=>r.pred>=now-90 && boardMatches(r,TR.query));
  const p=paginate(all, TR.page??1, BOARD_PAGE), rows=p.rows;
  if(!rows.length){ el.innerHTML = banner+`<div class="empty-note">${TR.mode==='loading'?'':stateIll(assetPaths.noDepartures)}${TR.query?`Brak pociągów dla „${esc(TR.query)}” do końca dnia.`:`Brak kolejnych ${TR.tab==='dep'?'odjazdów':'przyjazdów'} dzisiaj${TR.mode==='loading'?' (wczytywanie…)':''}.`}</div>`; }
  else el.innerHTML = banner + `<div class="board">` + rows.map(r=>{ const t=r.t; const changed = r.delay!=null && Math.abs(r.delay)>=1 && !r.cn;
    return `<div class="board-row ${r.cn?'cancel':''}" data-train="${esc(t.key)}">
      <span class="br-time"><b class="${changed&&statusOf(r.delay*60)==='late'?'txt-red':''}">${fmtClock(r.pred)}</b>${changed?`<s>${fmtClock(r.plan)}</s>`:''}<small>${inMin(r.pred)}</small></span>
      <span class="br-train"><span class="tr-cat">${esc(t.cat||'POC')}</span> <b>${esc(t.num)}</b>${t.name?` <i>„${esc(t.name)}”</i>`:''} ${trainStar(t)}<small>${esc(TR.carriers.get(t.carrier)||t.carrier||'')}</small></span>
      <span class="br-dir">${TR.tab==='dep'?'→ '+esc(t.to):'z: '+esc(t.from)}<small>${r.station?'stacja: '+esc(r.station):TR.tab==='dep'?'z: '+esc(t.from):'→ '+esc(t.to)}</small></span>
      <span class="br-pl">${r.x.pl?`peron <b>${esc(r.x.pl)}</b>`:''}${r.x.tr?` tor <b>${esc(r.x.tr)}</b>`:''}${!r.x.pl&&!r.x.tr?'<small>peron —</small>':''}</span>
      <span class="br-st">${trainDelayChip(r.delay, r.cn)}<small>${esc(TRAIN_STATUS[t.status]||'')}</small><button class="btn-ghost br-map" type="button" data-map="${esc(t.key)}"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> Na mapie</button></span>
    </div>`; }).join('') + `</div>` + pagerHtml(p, false);
}
/* ---------- Linie kolejowe miasta: kierunki pociągów, które dziś odjeżdżają z jego stacji ---------- */
function trainLines(ids, now=nowSec()){
  const by=new Map();
  for(const r of boardRows(ids,'dep')){
    const key=r.t.to||'?'; let g=by.get(key);
    if(!g){ g={to:key, count:0, next:null, cats:new Set(), via:new Map()}; by.set(key,g); }
    g.count++; g.cats.add(r.t.cat||'POC');
    if(r.pred>=now-60 && (g.next==null || r.pred<g.next)) g.next=r.pred;
    for(const x of r.t.stops.slice(r.idx+1, -1)){ const n=railName(x.id); g.via.set(n,(g.via.get(n)||0)+1); }
  }
  return [...by.values()].map(g=>({to:g.to, count:g.count, next:g.next, cats:[...g.cats].sort(), via:[...g.via].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n])=>n)})).sort((a,b)=>b.count-a.count||a.to.localeCompare(b.to,'pl'));
}
function renderTrainLines(){
  const el=document.getElementById('trLines'); if(!el) return;
  if(CFG.trains===false){ el.innerHTML='<div class="empty-note">Pociągi są wyłączone w Ustawieniach.</div>'; return; }
  if(!TR.trains.length){ el.innerHTML=searching(L2('Wczytuję rozkład pociągów…','Loading train timetable…')); return; }
  const ids=TR.cityIds?.size?TR.cityIds:new Set([HOME_STATION_ID]);
  const list=trainLines(ids);
  if(!list.length){ el.innerHTML=`<div class="empty-note">${L2(`Dziś nie ma już odjazdów pociągów z miasta ${TCITY.name}.`,`No more trains leave ${TCITY.name} today.`)}</div>`; return; }
  el.innerHTML=`<div class="trl-list">${list.map(l=>`<button type="button" class="trl-item" data-trl-to="${esc(l.to)}"><b>${esc(TCITY.name)} → ${esc(l.to)}</b>
    <small>${l.count} ${L2(l.count===1?'pociąg dziś':l.count<5?'pociągi dziś':'pociągów dziś', l.count===1?'train today':'trains today')}${l.next!=null?` · ${L2('najbliższy','next')} ${fmtClock(l.next)}`:''}</small>
    ${l.via.length?`<small>${L2('przez','via')} ${esc(l.via.join(', '))}</small>`:''}
    <span class="trl-cats">${l.cats.map(c=>`<span class="tr-cat">${esc(c)}</span>`).join('')}</span></button>`).join('')}</div>`;
}
document.getElementById('trLines')?.addEventListener('click', e=>{
  const b=e.target.closest('[data-trl-to]'); if(!b) return;
  document.getElementById('trFrom').value=TCITY.name; document.getElementById('trTo').value=b.dataset.trlTo;
  goPage('kolej','');
  setTimeout(()=>document.getElementById('trRouteForm').requestSubmit(),30);
});
/* ---------- Połączenie skąd–dokąd i podpowiedzi stacji oraz miast ---------- */
const ROUTE_PAGE=15;
// Miasto to nazwa z co najmniej dwiema stacjami i własną stacją główną, dzięki czemu „Nowy” z „Nowego Targu” nim nie jest.
function findRailCities(names){
  const known=new Set(names), count=new Map();
  for(const name of names){ const words=name.split(' '); for(let k=1;k<=Math.min(2,words.length);k++){ const prefix=words.slice(0,k).join(' '); count.set(prefix,(count.get(prefix)||0)+1); } }
  const cities=[...count].filter(([prefix,n])=>n>=2 && [prefix,`${prefix} Główny`,`${prefix} Główna`,`${prefix} Centralna`,`${prefix} Miasto`].some(name=>known.has(name))).map(([prefix])=>prefix);
  return cities.filter(city=>!cities.includes(city.split(' ')[0]) || !city.includes(' ')); // „Kraków Bieżanów” to dzielnica Krakowa
}
function railCities(){
  const names=railStationNames();
  if(TR.cities?.names!==names) TR.cities={names, list:findRailCities(names)};
  return TR.cities.list;
}
function railSuggestions(text){
  const q=foldText(text), starts=name=>foldText(name).startsWith(q), hits=list=>[...list.filter(starts), ...list.filter(name=>!starts(name) && foldText(name).includes(' '+q))];
  return [...hits(railCities()).slice(0,3).map(label=>({label, kind:'miasto'})), ...hits(railStationNames().filter(name=>name!==name.toUpperCase())).slice(0,8).map(label=>({label, kind:'stacja'}))];
}
// Wpisane miasto to wszystkie jego stacje, a wpisana stacja to dokładnie ona.
function railPlaceNames(text, names, cities){
  const q=foldText(text.trim()); if(!q) return [];
  const inCity=names.filter(name=>{ const l=foldText(name); return l===q || l.startsWith(q+' '); });
  if(cities.some(city=>foldText(city)===q)) return inCity;
  const exact=names.find(name=>foldText(name)===q); if(exact) return [exact];
  return inCity.length ? inCity : names.filter(name=>foldText(name).includes(q)).slice(0,6);
}
const isCityMain=name=>/ (Główn[ya]|Centralna)$/.test(name);
// Pociąg do Krakowa kończy podróż na Głównym, nawet jeśli Płaszów mija wcześniej; inne stacje liczą się, gdy główna nie ma połączenia.
function routeStations(names){ const main=names.filter(isCityMain); return main.length?main:names; }
function routeWindow(date, fromTime, toTime, today, base, now){
  const clock=value=>{ const [h,m]=value.split(':').map(Number); return base+h*3600+m*60; };
  const start=fromTime ? clock(fromTime) : (date && date>today ? base : now);
  let end=toTime ? clock(toTime) : (date && date>today && !fromTime ? base+86400 : start+RAIL_SEARCH_HOURS*3600);
  if(end<=start) end+=86400;
  return {start, end};
}
function connectionRoute(parts){
  const first=parts[0], last=parts[parts.length-1];
  return {t:first.t, a:first.a, b:last.b, dep:first.dep, arr:last.arr, from:railName(first.a.id), to:railName(last.b.id), walkFrom:0, walkTo:0, startDist:null, access:null, egress:null, parts:parts.length>1?parts:null, doorArr:last.arr, leave:first.dep, showStations:true};
}
function renderTrainRoute(){
  const el=document.getElementById('trRouteResults'), R=TR.route;
  if(!R){ el.innerHTML=''; return; }
  const head=`<div class="plan-head"><span>${esc(R.fromLabel)} <span class="txt-red">→</span> ${esc(R.toLabel)}</span><span class="text-soft">${fmtDay(dayOfTs(R.start))} · ${R.end-R.start>=86400?'cały dzień':`odjazd ${fmtClock(R.start)} – ${fmtClock(R.end)}`}</span></div>`;
  const trains=trainsAround(R.start);
  if(!trains){ el.innerHTML=head+'<div class="empty-note">Sprawdzam rozkład pociągów…</div>'; return; }
  if(R.searched!==TR.trains){ // szukamy raz na dane, a nie przy każdym odświeżeniu widoku
    const starts=new Map(R.from.map(id=>[id,R.start])), search=to=>railConnections(trains, starts, new Set(to), R.end, new Set(R.fromMain));
    R.found=search(R.toMain); if(!R.found.length) R.found=search(R.to);
    R.searched=TR.trains;
  }
  const found=R.found, p=paginate(found, R.page||1, ROUTE_PAGE), card={from:R.fromLabel, to:R.toLabel, open:R.open}, origin={label:R.fromLabel, points:[]}, dest={label:R.toLabel, points:[]};
  S.planRoutes=[];
  el.innerHTML=head+(found.length?`<div class="small text-soft mb-2">Połączenia: ${found.length}</div>${p.rows.map(parts=>trainCard(connectionRoute(parts),card,origin,dest)).join('')}${pagerHtml(p,false)}`:'<div class="empty-note">Brak połączeń w tym czasie. Spróbuj szerszego przedziału godzin.</div>');
}
function clearTrainRoute(){ TR.route=null; document.getElementById('trRouteForm').reset(); document.getElementById('trRouteErr').textContent=''; renderTrainRoute(); }
document.getElementById('trRouteForm').addEventListener('submit', e=>{
  e.preventDefault();
  const err=document.getElementById('trRouteErr'), value=id=>document.getElementById(id).value; err.textContent=''; TR.route=null; renderTrainRoute();
  const names=railStationNames(), cities=railCities(), from=railPlaceNames(value('trFrom'),names,cities), to=railPlaceNames(value('trTo'),names,cities);
  if(!value('trFrom').trim() || !value('trTo').trim()){ err.textContent='Wpisz stację lub miasto w obu polach.'; return; }
  if(!from.length || !to.length){ err.textContent=`Nie znaleziono: ${!from.length?value('trFrom'):value('trTo')}.`; return; }
  if(from.some(name=>to.includes(name))){ err.textContent='Stacja początkowa i docelowa są takie same.'; return; }
  const today=ymdOf(0), date=value('trDate');
  if(date>lastPlanDay()){ err.textContent=`Rozkład sięga do ${fmtDay(lastPlanDay())}.${lastPlanDay().slice(0,4)}.`; return; }
  const off=date && date>today ? Math.round((Date.parse(date)-Date.parse(today))/86400000) : 0;
  TR.route={fromLabel:value('trFrom').trim(), toLabel:value('trTo').trim(), from:stationIds(from), to:stationIds(to), open:new Set(), fromMain:stationIds(routeStations(from)), toMain:stationIds(routeStations(to)), ...routeWindow(date,value('trFromTime'),value('trToTime'),today,dayInfo(off).base,nowSec())};
  document.getElementById('trRouteResults').innerHTML='<div class="empty-note">Szukam połączeń…</div>';
  setTimeout(renderTrainRoute,20);
});
document.getElementById('trRouteResults').addEventListener('click', e=>{
  const pg=e.target.closest('[data-page]'); if(pg){ TR.route.page=+pg.dataset.page; renderTrainRoute(); return; }
  const ex=e.target.closest('[data-expand]'); if(ex){ toggleCard(ex,TR.route.open); return; }
  const rt=e.target.closest('[data-route]'); if(rt){ openTripMap(S.planRoutes[+rt.dataset.route]); return; }
  const b=e.target.closest('[data-train]'); if(b) openTrain(b.dataset.train);
});
attachSuggest(document.getElementById('trFrom'), {local:railSuggestions});
attachSuggest(document.getElementById('trTo'), {local:railSuggestions});
attachSuggest(document.getElementById('trSearch'), {local:railSuggestions, onPick:it=>{ TR.query=it.label; TR.page=null; renderBoard(); }});
document.getElementById('trainBoard').addEventListener('click', e=>{ const onMap=e.target.closest('[data-map]'); if(onMap){ openTrainMap(onMap.dataset.map); return; } const pg=e.target.closest('[data-page]'); if(pg){ TR.page=+pg.dataset.page; renderBoard(); return; } if(e.target.closest('[data-page-now]')){ TR.page=null; renderBoard(); return; } const b=e.target.closest('[data-train]'); if(b) openTrain(b.dataset.train); });
document.getElementById('trStation').innerHTML = '<option value="all">Wszystkie stacje</option>' + RAIL_IDS.slice().sort((a,b)=>(b===82669)-(a===82669) || RAIL_ST[a][0].localeCompare(RAIL_ST[b][0],'pl')).map(id=>`<option value="${id}">${esc(RAIL_ST[id][0])}</option>`).join('');
document.getElementById('trStation').value=String(TR.station);
document.getElementById('trStation').addEventListener('change', e=>{ TR.station=['all','city'].includes(e.target.value)?e.target.value:+e.target.value; TR.page=null; renderBoard(); });
document.getElementById('trSearch').addEventListener('input', e=>{ TR.query=e.target.value.trim(); TR.page=null; renderBoard(); });
document.getElementById('trReset').addEventListener('click', ()=>{ clearTrainRoute(); TR.query=''; document.getElementById('trSearch').value=''; if(!applyCity(TCITY.name)){ TR.station=HOME_STATION_ID; document.getElementById('trStation').value=String(HOME_STATION_ID); } document.querySelector('[data-trtab="dep"]').click(); });
document.querySelectorAll('[data-trtab]').forEach(b=>b.addEventListener('click', ()=>{ TR.tab=b.dataset.trtab; TR.page=null; document.querySelectorAll('[data-trtab]').forEach(x=>x.classList.toggle('active', x===b)); renderBoard(); }));
/* ---------- połączenia kolejowe (bezpośrednie) ---------- */
function railStationNames(){
  if(TR.nameList?.size!==TR.names.size) TR.nameList={size:TR.names.size, names:[...new Set([...Object.values(RAIL_ST).map(s=>s[0]), ...TR.names.values()])].sort(natSort)};
  return TR.nameList.names;
}
function resolveStation(txt){
  const q=(txt||'').trim().toLowerCase(); if(!q) return null;
  const names=railStationNames();
  return names.find(n=>n.toLowerCase()===q) || names.filter(n=>n.toLowerCase().startsWith(q)).sort((a,b)=>a.length-b.length)[0] || names.filter(n=>n.toLowerCase().includes(q)).sort((a,b)=>a.length-b.length)[0] || null;
}
// Mapa i tablice trzymają tylko wczoraj i dziś, więc rozkład na inny dzień pobieramy, gdy podróż go potrzebuje.
async function loadRailDay(date){
  TR.days.set(date,null);
  try{ TR.days.set(date, buildTrains([{date, data:await plkGet('schedules',{date})}], null)); }
  catch(e){ console.warn('Rozkład pociągów', date, e); TR.days.set(date,[]); }
  if(S.plan) runPlan(false);
  renderTrainRoute();
}
function trainsAround(at){
  if(TR.mode==='loading') return null;
  if(TR.mode!=='live') return TR.trains;
  const off=Math.floor((at-todayMidnight())/86400), days=[off,off+1].filter(d=>d>0 && d<=PLAN_DAYS_AHEAD);
  const loaded=days.map(railDayTrains);
  return loaded.includes(null) ? null : [...TR.trains, ...loaded.flat()];
}
// PKP PLK publikuje rozkład kilka miesięcy naprzód. Dalszy dzień bierze pociągi z tego samego dnia tygodnia
// z najpóźniejszego dostępnego rozkładu, a kroki podróży mówią, z którego dnia jest ten rozkład.
function railDayTrains(off){
  if(off<=RAIL_DAYS_AHEAD){ const d=ymdOf(off); if(!TR.days.has(d)) loadRailDay(d); return TR.days.get(d); }
  const key=ymdOf(off); if(TR.shifted.has(key)) return TR.shifted.get(key);
  const proxyOff=off-7*Math.ceil((off-RAIL_DAYS_AHEAD)/7), base=railDayTrains(proxyOff); if(base==null) return null;
  const delta=dayInfo(off).base-dayInfo(proxyOff).base, from=ymdOf(proxyOff), move=v=>v==null?null:v+delta;
  const out=base.map(t=>({...t, key:t.key+'@'+key, date:key, proxy:from, stops:t.stops.map(x=>({...x, pArr:move(x.pArr), pDep:move(x.pDep), predArr:move(x.predArr), predDep:move(x.predDep), aArr:null, aDep:null, delay:null}))}));
  TR.shifted.set(key,out); return out;
}
/* ---------- Wyszukiwarka połączeń kolejowych z przesiadkami ---------- */
const RAIL_TRANSFER_SEC=480, MAX_RAIL_WAIT_SEC=3*3600, MAX_RAIL_TRAINS=3, RAIL_OPTIONS=5, RAIL_CHANGE_GAIN_SEC=900;
// Kolejne rundy to kolejne pociągi: po każdej wiemy, dokąd najwcześniej da się dojechać o jedną przesiadkę dalej.
function railJourney(trains, starts, targets, limit, maxTrains=MAX_RAIL_TRAINS){
  const known=new Map(); let frontier=new Map(), best=null;
  for(const [id,ready] of starts){ const label={time:ready, ready, leg:null, prev:null}; known.set(id,label); frontier.set(id,label); }
  for(let round=0; round<maxTrains && frontier.size; round++){
    const next=new Map();
    for(const t of trains){
      if(t.cancelled) continue;
      let board=null;
      for(const x of t.stops){
        if(x.cn) continue;
        if(board){
          const arr=x.predArr??x.predDep, cur=known.get(x.id), seen=next.get(x.id);
          if(arr!=null && (!cur||arr<cur.time) && (!seen||arr<seen.time)) next.set(x.id,{time:arr, ready:arr+RAIL_TRANSFER_SEC, leg:{t, a:board.x, b:x, dep:board.x.predDep, arr}, prev:board.label});
        }
        const label=frontier.get(x.id);
        if(!board && label && x.predDep!=null && x.predDep>=label.ready && x.predDep<=(round?label.ready+MAX_RAIL_WAIT_SEC:limit)) board={x, label}; // granica dotyczy odjazdu, a przesiadka ma własną
      }
    }
    for(const [id,label] of next){
      known.set(id,label);
      if(targets.has(id) && (!best || label.time<best.time-RAIL_CHANGE_GAIN_SEC)) best=label; // dodatkowa przesiadka musi się opłacać
    }
    frontier=next;
  }
  if(!best) return null;
  const parts=[]; for(let label=best; label.leg; label=label.prev) parts.unshift(label.leg);
  return parts;
}
// Osobno dla każdej liczby pociągów, bo krótsza podróż z dwiema przesiadkami nie zastępuje dłuższej z jedną.
// Pociąg, który przed przesiadką lub po niej jest na stacji startowej, można było złapać od razu.
function passesStart(parts, starts){
  return parts.slice(1).some(part=>{ const stops=part.t.stops; return stops.slice(0,stops.indexOf(part.b)+1).some(x=>starts.has(x.id)); });
}
function railJourneys(allTrains, starts, targets, limit, options=RAIL_OPTIONS){
  const found=new Map(), earliest=Math.min(...starts.values());
  const trains=allTrains.filter(t=>{ const last=t.stops[t.stops.length-1]; return (last.predArr??last.predDep??Infinity)>=earliest; });
  for(let maxTrains=1; maxTrains<=MAX_RAIL_TRAINS; maxTrains++){
    let from=starts;
    for(let n=0; n<options; n++){
      const parts=railJourney(trains, from, targets, limit, maxTrains); if(!parts) break;
      if(!passesStart(parts,starts)) found.set(parts.map(part=>part.t.key).join('>'), parts);
      const later=parts[0].dep+60; from=new Map([...from].map(([id,ready])=>[id,Math.max(ready,later)]));
    }
  }
  const all=[...found.values()], end=parts=>parts[parts.length-1].arr;
  const beats=(q,p)=>q[0].dep>=p[0].dep && end(q)<=end(p) && q.length<=p.length && (q[0].dep>p[0].dep || end(q)<end(p) || q.length<p.length);
  return all.filter(p=>!all.some(q=>q!==p && beats(q,p))).sort((x,y)=>x[0].dep-y[0].dep || end(x)-end(y));
}
/* ---------- Wszystkie odjazdy: każdy pociąg z okresu dostaje swój wiersz ---------- */
const ROUTE_SLOW_FACTOR=1.75;
function trainsByStation(trains){
  const index=new Map();
  for(const t of trains){ if(t.cancelled) continue; for(const x of t.stops){ if(!index.has(x.id)) index.set(x.id,new Set()); index.get(x.id).add(t); } }
  return index;
}
// Dalsza droga po wyjeździe tym pociągiem; każda kolejna przesiadka zostaje tylko wtedy, gdy dojeżdża wcześniej.
function onwardFrom(t, board, targets, index){
  const out=[], known=new Map(); let frontier=new Map();
  const stops=t.stops, start=stops.indexOf(board), root={leg:null, prev:null};
  let best=Infinity;
  const reach=(label,id)=>{ if(targets.has(id) && label.time<best){ best=label.time; const parts=[]; for(let l=label; l.leg; l=l.prev) parts.unshift(l.leg); out.push(parts); } };
  for(const x of stops.slice(start+1)){
    if(x.cn) continue;
    const arr=x.predArr??x.predDep; if(arr==null) continue;
    const label={time:arr, ready:arr+RAIL_TRANSFER_SEC, leg:{t, a:board, b:x, dep:board.predDep, arr}, prev:root};
    if(!known.has(x.id)){ known.set(x.id,label); frontier.set(x.id,label); reach(label,x.id); }
  }
  for(let round=1; round<MAX_RAIL_TRAINS && frontier.size; round++){
    const next=new Map(), nearby=new Set(); for(const id of frontier.keys()) for(const u of index.get(id)||[]) nearby.add(u);
    for(const u of nearby){
      if(u===t) continue;
      let on=null;
      for(const x of u.stops){
        if(x.cn) continue;
        if(on){
          const arr=x.predArr??x.predDep, cur=known.get(x.id), seen=next.get(x.id);
          if(arr!=null && (!cur||arr<cur.time) && (!seen||arr<seen.time)) next.set(x.id,{time:arr, ready:arr+RAIL_TRANSFER_SEC, leg:{t:u, a:on.x, b:x, dep:on.x.predDep, arr}, prev:on.label});
        }
        const label=frontier.get(x.id);
        if(!on && label && x.predDep!=null && x.predDep>=label.ready && x.predDep<=label.ready+MAX_RAIL_WAIT_SEC) on={x, label};
      }
    }
    for(const [id,label] of next){ known.set(id,label); reach(label,id); }
    frontier=next;
  }
  return out;
}
function railConnections(allTrains, starts, targets, limit, preferred=new Set()){
  const earliest=Math.min(...starts.values());
  const trains=allTrains.filter(t=>{ const last=t.stops[t.stops.length-1]; return (last.predArr??last.predDep??Infinity)>=earliest; });
  const index=trainsByStation(trains), found=new Map();
  for(const t of trains){
    if(t.cancelled) continue;
    const boards=t.stops.slice(0,-1).filter(x=>!x.cn && starts.has(x.id) && x.predDep!=null && x.predDep>=starts.get(x.id) && x.predDep<=limit);
    const board=boards.find(x=>preferred.has(x.id))||boards[0]; if(!board) continue;
    for(const parts of onwardFrom(t,board,targets,index)) if(!passesStart(parts,starts)) found.set(parts.map(part=>part.t.key).join('>'), parts);
  }
  const all=[...found.values()], length=parts=>parts[parts.length-1].arr-parts[0].dep, fastest=Math.min(...all.map(length));
  return all.filter(parts=>length(parts)<=fastest*ROUTE_SLOW_FACTOR).sort((x,y)=>x[0].dep-y[0].dep || x[x.length-1].arr-y[y.length-1].arr);
}
function planTrainTrips(from, to, at, trains, by){
  const out=[];
  for(const t of trains){
    if(t.cancelled) continue;
    const i=t.stops.findIndex(x=>railName(x.id)===from); if(i<0) continue;
    const j=t.stops.findIndex((x,k)=>k>i && railName(x.id)===to); if(j<0) continue;
    const a=t.stops[i], b=t.stops[j]; if(a.cn||b.cn) continue;
    const dep=a.predDep, arr=b.predArr??b.predDep;
    if(dep==null || arr==null || dep<at-60 || dep>at+RAIL_SEARCH_HOURS*3600 || (by && arr>by)) continue;
    out.push({t, a, b, dep, arr});
  }
  out.sort((x,y)=>x.dep-y.dep);
  return by ? out.slice(-7) : out.slice(0,7);
}
function planTrainRoutes(origin, dest, at, trains, by){
  const best=new Map(), starts=new Set(origin.names);
  const candidates=trains.filter(t=>t.stops.some(x=>starts.has(railName(x.id))));
  for(const from of origin.names) for(const to of dest.names){
    if(from===to) continue;
    const walkFrom=origin.walk.get(from)||0, walkTo=dest.walk.get(to)||0;
    for(const r of planTrainTrips(from, to, at+walkFrom, candidates, by)){
      const cur=best.get(r.t.key);
      if(!cur || walkFrom+walkTo<cur.walkFrom+cur.walkTo || (walkFrom+walkTo===cur.walkFrom+cur.walkTo && r.arr<cur.arr)) best.set(r.t.key, Object.assign(r,{from,to,walkFrom,walkTo}));
    }
  }
  const list=[...best.values()].sort((x,y)=>x.dep-y.dep);
  return by ? list.slice(-7) : list.slice(0,7);
}
/* ---------- okienko pociągu ---------- */
const trainModalEl=document.getElementById('trainModal'); const trainModal=new bootstrap.Modal(trainModalEl);
function openTrain(key){ TR.sel=key; renderTrain(false); trainModal.show(); }
trainModalEl.addEventListener('hidden.bs.modal', ()=>{ TR.sel=null; });
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
    if(trSched?.today!==ymdOf(0)){ try{ trSched=await plkSchedules(); }catch(e){ if(e.fatal) throw e; console.warn('PLK schedules', e); trSched={today:ymdOf(0), days:[]}; } }
    const ops=await plkGet('operations');
    TR.trains=buildTrains(trSched.days, ops); TR.ts=TR.fetchedAt||nowSec(); TR.mode='live'; TR.err=null;
  }catch(e){
    console.warn('PLK', e); TR.err=e.message;
    if(!TR.trains.length || TR.mode!=='live'){ TR.mode='demo'; TR.trains=demoTrains(); TR.ts=nowSec(); }
  }finally{ TR.busy=false; renderAlertsBtn(); renderBoard(); renderTrainRoute(); if(S.sub==='linie' && S.agency==='kolej') renderTrainLines(); if(S.agency==='kolej'){ renderStats(); refreshStopList(); } if(S.plan) runPlan(false); if(trainModalEl.classList.contains('show')) renderTrain(true); }
}
function trainsBoot(){
  if(!railStationsLoading) railStationsLoading=loadRailStations();
  clearInterval(TR.timer); trSched=null; TR.err=null; TR.trains=[]; TR.days.clear(); TR.shifted.clear();
  if(CFG.trains===false){ TR.mode='off'; renderBoard(); return; }
  TR.mode='loading'; renderBoard();
  trainsTick();
  TR.timer=setInterval(()=>{ if(!document.hidden) trainsTick(); }, 5*60*1000);
}

/* ============================================================
   POGODA — Open-Meteo (bez klucza)
   ============================================================ */
const WX={timer:null, data:null, spot:undefined, local:false, noLoc:false};
const WMO = {0:['Bezchmurnie','☀'],1:['Przeważnie pogodnie','🌤'],2:['Częściowe zachmurzenie','⛅'],3:['Pochmurno','☁'],45:['Mgła','🌫'],48:['Mgła szadziowa','🌫'],
  51:['Słaba mżawka','🌦'],53:['Mżawka','🌦'],55:['Gęsta mżawka','🌧'],56:['Marznąca mżawka','🌧'],57:['Marznąca mżawka','🌧'],61:['Słaby deszcz','🌧'],63:['Deszcz','🌧'],65:['Ulewa','🌧'],
  66:['Marznący deszcz','🌧'],67:['Marznący deszcz','🌧'],71:['Słaby śnieg','🌨'],73:['Śnieg','🌨'],75:['Intensywny śnieg','❄'],77:['Ziarna śniegu','🌨'],
  80:['Przelotny deszcz','🌦'],81:['Przelotne opady','🌧'],82:['Silne przelotne opady','⛈'],85:['Przelotny śnieg','🌨'],86:['Silny przelotny śnieg','❄'],95:['Burza','⛈'],96:['Burza z gradem','⛈'],99:['Burza z gradem','⛈']};
function wmo(c){ return WMO[c] || ['—','·']; }
/* Pogoda tam, gdzie jestem: położenie z urządzenia (przeglądarka albo natywne GPS w aplikacji), zaokrąglone do ok. 1 km,
   albo miejscowość wybrana ręcznie w widżecie. Bez zgody, bez GPS albo gdy serwis nie odpowie, widżet pokazuje Rzeszów
   i mówi dlaczego. Odmowę zapamiętujemy, żeby nie pytać przy każdym otwarciu; przycisk pozwala spróbować ponownie. */
const WX_SPOT='onward.wxSpot', WX_NOLOC='onward.wxNoLoc2', WX_PICK='onward.wxPick';
// Jedno zapytanie o położenie; odpowiada {spot} albo {why:'denied'|'unavailable'}.
function askPosition(opts){
  return new Promise(res=>{
    try{
      navigator.geolocation.getCurrentPosition(
        p=>res({spot:{lat:+p.coords.latitude.toFixed(2), lon:+p.coords.longitude.toFixed(2)}}),
        e=>res({why:e?.code===1?'denied':'unavailable', msg:e?.message||''}), opts);
    }catch(e){ res({why:'unavailable', msg:String(e?.message||e)}); }
  });
}
async function weatherSpot(ask){
  WX.why=null;
  const pick=store(WX_PICK);
  if(!ask && pick && Number.isFinite(pick.lat)) return {...pick, picked:true};
  if(!navigator.geolocation){ WX.why='unsupported'; return null; }
  if(!ask && !ONW.native && store(WX_NOLOC)){ WX.why='denied'; return null; } // w aplikacji system sam pamięta odmowę
  // W aplikacji WebView zgłasza tu „denied”, nawet gdy GPS jest dozwolony, więc pytamy wtedy od razu urządzenie.
  if(!ask && !ONW.native){ try{ const st=await navigator.permissions?.query({name:'geolocation'}); if(st?.state==='denied'){ store(WX_NOLOC,true); WX.why='denied'; return null; } }catch(e){} }
  let r=await askPosition({enableHighAccuracy:false, timeout:12000, maximumAge:15*60*1000});
  // Samo przybliżone położenie (sieć) bywa niedostępne, np. w telefonie bez Wi-Fi: druga próba przez GPS.
  if(r.why==='unavailable') r=await askPosition({enableHighAccuracy:true, timeout:20000, maximumAge:15*60*1000});
  if(r.spot){ store(WX_SPOT, r.spot); store(WX_NOLOC, false); if(ask) store(WX_PICK, null); return r.spot; }
  console.warn('Lokalizacja dla pogody:', r.why, r.msg);
  WX.why=r.why;
  if(r.why==='denied'){ store(WX_NOLOC,true); store(WX_SPOT,null); return null; }
  return store(WX_SPOT)||null; // GPS chwilowo milczy: ostatnie znane miejsce
}
async function weatherTick(ask){
  if(CFG.weather===false) return;
  const spot=await weatherSpot(ask);
  WX.spot=spot; WX.noLoc=!spot;
  autoCity(spot);
  let ok=false;
  if(spot){
    try{
      const buf=await fetchTimeout('/api/weather/now?'+new URLSearchParams({lat:spot.lat, lon:spot.lon}), 15000);
      const d=JSON.parse(new TextDecoder().decode(buf)); if(!d?.current) throw new Error(d?.error||'błąd');
      if(spot.picked && spot.name) d.place=spot.name;
      WX.data=d; WX.local=true; WX.err=null; ok=true;
    }catch(e){ console.warn('weather here',e); }
  }
  WX.hereFailed=!!spot && !ok;
  if(!ok){
    try{ const buf=await fetchTimeout('/api/live/weather', 15000); WX.data=JSON.parse(new TextDecoder().decode(buf)); if(WX.data.error) throw new Error(WX.data.reason||'błąd'); WX.local=false; WX.err=null; }
    catch(e){ WX.err='Brak danych pogodowych'; console.warn('weather',e); }
  }
  WX.busy=false;
  renderAlertsBtn();
  renderWeather();
}
function weatherTitle(){
  if(!WX.local) return esc('Pogoda w Rzeszowie')+(WX.hereFailed?` <small class="wx-why">· ${esc(L2('Twoja okolica chwilowo niedostępna','your area is unavailable right now'))}</small>`:'');
  const place=WX.data?.place;
  return place ? esc(L2('Pogoda: ','Weather: ')+place) : esc(L2('Pogoda w Twojej okolicy','Weather near you'));
}
// Strona zainstalowana na ekranie głównym (PWA): bez paska adresu, więc rada o „ikonie obok adresu” nic nie da.
const weatherInstalled=()=>matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone===true;
// Dlaczego nie ma mojej okolicy: przy odmowie przycisk nic nie da, dopóki zgody nie zmieni się w ustawieniach.
function weatherWhy(){
  if(WX.why==='denied') return ONW.native
    ? L2('Aplikacja nie ma dostępu do lokalizacji. Włącz go w Ustawieniach telefonu → Aplikacje → podavo.voyage → Uprawnienia → Lokalizacja albo wpisz miejscowość.','The app has no access to your location. Allow it in phone Settings → Apps → podavo.voyage → Permissions → Location, or type a town.')
    : weatherInstalled()
      ? (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1)
        ? L2('Aplikacja nie ma dostępu do lokalizacji. Włącz go w Ustawieniach → Prywatność → Usługi lokalizacji → Witryny Safari → Podczas używania, potem stuknij „Pokaż dla mojej lokalizacji” albo wpisz miejscowość.','The app has no access to your location. Allow it in Settings → Privacy → Location Services → Safari Websites → While Using, then tap “Show for my location”, or type a town.')
        : L2('Aplikacja nie ma dostępu do lokalizacji. Przytrzymaj ikonę podavo.voyage → Informacje o aplikacji → Uprawnienia → Lokalizacja → Zezwalaj, potem stuknij „Pokaż dla mojej lokalizacji” albo wpisz miejscowość.','The app has no access to your location. Long-press the podavo.voyage icon → App info → Permissions → Location → Allow, then tap “Show for my location”, or type a town.'))
      : L2('Przeglądarka blokuje lokalizację dla tej strony. Zezwól na nią w ustawieniach strony (ikona obok adresu) albo wpisz miejscowość.','Your browser blocks location for this site. Allow it in the site settings (icon next to the address) or type a town.');
  if(WX.why==='unavailable') return L2('Nie udało się ustalić położenia (włączona lokalizacja w telefonie?). Spróbuj ponownie albo wpisz miejscowość.','Could not find your position (is location turned on?). Try again or type a town.');
  if(WX.why==='unsupported') return L2('To urządzenie nie podaje lokalizacji. Wpisz miejscowość.','This device does not share its location. Type a town.');
  return '';
}
function weatherHere(){
  if(WX.busy) return; WX.busy=true;
  const b=document.getElementById('wxHere'); if(b){ b.disabled=true; b.textContent=L2('Szukam lokalizacji…','Finding your location…'); }
  store(WX_NOLOC,false); weatherTick(true);
}
async function weatherPick(q){
  q=String(q||'').trim(); if(!q) return;
  const msg=document.getElementById('wxPickMsg'); if(msg) msg.textContent=L2('Szukam…','Searching…');
  const r=await fetch('/api/geocode?'+new URLSearchParams({q})).then(x=>x.ok?x.json():null).catch(()=>null);
  const place=r?.places?.find(p=>p.points?.length);
  if(!place){ if(msg) msg.textContent=L2('Nie znaleziono tej miejscowości.','Town not found.'); return; }
  const [lat,lon]=place.points[0];
  store(WX_PICK, {lat:+lat.toFixed(2), lon:+lon.toFixed(2), name:place.label});
  weatherTick(false);
}
/* tytuł w nagłówku: ostatnie słowo wyróżnione kolorem (po przetłumaczeniu całości) */
function setHeroTitle(title){
  const el=document.getElementById('heroTitle'); if(!el) return;
  const t=String(window.rzTranslate?window.rzTranslate(String(title)):title).trim();
  const i=t.lastIndexOf(' ');
  el.innerHTML = i>0 ? `${esc(t.slice(0,i+1))}<span class="hl">${esc(t.slice(i+1))}</span>` : esc(t);
}
function renderWeather(){
  const el=document.getElementById('wx'); if(!el) return;
  if(CFG.weather===false){ el.classList.add('d-none'); return; }
  el.classList.remove('d-none');
  const btn = navigator.geolocation ? `<button type="button" class="wx-here" id="wxHere"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i> ${esc(L2('Pokaż dla mojej lokalizacji','Show for my location'))}</button>` : '';
  const why = weatherWhy();
  const here = WX.spot?.picked ? btn
    : WX.noLoc ? `${why?wxAlertHtml():''}${btn}<form class="wx-pick" id="wxPick"><input type="text" name="q" enterkeyhint="search" autocomplete="off" aria-label="${esc(L2('Miejscowość','Town'))}" placeholder="${esc(L2('np. Tyczyn','e.g. Tyczyn'))}"><button type="submit">${esc(L2('Pokaż','Show'))}</button></form><small class="wx-pick-msg" id="wxPickMsg"></small>`
    : '';
  const d=WX.data; if(!d||!d.current){ el.innerHTML=`<div class="cd-label">${WX.spot===undefined?esc(L2('Pogoda','Weather')):weatherTitle()}</div><div class="wx-err">${WX.err?esc(WX.err):'wczytywanie…'}</div>${here}`; if(WX.whyOpen) setWxAlert(true); return; }
  const c=d.current; const [desc,ico]=wmo(c.weather_code);
  const h=d.hourly||{}; const hrs=(h.time||[]).map((t,i)=>({t, temp:h.temperature_2m[i], pp:h.precipitation_probability?h.precipitation_probability[i]:null, pr:h.precipitation?h.precipitation[i]:0, code:h.weather_code?h.weather_code[i]:null})).slice(1,5);
  const codes=[c.weather_code, ...hrs.map(x=>x.code)];
  const hard = codes.some(k=>[45,48,56,57,66,67,71,73,75,77,85,86,95,96,99,65,82].includes(k)) || c.temperature_2m<=0 && c.precipitation>0;
  const wet = c.precipitation>0.3 || hrs.some(x=>(x.pp||0)>=60);
  const tip = hard ? 'Trudne warunki na drogach — licz się z większymi opóźnieniami.' : wet ? 'Spodziewany deszcz — możliwe niewielkie opóźnienia.' : 'Warunki sprzyjające punktualności.';
  el.innerHTML=`<div class="cd-label">${WX.local?'<i class="fa-solid fa-location-dot" aria-hidden="true"></i> ':''}${weatherTitle()}</div>
    <div class="wx-now"><span class="wx-ico"><img src="${weatherIcon(c.weather_code)}" alt="" aria-hidden="true" width="40" height="40"></span><span class="wx-temp">${Math.round(c.temperature_2m)}°</span>
      <span class="wx-desc">${esc(desc)}<small>odczuwalna ${Math.round(c.apparent_temperature)}° · wiatr ${Math.round(c.wind_speed_10m)} km/h${c.precipitation?` · opad ${c.precipitation} mm`:''}</small></span></div>
    <div class="wx-hours">${hrs.map(x=>`<span><small>${esc(String(x.t).slice(11,16))}</small>${wmo(x.code)[1]} ${Math.round(x.temp)}°${x.pp!=null?`<small>${x.pp}%</small>`:''}</span>`).join('')}</div>
    <div class="wx-tip ${hard?'hard':wet?'wet':''}">${tip}</div>${here}`;
  if(WX.whyOpen) setWxAlert(true);
}
// Dlaczego nie widać mojej okolicy: czerwony dzwonek obok przycisku, a wyjaśnienie w okienku po kliknięciu.
function wxAlertHtml(){
  return `<span class="wx-alert"><button type="button" class="wx-alert-btn" id="wxAlertBtn" aria-haspopup="dialog" aria-expanded="${!!WX.whyOpen}" aria-controls="wxAlertPop" title="${esc(L2('Brak dostępu do lokalizacji','No access to your location'))}"><i class="fa-solid fa-bell" aria-hidden="true"></i><span class="visually-hidden">${esc(L2('Dlaczego nie widać mojej okolicy?','Why is my area not shown?'))}</span></button></span>`;
}
// Okienko jest w <body> (position: fixed), bo karta pogody i nagłówek przycinają wszystko, co z nich wystaje.
function setWxAlert(open){
  const b=document.getElementById('wxAlertBtn'), why=weatherWhy();
  WX.whyOpen=open && !!b && !!why;
  let pop=document.getElementById('wxAlertPop');
  if(b) b.setAttribute('aria-expanded', String(WX.whyOpen));
  if(!WX.whyOpen){ if(pop) pop.hidden=true; return; }
  if(!pop){ pop=document.createElement('div'); pop.id='wxAlertPop'; pop.className='wx-alert-pop'; pop.setAttribute('role','dialog'); document.body.appendChild(pop); }
  pop.setAttribute('aria-label', L2('Lokalizacja','Location'));
  pop.innerHTML=`<b><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i> ${esc(L2('Brak dostępu do lokalizacji','No access to your location'))}</b>${esc(why)}<button type="button" class="wx-alert-close" data-wx-alert-close aria-label="${esc(L2('Zamknij','Close'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
  pop.hidden=false;
  const r=b.getBoundingClientRect(), w=pop.offsetWidth;
  pop.style.top=Math.round(r.bottom+8)+'px'; pop.style.left=Math.round(Math.max(8, Math.min(r.left, innerWidth-w-8)))+'px';
}
document.getElementById('wx')?.addEventListener('click', e=>{
  if(e.target.closest('#wxHere')) weatherHere();
  if(e.target.closest('#wxAlertBtn')) setWxAlert(!WX.whyOpen);
});
document.addEventListener('click', e=>{
  if(e.target.closest('[data-wx-alert-close]')){ setWxAlert(false); document.getElementById('wxAlertBtn')?.focus(); return; }
  if(WX.whyOpen && !e.target.closest('.wx-alert, #wxAlertPop')) setWxAlert(false);
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && WX.whyOpen){ setWxAlert(false); document.getElementById('wxAlertBtn')?.focus(); } });
addEventListener('scroll', ()=>{ if(WX.whyOpen) setWxAlert(false); }, {passive:true});
addEventListener('resize', ()=>{ if(WX.whyOpen) setWxAlert(true); });
document.getElementById('wx')?.addEventListener('submit', e=>{ if(e.target.id!=='wxPick') return; e.preventDefault(); weatherPick(e.target.q.value); });
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
  return (kickerMode==='live' ? 'Na żywo · ' : 'Demo · ') + fmtClockS(nowSec());
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
      renderAlertsBtn();
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
openPage(pageFromLocation(), false);
boot();
trainsBoot();
weatherBoot();
/* „Zainstaluj aplikację”: na telefonie z Androidem przycisk daje prawdziwą aplikację: stronę w Google Play, gdy jest
   (ANDROID_STORE_URL na serwerze), a do tego czasu plik APK z /download/voyage.apk z krótką instrukcją instalacji, także w wersji dodanej z przeglądarki do ekranu początkowego. Gdzie indziej przycisk pojawia się,
   gdy przeglądarka pozwala zainstalować stronę (Chrome, Edge), a na iPhonie/iPadzie w Safari pokazuje instrukcję „Do ekranu początkowego”.
   W aplikacji na Androida/iOS przycisku nie ma. */
(function installApp(){
  const btn=document.getElementById('installBtn'); if(!btn) return;
  const native=document.documentElement.classList.contains('is-native');
  const standalone=()=>matchMedia('(display-mode: standalone)').matches || navigator.standalone===true || native;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  const android=!native && /android/i.test(navigator.userAgent);
  let apk=false, store=null; // the Android app: its Google Play page, or the APK on this server (checked once, below)
  let deferred=window.__installPrompt||null;
  const item=btn.closest('li')||btn;
  // Pasek „Zainstaluj aplikację” pojawia się sam, gdy przeglądarka pozwala zainstalować Podavo (jak w Podavo Clean):
  // jedno stuknięcie otwiera okno instalacji przeglądarki. Zamknięty wraca po 14 dniach. Na iPhonie prowadzi do instrukcji.
  const BANNER_KEY='podavo.install.dismissed', BANNER_DAYS=14;
  const bannerOff=()=>{ try{ const t=+localStorage.getItem(BANNER_KEY)||0; return Date.now()-t<BANNER_DAYS*864e5; }catch{ return false; } };
  const banner=()=>{
    const want=!native && !standalone() && !bannerOff() && !!(deferred || (ios && /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)));
    let el=document.getElementById('installBanner');
    if(!want){ el?.remove(); return; }
    if(el) return;
    el=document.createElement('div'); el.id='installBanner'; el.className='install-banner'; el.setAttribute('role','region'); el.setAttribute('aria-label',L2('Zainstaluj aplikację','Install the app'));
    el.innerHTML=`<img src="/assets/onward/png/icon-192.png" alt="" width="40" height="40"><div class="ib-text"><b>${L2('Zainstaluj Podavo','Install Podavo')}</b><small>${L2('Na ekranie początkowym, z powiadomieniami push','On your home screen, with push notifications')}</small></div><button type="button" class="btn-grad ib-go">${L2('Zainstaluj','Install')}</button><button type="button" class="ib-x" aria-label="${L2('Nie teraz','Not now')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    el.querySelector('.ib-x').addEventListener('click', ()=>{ try{ localStorage.setItem(BANNER_KEY, String(Date.now())); }catch{} el.remove(); });
    el.querySelector('.ib-go').addEventListener('click', async ()=>{
      if(!deferred){ bootstrap.Modal.getOrCreateInstance(document.getElementById('installModal')).show(); return; }
      const e=deferred; deferred=null; window.__installPrompt=null; el.remove();
      try{ await e.prompt(); const r=await e.userChoice; if(r?.outcome!=='accepted'){ try{ localStorage.setItem(BANNER_KEY, String(Date.now())); }catch{} } }catch(err){}
      show();
    });
    document.body.appendChild(el);
  };
  const show=()=>{ item.hidden= native || !(store || apk || (!standalone() && (deferred || ios))); banner(); };
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferred=e; window.__installPrompt=e; show(); });
  window.addEventListener('appinstalled', ()=>{ deferred=null; window.__installPrompt=null; show(); });
  btn.addEventListener('click', async ()=>{
    if(store){ location.href=store; return; }
    if(apk){
      const note=document.getElementById('androidPwaNote'); if(note) note.hidden=!standalone();
      // Wersja z przeglądarki ma powiadomienia push, których plik APK jeszcze nie ma — dlatego jest na górze okna.
      const done=standalone(); document.getElementById('installPwaBtn').hidden=done; document.getElementById('installPwaDone').hidden=!done; document.getElementById('installPwaSteps').hidden=true;
      bootstrap.Modal.getOrCreateInstance(document.getElementById('androidModal')).show(); return;
    }
    if(!deferred){ bootstrap.Modal.getOrCreateInstance(document.getElementById('installModal')).show(); return; }
    const e=deferred; deferred=null; window.__installPrompt=null; show();
    try{ await e.prompt(); }catch(err){}
  });
  document.getElementById('installPwaBtn')?.addEventListener('click', async ()=>{
    if(!deferred){ document.getElementById('installPwaSteps').hidden=false; return; }
    const e=deferred; deferred=null; window.__installPrompt=null;
    try{ await e.prompt(); const r=await e.userChoice; if(r?.outcome==='accepted') bootstrap.Modal.getInstance(document.getElementById('androidModal'))?.hide(); }catch(err){ document.getElementById('installPwaSteps').hidden=false; }
    show();
  });
  if(android){
    fetch('/api/android-app', {cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{ if(!d) return;
      store=d.store||null; apk=!!d.apk; if(d.apk) document.getElementById('androidDownload')?.setAttribute('href', d.apk); show(); }).catch(()=>{});
  }
  show();
})();
