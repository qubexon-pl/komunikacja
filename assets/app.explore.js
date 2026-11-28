/* Plan zwiedzania miasta: informacje o mieście (Wikipedia + Wikidata), atrakcje z Wikipedii z opisami, własna trasa
   (atrakcje i miejsca dodane ręcznie, w kolejności ustalonej przez podróżnego, z odległościami między kolejnymi
   punktami i sumą) oraz pytania do AI. Czyste funkcje zwracające HTML i liczące odległości; app.js pobiera dane,
   zapisuje trasę w podróży i podpina przyciski.

   Uczciwość: odległości są w linii prostej i tak je opisujemy; czas pieszo to szacunek (trasa ok. 1,25 × dłuższa niż
   linia prosta, 4,8 km/h). Opisy pochodzą z Wikipedii (CC BY-SA 4.0) i mają przy sobie źródło. */
(function(root){
  'use strict';
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const PL=(pl)=>pl;
  const has=p=>p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon) && p.lat!==null && p.lon!==null;
  function km(a, b){
    const r=d=>d*Math.PI/180, dLat=r(b.lat-a.lat), dLon=r(b.lon-a.lon);
    return 12742*Math.asin(Math.sqrt(Math.sin(dLat/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dLon/2)**2));
  }
  const walkMin=k=>Math.max(1, Math.round(k*1.25/4.8*60));
  const fmtKm=(k,t=PL)=>k<1?`${Math.max(10,Math.round(k*1000/10)*10)} m`:`${k.toFixed(1).replace('.',t(',','.'))} km`;
  const fmtMin=(m,t=PL)=>m<60?`${m} min`:`${Math.floor(m/60)} ${t('godz.','h')}${m%60?` ${m%60} min`:''}`;

  // Czas zwiedzania według rodzaju miejsca (minuty), gdy podróżny nie ustawił własnego.
  const VISIT={museum:90, sacral:30, castle:75, monument:15, park:45, square:20, building:30, heritage:30, sight:30};
  const visitMin=x=>Number.isFinite(+x?.min)&&+x.min>0?+x.min:(VISIT[x?.kind]||30);
  // Kontekst trasy: centrum miasta i nocleg. Starszy zapis: sam punkt startu (nocleg).
  const ctxOf=c=>c&&('centre' in c||'home' in c)?c:{home:has(c)?c:null, centre:null};
  // Skąd idziemy do punktu i: „prev” poprzedni punkt (domyślnie od drugiego), „home” nocleg, „centre” centrum,
  // „custom” własne miejsce. Pierwszy punkt domyślnie od noclegu, a bez noclegu od centrum.
  function originOf(items, i, c){
    const ctx=ctxOf(c), x=items[i]; let f=x?.from||(i>0?'prev':ctx.home?'home':'centre');
    if(f==='prev' && i===0) f=ctx.home?'home':'centre';
    if(f==='prev') return has(items[i-1])?{lat:+items[i-1].lat, lon:+items[i-1].lon, label:items[i-1].name, kind:'prev'}:null;
    if(f==='custom' && x.fromLat!=null) return {lat:+x.fromLat, lon:+x.fromLon, label:x.fromName||'', kind:'custom'};
    if(f==='home' && has(ctx.home)) return {...ctx.home, kind:'home'};
    return has(ctx.centre)?{...ctx.centre, kind:'centre'}:has(ctx.home)?{...ctx.home, kind:'home'}:null;
  }
  // Odległość do każdego punktu od jego punktu startu; null, gdy któregoś położenia nie znamy.
  function legs(items, c){ return items.map((x,i)=>{ const o=originOf(items,i,c); return has(o)&&has(x)?km(o,x):null; }); }
  function totals(items, c){
    const L=legs(items, c), known=L.filter(x=>x!=null), sum=known.reduce((s,x)=>s+x,0), walk=L.reduce((s,d)=>s+(d!=null?walkMin(d):0),0), visit=items.reduce((s,x)=>s+visitMin(x),0);
    return {km:sum, walkMin:known.length?walk:0, visitMin:visit, totalMin:walk+visit, legs:L, origins:items.map((x,i)=>originOf(items,i,c)), missing:items.filter(x=>!has(x)).length, fromStart:items.length&&L[0]!=null?L[0]:null};
  }
  const clock=m=>`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(Math.round(m)%60).padStart(2,'0')}`;
  // Godziny dnia: dojście, zwiedzanie, kolejne dojście… od godziny startu („09:00”).
  function schedule(items, c, start='09:00'){
    const [h,m]=String(start).split(':').map(Number); let t=(h||0)*60+(m||0); const L=legs(items,c);
    return items.map((x,i)=>{ t+=L[i]!=null?walkMin(L[i]):0; const arrive=t; t+=visitMin(x); return {arrive:clock(arrive), leave:clock(t), walk:L[i]!=null?walkMin(L[i]):0, visit:visitMin(x)}; });
  }
  // Propozycja trasy na zadany czas: najwięcej znanych i różnych miejsc, które zmieszczą się w czasie (zwiedzanie +
  // dojścia pieszo). Zachłannie: miejsce o najlepszym stosunku wartości (popularność, a za każde kolejne miejsce tego
  // samego rodzaju mniej) do dodanego czasu (zwiedzanie + najtańsze wstawienie w trasę), potem najkrótsza kolejność.
  function suggest(attractions, {ctx, budget=240, max=10, have=[]}={}){
    const c=ctxOf(ctx), start=c.home||c.centre, pool=(attractions||[]).filter(has).filter(a=>!have.includes(a.id)).slice().sort((a,b)=>(b.views||0)-(a.views||0)).slice(0,40);
    const value=(a,kinds)=>Math.log10((a.views||0)+10)*(a.listed?1.3:1)*Math.pow(.55, kinds[a.kind]||0);
    const pathMin=list=>list.reduce((s,x,i)=>{ const o=i?list[i-1]:start; return s+(has(o)?walkMin(km(o,x)):0); },0)+list.reduce((s,x)=>s+visitMin(x),0);
    let tour=[]; const kinds={};
    while(tour.length<max){
      let best=null;
      for(const a of pool){ if(tour.includes(a)) continue;
        for(let k=0;k<=tour.length;k++){ const next=[...tour.slice(0,k), a, ...tour.slice(k)], cost=pathMin(next);
          if(cost>budget) continue;
          const r=value(a,kinds)/Math.max(1, cost-pathMin(tour));
          if(!best||r>best.r) best={r, next, a}; } }
      if(!best) break;
      tour=best.next; kinds[best.a.kind]=(kinds[best.a.kind]||0)+1;
    }
    return shortest(tour, start).map(a=>({...a, min:visitMin(a)}));
  }
  const pathKm=(list, start)=>list.reduce((s,x,i)=>s+(i?km(list[i-1],x):has(start)?km(start,x):0),0);

  // Najkrótsza kolejność (z noclegu albo od pierwszego punktu): najbliższy sąsiad, potem poprawki 2-opt.
  // Punkty bez współrzędnych zostają na końcu w swojej kolejności.
  function shortest(items, start){
    const geo=items.filter(has), rest=items.filter(x=>!has(x));
    if(geo.length<3 && !(has(start)&&geo.length===2)) return items.slice();
    const left=geo.slice(), out=[];
    let at=has(start)?start:left.shift();
    if(!has(start)) out.push(at);
    while(left.length){ let bi=0, bd=Infinity; left.forEach((x,i)=>{ const d=km(at,x); if(d<bd){ bd=d; bi=i; } }); at=left.splice(bi,1)[0]; out.push(at); }
    let best=out, bestKm=pathKm(out, start), better=true, guard=0;
    while(better && guard++<50){
      better=false;
      for(let i=has(start)?0:1; i<best.length-1; i++) for(let j=i+1; j<best.length; j++){
        const next=[...best.slice(0,i), ...best.slice(i,j+1).reverse(), ...best.slice(j+1)], k=pathKm(next, start);
        if(k<bestKm-1e-9){ best=next; bestKm=k; better=true; }
      }
    }
    return [...best, ...rest];
  }
  // Trasa piesza w Google Maps przez punkty planu (Google przyjmuje do 9 punktów pośrednich).
  function mapsUrl(items, c){
    const pts=items.filter(has).map(x=>`${(+x.lat).toFixed(5)},${(+x.lon).toFixed(5)}`), start=items.length?originOf(items,0,c):null;
    const all=has(start)?[`${(+start.lat).toFixed(5)},${(+start.lon).toFixed(5)}`, ...pts]:pts;
    if(all.length<2) return '';
    const mid=all.slice(1,-1).slice(0,9);
    return 'https://www.google.com/maps/dir/?'+new URLSearchParams({api:'1', origin:all[0], destination:all[all.length-1], ...(mid.length?{waypoints:mid.join('|')}:{}), travelmode:'walking'}).toString();
  }

  const KIND=[['','Wszystkie','All','star'],['museum','Muzea','Museums','building-columns'],['sacral','Kościoły i świątynie','Churches','church'],['castle','Zamki i pałace','Castles and palaces','chess-rook'],['monument','Pomniki','Monuments','monument'],['park','Parki i natura','Parks and nature','tree'],['square','Place i stare miasto','Squares','map'],['building','Budowle','Buildings','archway'],['heritage','Zabytki','Heritage','landmark'],['sight','Inne','Other','location-dot']];
  const KIND_ICON=Object.fromEntries(KIND.map(([k,,,i])=>[k,i]));

  const kindLabel=(k,t=PL)=>{ const x=KIND.find(([kk])=>kk===k&&k); return x?t(x[1],x[2]):''; };
  const plural=(n,t)=>t(`${n} ${n===1?'miejsce':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'miejsca':'miejsc'}`,`${n} ${n===1?'place':'places'}`);

  // Nagłówek okna: nazwa miasta (z Wikipedii, bez lotniska), kraj i liczba mieszkańców, przycisk „O mieście”.
  function headHtml(name, info, t=PL){
    const f=info?.found?info.facts||{}:{};
    const sub=[f.country, f.population?`${Number(f.population.value).toLocaleString(t('pl-PL','en-GB'))} ${t('mieszk.','people')}`:''].filter(Boolean).join(' · ');
    return `<div class="xa-head"><div><h4>${esc(name)}</h4>${sub?`<small>${esc(sub)}</small>`:''}</div>${info?.found?`<button type="button" class="btn-ghost" data-xa-about><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${esc(t('O mieście','About the city'))}</button>`:''}</div>`;
  }
  // Zakładki: Atrakcje · Mój plan · Zapytaj AI · Dojazdy.
  function tabsHtml(tab, {attr=0, plan=0, ask=false}={}, t=PL){
    const tabs=[['attr',t('Atrakcje','Sights'),attr],['plan',t('Mój plan','My plan'),plan],...(ask?[['ask',t('Zapytaj','Ask'),0]]:[]),['more',t('Dojazdy','Getting around'),0]];
    return `<div class="xa-tabs" role="tablist">${tabs.map(([k,l,n])=>`<button type="button" role="tab" class="xa-tab${k===tab?' on':''}" aria-selected="${k===tab}" data-xa-tab="${k}">${esc(l)}${n?` <span class="xa-count">${n}</span>`:''}</button>`).join('')}</div>`;
  }

  // Położenie miejsca: dzielnica (Wikidata) i odległość od centrum miasta.
  function whereHtml(a, centre, t=PL){
    const d=has(a)&&has(centre)?km(centre,a):null, bits=[a.area, d!=null?(d<0.3?t('w centrum','in the centre'):`${fmtKm(d,t)} ${t('od centrum','from the centre')}`):''].filter(Boolean);
    return bits.length?`<small class="xa-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(bits.join(' · '))}</small>`:'';
  }

  // Lista atrakcji: jeden wiersz na miejsce (miniatura, nazwa, krótki opis) i przycisk „Dodaj do planu”.
  // Kliknięcie wiersza otwiera okno ze szczegółami.
  function attrListHtml({data, kind='', limit=20, inPlan=new Set(), edit=true, err='', t=PL}={}){
    const centre=has(data?.centre)?data.centre:null;
    if(err) return `<div class="empty-note">${esc(err)} <button type="button" class="btn-ghost" data-xp-retry>${esc(t('Spróbuj ponownie','Try again'))}</button></div>`;
    if(!data) return `<div class="empty-note" role="status">${esc(t('Szukam atrakcji w Wikipedii…','Looking for attractions on Wikipedia…'))}</div>`;
    const all=data.attractions||[];
    if(!all.length) return `<div class="empty-note">${esc(t('Wikipedia nie opisuje tu atrakcji z położeniem na mapie.','Wikipedia lists no attractions with a map position here.'))}</div>`;
    const there=new Set(all.map(a=>a.kind)), list=all.filter(a=>!kind||a.kind===kind);
    const chips=there.size>2?`<div class="xa-kinds" role="group" aria-label="${esc(t('Rodzaj','Kind'))}">${KIND.filter(([k])=>!k||there.has(k)).map(([k,pl,en])=>`<button type="button" class="xa-kind${k===kind?' on':''}" data-xp-kind="${k}" aria-pressed="${k===kind}">${esc(t(pl,en))}</button>`).join('')}</div>`:'';
    const rows=list.slice(0,limit).map(a=>{ const inp=inPlan.has(a.id), sub=a.description||String(a.extract||'').split('. ')[0], loc=whereHtml(a, centre, t);
      return `<li class="xa-row"><button type="button" class="xa-open" data-xa-open="${esc(a.id)}" aria-haspopup="dialog">${a.image?`<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="xa-ic"><i class="fa-solid fa-${KIND_ICON[a.kind]||'landmark'}" aria-hidden="true"></i></span>`}<span class="xa-tx"><b>${esc(a.title)}</b>${sub?`<small>${esc(sub)}</small>`:''}${loc}</span></button>
        ${edit?(inp?`<button type="button" class="xa-add on" data-xp-unadd="${esc(a.id)}" aria-pressed="true" aria-label="${esc(t(`Usuń z planu: ${a.title}`,`Remove from plan: ${a.title}`))}"><i class="fa-solid fa-check" aria-hidden="true"></i><span> ${esc(t('W planie','In plan'))}</span></button>`:`<button type="button" class="xa-add" data-xp-add="${esc(a.id)}" aria-label="${esc(t(`Dodaj do planu: ${a.title}`,`Add to plan: ${a.title}`))}"><i class="fa-solid fa-plus" aria-hidden="true"></i><span> ${esc(t('Dodaj do planu','Add to plan'))}</span></button>`):''}</li>`; }).join('');
    const rest=list.length-limit;
    return `${chips}<ol class="xa-list">${rows}</ol>${rest>0?`<button type="button" class="btn-ghost xa-more" data-xp-more>${esc(t(`Pokaż więcej (${rest})`,`Show more (${rest})`))}</button>`:''}
      <small class="cs-src xa-src">${esc(t('Atrakcje z artykułu o mieście i okolicznych artykułów Wikipedii (CC BY-SA 4.0); rodzaje: Wikidata (CC0).','Attractions from the city article and nearby Wikipedia articles (CC BY-SA 4.0); kinds: Wikidata (CC0).'))}</small>`;
  }

  // Okno ze szczegółami atrakcji albo punktu planu: zdjęcie, opis, odległość, dodaj/usuń, dojazd, Wikipedia.
  function detailHtml(a, {inPlan=false, edit=true, fromKm=null, fromLabel='', centre=null, t=PL}={}){
    const meta=[kindLabel(a.kind,t), a.description, `${t('zwiedzanie ok.','visit about')} ${fmtMin(visitMin(a),t)}`].filter(Boolean);
    const where=[a.area, has(a)&&has(centre)?`${fmtKm(km(centre,a),t)} ${t('od centrum','from the centre')}`:'', fromKm!=null&&fromLabel?`${fmtKm(fromKm,t)} ${t('od','from')} ${fromLabel}`:''].filter(Boolean);
    const id=a.id||'', plan=a.planId||'';
    return `<div class="xa-detail">${a.image?`<img class="xa-detail-img" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">`:''}
      ${meta.length?`<p class="xa-detail-meta">${meta.map(esc).join(' · ')}</p>`:''}
      ${where.length?`<p class="xa-where xa-detail-where"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(where.join(' · '))}</p>`:''}
      ${has(a)?`<div class="xa-minimap" data-xa-minimap data-lat="${(+a.lat).toFixed(5)}" data-lon="${(+a.lon).toFixed(5)}" role="img" aria-label="${esc(t(`Mapa: ${a.title}`,`Map: ${a.title}`))}"></div>`:''}
      ${a.extract?`<p class="xa-detail-tx">${esc(a.extract)}</p>`:a.note?`<p class="xa-detail-tx">${esc(a.note)}</p>`:''}
      ${a.lat==null?`<p class="xp-nogeo">${esc(t('Bez położenia na mapie: nie liczymy do niego odległości.','No map position: no distance is counted to it.'))}</p>`:''}
      <div class="xa-detail-act">${edit?(inPlan?`<button type="button" class="btn-ghost" data-xa-m="remove" data-id="${esc(id)}" data-plan="${esc(plan)}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> ${esc(t('Usuń z planu','Remove from plan'))}</button>`:`<button type="button" class="btn-grad" data-xa-m="add" data-id="${esc(id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do planu','Add to plan'))}</button>`):''}
        ${a.lat!=null?`<button type="button" class="btn-ghost" data-xa-m="route" data-id="${esc(id)}" data-plan="${esc(plan)}"><i class="fa-solid fa-route" aria-hidden="true"></i> ${esc(t('Dojazd','Get there'))}</button><a class="btn-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${(+a.lat).toFixed(5)},${(+a.lon).toFixed(5)}" target="_blank" rel="noopener"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> ${esc(t('Mapa','Map'))}</a>`:''}
        ${a.url?`<a class="btn-ghost" href="${esc(a.url)}" target="_blank" rel="noopener"><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i> Wikipedia</a>`:''}</div>
      ${a.url?`<small class="cs-src">${esc(t('Opis i zdjęcie: Wikipedia, CC BY-SA 4.0.','Text and picture: Wikipedia, CC BY-SA 4.0.'))}</small>`:''}</div>`;
  }

  const ORIGIN=[['prev','Poprzedni punkt','Previous stop'],['home','Nocleg','Your stay'],['centre','Centrum','City centre'],['custom','Inne miejsce…','Another place…']];
  const MINS=[15,30,45,60,90,120,180,240];
  // Linia dojścia przed punktem: skąd (wybór), odległość i czas pieszo.
  function legHtml(x, i, T, ctx, {edit, t, fromEdit}){
    const o=T.origins[i], d=T.legs[i], cur=x.from||(i>0?'prev':ctx.home?'home':'centre');
    const opts=ORIGIN.filter(([k])=>(k!=='prev'||i>0)&&(k!=='home'||ctx.home));
    const label=o?(o.kind==='prev'?t(`od: ${o.label}`,`from ${o.label}`):o.kind==='home'?t(`od: ${o.label||'nocleg'}`,`from ${o.label||'your stay'}`):o.kind==='centre'?t(`od: ${o.label||'centrum'}`,`from ${o.label||'the centre'}`):t(`od: ${o.label}`,`from ${o.label}`)):'';
    const sel=edit?`<label class="xa-from"><span class="visually-hidden">${esc(t(`Skąd idziesz do: ${x.name}`,`Where you start for: ${x.name}`))}</span><select data-xp-from="${esc(x.id)}">${opts.map(([k,pl,en])=>`<option value="${k}" ${k===cur?'selected':''}>${esc(k==='custom'&&cur==='custom'&&x.fromName?x.fromName:t(pl,en))}</option>`).join('')}</select></label>`:'';
    const form=edit&&fromEdit===x.id?`<form class="xa-fromform" data-xp-from-form="${esc(x.id)}" autocomplete="off"><label class="cp-field"><span>${esc(t('Skąd zaczynasz','Where you start'))}</span><input id="xpFromName" name="name" required maxlength="120" placeholder="${esc(t('np. dworzec, kawiarnia, adres','e.g. station, café, address'))}"></label><span class="xa-addform-btns"><button type="submit" class="btn-grad">${esc(t('Ustaw','Set'))}</button><button type="button" class="btn-ghost" data-xp-from-cancel>${esc(t('Anuluj','Cancel'))}</button></span></form>`:'';
    const dist=d!=null?`<i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${esc(fmtKm(d,t))} · ${esc(fmtMin(walkMin(d),t))}`:'';
    return `<li class="xa-leg">${sel||(label?`<span>${esc(label)}</span>`:'')}${dist?`<span class="xa-leg-d">${dist}</span>`:''}${form}</li>`;
  }
  // Mój plan: punkty po kolei, przed każdym skąd idziemy i ile; godziny dnia, czas zwiedzania i suma.
  function planHtml({items=[], ctx=null, start=null, edit=true, t=PL, adding=false, startTime='09:00', fromEdit='', sugg=null}={}){
    const C=ctx?ctxOf(ctx):ctxOf(start), T=totals(items, C), n=items.length, S=schedule(items, C, startTime);
    const minSel=x=>edit?`<label class="xa-min"><span class="visually-hidden">${esc(t(`Czas zwiedzania: ${x.name}`,`Visit time: ${x.name}`))}</span><select data-xp-min="${esc(x.id)}">${[...new Set([...MINS, visitMin(x)])].sort((a,b)=>a-b).map(m=>`<option value="${m}" ${m===visitMin(x)?'selected':''}>${esc(fmtMin(m,t))}</option>`).join('')}</select></label>`:`<span>${esc(fmtMin(visitMin(x),t))}</span>`;
    const rows=items.map((x,i)=>`${legHtml(x,i,T,C,{edit,t,fromEdit})}
      <li class="xa-item${x.manual?' manual':''}"><span class="xa-num" aria-hidden="true">${i+1}</span>
        <span class="xa-item-main"><button type="button" class="xa-item-tx" data-xa-plan="${esc(x.id)}" aria-haspopup="dialog"><b>${esc(x.name)}</b>${x.note?`<small>${esc(x.note)}</small>`:''}${!has(x)?`<small class="xp-nogeo">${esc(t('bez położenia na mapie','no map position'))}</small>`:''}</button>
          <span class="xa-time"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${S[i].arrive}–${S[i].leave} ${minSel(x)}</span></span>
        ${edit?`<span class="xa-item-act">${n>1?`<button type="button" class="xa-icon" data-xp-move="${esc(x.id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="${esc(t(`Przesuń wyżej: ${x.name}`,`Move up: ${x.name}`))}"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" class="xa-icon" data-xp-move="${esc(x.id)}" data-dir="1" ${i===n-1?'disabled':''} aria-label="${esc(t(`Przesuń niżej: ${x.name}`,`Move down: ${x.name}`))}"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>`:''}<button type="button" class="xa-icon" data-xp-remove="${esc(x.id)}" aria-label="${esc(t(`Usuń z planu: ${x.name}`,`Remove from plan: ${x.name}`))}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></span>`:''}</li>`).join('');
    const url=mapsUrl(items,C);
    const sum=n?`<div class="xa-total" role="status"><span><i class="fa-regular fa-hourglass-half" aria-hidden="true"></i> ${esc(t('Cały plan','Whole plan'))}: <b>${esc(fmtMin(T.totalMin,t))}</b> (${esc(t('zwiedzanie','visits'))} ${esc(fmtMin(T.visitMin,t))}${T.walkMin?` + ${esc(t('dojścia','walking'))} ${esc(fmtMin(T.walkMin,t))}, ${esc(fmtKm(T.km,t))}`:''}) · ${esc(t('koniec ok.','ends about'))} ${n?S[n-1].leave:''}</span>
      <span class="xa-total-act">${edit&&items.filter(has).length>=3?`<button type="button" class="btn-ghost" data-xp-shortest><i class="fa-solid fa-shuffle" aria-hidden="true"></i> ${esc(t('Ułóż najkrócej','Shortest order'))}</button>`:''}${url?`<a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> ${esc(t('Trasa w Google Maps','Route in Google Maps'))}</a>`:''}</span></div>
      <small class="xa-note">${esc(t('Odległości w linii prostej, czas pieszo z zapasem na ulice. Czas zwiedzania możesz zmienić przy każdym punkcie.','Straight-line distances, walking time with an allowance for streets. Change the visit time at each stop.'))}</small>`:'';
    const head=n?`<div class="xa-planhead">${edit?`<label class="xa-start"><span>${esc(t('Start o','Start at'))}</span><input type="time" data-xp-time value="${esc(startTime)}" step="900"></label>`:''}${items.some(has)?`<div class="xa-planmap" id="xpPlanMap" role="img" aria-label="${esc(t('Mapa planu z numerami punktów','Plan map with numbered stops'))}"></div>`:''}</div>`:'';
    const form=edit?(adding?`<form class="xa-addform" data-xp-add-form autocomplete="off"><label class="cp-field"><span>${esc(t('Miejsce lub adres','Place or address'))}</span><input id="xpAddName" name="name" required maxlength="120" placeholder="${esc(t('np. kawiarnia albo ulica i numer','e.g. a café or a street address'))}"></label>
        <label class="cp-field"><span>${esc(t('Notatka (opcjonalnie)','Note (optional)'))}</span><input name="note" maxlength="160" placeholder="${esc(t('np. obiad, bilety kupione','e.g. lunch, tickets bought'))}"></label>
        <span class="xa-addform-btns"><button type="submit" class="btn-grad"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do planu','Add to plan'))}</button><button type="button" class="btn-ghost" data-xp-add-cancel>${esc(t('Anuluj','Cancel'))}</button></span></form>`
      :`<div class="xa-planbtns"><button type="button" class="btn-ghost xa-own" data-xp-add-open><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj własne miejsce','Add your own place'))}</button>${sugg?'':`<button type="button" class="btn-grad" data-xp-sugg-open><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(t('Zaproponuj trasę','Suggest a route'))}</button>`}</div>`):'';
    return `${sugg?suggestHtml(sugg,C,{t,startTime,n}):''}${head}${n?`<ol class="xa-plan">${rows}</ol>${sum}`:sugg?'':`<div class="empty-note">${esc(t('Plan jest pusty. Dodaj miejsca z zakładki „Atrakcje”, dodaj własne miejsce albo poproś o propozycję trasy na wybrany czas.','The plan is empty. Add places from the Sights tab, add your own, or ask for a route suggestion for the time you have.'))}</div>`}${form}`;
  }
  // Propozycja trasy: wybór czasu, lista z godzinami i rodzajami, „Użyj tej trasy”.
  const BUDGETS=[120,240,360,480];
  function suggestHtml({budget=240, list=[]}, C, {t=PL, startTime='09:00', n=0}={}){
    const T=totals(list, C), S=schedule(list, C, startTime), kinds=[...new Set(list.map(x=>kindLabel(x.kind,t)).filter(Boolean))];
    return `<section class="xa-sugg" aria-labelledby="xaSuggH"><div class="xa-sugg-head"><h5 id="xaSuggH"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(t('Propozycja trasy','Suggested route'))}</h5><button type="button" class="xa-icon" data-xp-sugg-close aria-label="${esc(t('Zamknij propozycję','Close the suggestion'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
      <p class="xa-sugg-tx">${esc(t('Ile masz czasu? Dobieramy najciekawsze miejsca różnego rodzaju tak, żeby zwiedzanie i dojścia zmieściły się w tym czasie.','How much time do you have? We pick the best-known places of different kinds so that visits and walking fit in it.'))}</p>
      <div class="xa-kinds" role="group" aria-label="${esc(t('Czas na zwiedzanie','Time for sightseeing'))}">${BUDGETS.map(b=>`<button type="button" class="xa-kind${b===budget?' on':''}" data-xp-budget="${b}" aria-pressed="${b===budget}">${esc(fmtMin(b,t))}</button>`).join('')}</div>
      ${list.length?`<ol class="xa-sugg-list">${list.map((x,i)=>`<li><span class="xa-num" aria-hidden="true">${i+1}</span><span><b>${esc(x.title||x.name)}</b><small>${S[i].arrive}–${S[i].leave} · ${esc([kindLabel(x.kind,t), fmtMin(visitMin(x),t), T.legs[i]!=null?`${t('dojście','walk')} ${fmtMin(walkMin(T.legs[i]),t)}`:''].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ol>
        <p class="xa-sugg-sum">${esc(t(`Razem ${fmtMin(T.totalMin,t)}: ${plural(list.length,t)}${kinds.length?` (${kinds.join(', ')})`:''}, ${fmtKm(T.km,t)} pieszo.`,`Total ${fmtMin(T.totalMin,t)}: ${plural(list.length,t)}${kinds.length?` (${kinds.join(', ')})`:''}, ${fmtKm(T.km,t)} on foot.`))}</p>
        <div class="xa-addform-btns"><button type="button" class="btn-grad" data-xp-sugg-use="replace"><i class="fa-solid fa-check" aria-hidden="true"></i> ${esc(n?t('Zastąp mój plan','Replace my plan'):t('Użyj tej trasy','Use this route'))}</button>${n?`<button type="button" class="btn-ghost" data-xp-sugg-use="append">${esc(t('Dopisz do planu','Add to my plan'))}</button>`:''}</div>`
      :`<div class="empty-note">${esc(t('Brak atrakcji z położeniem, które zmieszczą się w tym czasie.','No attractions with a map position fit in this time.'))}</div>`}</section>`;
  }
  function askHtml({thread=[], busy=false, err='', byId=new Map(), inPlan=new Set(), edit=true, t=PL, city=''}={}){
    const ex=[t('Co warto zobaczyć tu w jeden dzień?',`What to see in ${city||'the city'} in one day?`), t('Gdzie zjeść coś lokalnego blisko mojej trasy?','Where to eat local food near my route?'), t('Czy moja trasa ma sensowną kolejność?','Is my route in a sensible order?')];
    const turns=thread.map((h,hi)=>`<div class="xp-turn"><p class="xp-q"><i class="fa-regular fa-user" aria-hidden="true"></i> ${esc(h.q)}</p><div class="xp-a">${String(h.a||'').split(/\n{2,}/).map(p=>`<p>${esc(p).replace(/\n/g,'<br>')}</p>`).join('')}
      ${(h.places||[]).length?`<ul class="xp-sugg">${h.places.map((p,pi)=>{ const a=p.id&&byId.get(p.id), inp=a&&inPlan.has(a.id);
        return `<li><span><b>${esc(a?.title||p.name)}</b>${p.why?` <small>${esc(p.why)}</small>`:''}</span>${edit?(inp?`<span class="xp-in"><i class="fa-solid fa-check" aria-hidden="true"></i> ${esc(t('W trasie','In route'))}</span>`:`<button type="button" class="btn-ghost" data-xp-ask-add="${hi}:${pi}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Do trasy','Add'))}</button>`):''}</li>`; }).join('')}</ul>`:''}</div></div>`).join('');
    return `<div class="xa-ask">
      ${turns}${busy?`<div class="empty-note" role="status">${esc(t('Myślę nad odpowiedzią…','Thinking…'))}</div>`:''}${err?`<div class="empty-note ai-err" role="alert">${esc(err)}</div>`:''}
      ${!thread.length&&!busy?`<div class="xp-ex">${ex.map(q=>`<button type="button" class="near-cat" data-xp-ask-ex="${esc(q)}">${esc(q)}</button>`).join('')}</div>`:''}
      <form class="xp-ask-form" data-xp-ask-form><label class="visually-hidden" for="xpAskQ">${esc(t('Twoje pytanie','Your question'))}</label><input id="xpAskQ" name="q" maxlength="500" required placeholder="${esc(t('Zapytaj o miasto, zabytki, jedzenie, dojazdy…','Ask about the city, sights, food, getting around…'))}" ${busy?'disabled':''}>
        <button type="submit" class="btn-grad" ${busy?'disabled':''}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ${esc(t('Zapytaj','Ask'))}</button>${thread.length?`<button type="button" class="btn-ghost" data-xp-ask-clear>${esc(t('Nowa rozmowa','New chat'))}</button>`:''}</form>
      <small class="ai-foot">${esc(t('Odpowiada AI na podstawie Wikipedii i Twojej trasy. Godziny otwarcia i ceny sprawdź przed wyjściem.','Answered by AI from Wikipedia and your route. Check opening hours and prices before you go.'))}</small></div>`;
  }


  root.PVX={esc, km, legs, totals, shortest, mapsUrl, walkMin, fmtKm, fmtMin, visitMin, originOf, schedule, suggest, whereHtml, suggestHtml, headHtml, tabsHtml, attrListHtml, detailHtml, planHtml, askHtml, KIND};
})(typeof window!=='undefined'?window:globalThis);
