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

  // Odległość każdego punktu od poprzedniego (pierwszego od startu, jeśli jest); null, gdy któryś nie ma współrzędnych.
  function legs(items, start){
    let prev=has(start)?start:null;
    return items.map((x,i)=>{
      const from=i===0?prev:items[i-1];
      const d=has(from)&&has(x)?km(from,x):null;
      return d;
    });
  }
  function totals(items, start){
    const L=legs(items, start), known=L.filter(x=>x!=null), sum=known.reduce((s,x)=>s+x,0);
    return {km:sum, walkMin:known.length?walkMin(sum):0, legs:L, missing:items.filter(x=>!has(x)).length, fromStart:has(start)&&items.length&&L[0]!=null?L[0]:null};
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
  function mapsUrl(items, start){
    const pts=items.filter(has).map(x=>`${(+x.lat).toFixed(5)},${(+x.lon).toFixed(5)}`);
    const all=has(start)?[`${(+start.lat).toFixed(5)},${(+start.lon).toFixed(5)}`, ...pts]:pts;
    if(all.length<2) return '';
    const mid=all.slice(1,-1).slice(0,9);
    return 'https://www.google.com/maps/dir/?'+new URLSearchParams({api:'1', origin:all[0], destination:all[all.length-1], ...(mid.length?{waypoints:mid.join('|')}:{}), travelmode:'walking'}).toString();
  }

  const KIND=[['','Wszystkie','All','star'],['museum','Muzea','Museums','building-columns'],['sacral','Kościoły i świątynie','Churches','church'],['castle','Zamki i pałace','Castles and palaces','chess-rook'],['monument','Pomniki','Monuments','monument'],['park','Parki i natura','Parks and nature','tree'],['square','Place i stare miasto','Squares','map'],['building','Budowle','Buildings','archway'],['heritage','Zabytki','Heritage','landmark'],['sight','Inne','Other','location-dot']];
  const KIND_ICON=Object.fromEntries(KIND.map(([k,,,i])=>[k,i]));

  // Krótka karta miasta z „O miejscu” (/api/places/about).
  function cityHtml(info, t=PL){
    if(!info) return `<div class="xp-city xp-city-wait">${esc(t('Wczytuję informacje o mieście…','Loading city information…'))}</div>`;
    if(!info.found) return '';
    const f=info.facts||{}, n=v=>Number(v).toLocaleString(t('pl-PL','en-GB'));
    const facts=[f.country&&['flag',f.country], f.population&&['users',`${n(f.population.value)} ${t('mieszk.','people')}${f.population.year?` (${f.population.year})`:''}`], f.elevationM!=null&&['mountain',`${n(f.elevationM)} m n.p.m.`], f.timeZone&&['clock',f.timeZone]].filter(Boolean);
    return `<div class="xp-city">${info.image?`<img class="xp-city-img" src="${esc(info.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}
      <div class="xp-city-tx"><b>${esc(info.title)}</b>${info.description?`<small>${esc(info.description)}</small>`:''}
      ${info.extract?`<p class="xp-clamp">${esc(info.extract)}</p>`:''}
      ${facts.length?`<span class="xp-facts">${facts.map(([i,v])=>`<span><i class="fa-solid fa-${i}" aria-hidden="true"></i> ${esc(v)}</span>`).join('')}</span>`:''}
      <span class="xp-links">${info.url?`<a class="btn-ghost" href="${esc(info.url)}" target="_blank" rel="noopener"><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i> Wikipedia</a>`:''}${f.website?`<a class="btn-ghost" href="${esc(f.website)}" target="_blank" rel="noopener"><i class="fa-solid fa-globe" aria-hidden="true"></i> ${esc(t('Strona miasta','City website'))}</a>`:''}<button type="button" class="btn-ghost" data-xp-about><i class="fa-solid fa-landmark" aria-hidden="true"></i> ${esc(t('Więcej','More'))}</button></span></div></div>`;
  }

  // Moja trasa: kolejne punkty z odległościami (od noclegu do pierwszego, potem między kolejnymi) i sumą.
  function planHtml({items=[], start=null, edit=true, t=PL, adding=false}={}){
    const T=totals(items, start), n=items.length;
    const leg=(d,label)=>d==null?'':`<li class="xp-leg" aria-label="${esc(t(`${fmtKm(d,t)} ${label}`,`${fmtKm(d,t)} ${label}`))}"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${esc(fmtKm(d,t))} · ${esc(t('ok.','about'))} ${esc(fmtMin(walkMin(d),t))}${label?` <span>${esc(label)}</span>`:''}</li>`;
    const rows=items.map((x,i)=>`${i===0&&T.fromStart!=null?leg(T.fromStart, t(`od: ${start.label||'nocleg'}`,`from ${start.label||'your stay'}`)):i>0?leg(T.legs[i],''):''}
      <li class="xp-item${x.manual?' manual':''}"><span class="xp-num" aria-hidden="true">${i+1}</span>
        <div class="xp-item-tx"><b>${esc(x.name)}</b>${x.note?`<small>${esc(x.note)}</small>`:''}${!has(x)?`<small class="xp-nogeo"><i class="fa-solid fa-circle-question" aria-hidden="true"></i> ${esc(t('Bez położenia na mapie: nie liczymy odległości','No map position: distance not counted'))}</small>`:''}</div>
        <div class="xp-item-act">${edit&&n>1?`<span class="lp-move"><button type="button" class="btn-ghost" data-xp-move="${esc(x.id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="${esc(t('Przesuń wyżej','Move up'))}" title="${esc(t('Przesuń wyżej','Move up'))}"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" class="btn-ghost" data-xp-move="${esc(x.id)}" data-dir="1" ${i===n-1?'disabled':''} aria-label="${esc(t('Przesuń niżej','Move down'))}" title="${esc(t('Przesuń niżej','Move down'))}"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button></span>`:''}${has(x)?`<button type="button" class="btn-ghost" data-xp-route="${esc(x.id)}"><i class="fa-solid fa-route" aria-hidden="true"></i> ${esc(t('Dojazd','Get there'))}</button>`:''}${x.url?`<a class="btn-ghost" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Wikipedia: ${esc(x.name)}"><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i></a>`:''}${edit?`<button type="button" class="btn-ghost" data-xp-remove="${esc(x.id)}" aria-label="${esc(t(`Usuń z trasy: ${x.name}`,`Remove from route: ${x.name}`))}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>`:''}</div></li>`).join('');
    const sum=n?`<div class="xp-total" role="status"><span><i class="fa-solid fa-ruler" aria-hidden="true"></i> ${esc(t('Razem','Total'))}: <b>${esc(fmtKm(T.km,t))}</b> ${esc(t('w linii prostej','in a straight line'))}${T.walkMin?` · ${esc(t('ok.','about'))} ${esc(fmtMin(T.walkMin,t))} ${esc(t('pieszo','on foot'))}`:''}${T.missing?` · ${esc(t(`${T.missing} bez położenia`,`${T.missing} without position`))}`:''}</span>
      <span class="xp-total-act">${edit&&items.filter(has).length>=3?`<button type="button" class="btn-ghost" data-xp-shortest><i class="fa-solid fa-shuffle" aria-hidden="true"></i> ${esc(t('Ułóż najkrócej','Shortest order'))}</button>`:''}${mapsUrl(items,start)?`<a class="btn-ghost" href="${esc(mapsUrl(items,start))}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> ${esc(t('Trasa w Google Maps','Route in Google Maps'))}</a>`:''}</span></div>`:'';
    const form=edit?(adding?`<form class="xp-add" data-xp-add-form autocomplete="off"><label class="cp-field"><span>${esc(t('Miejsce lub adres','Place or address'))}</span><input id="xpAddName" name="name" required maxlength="120" placeholder="${esc(t('np. Kawiarnia Szafa albo ul. Floriańska 1','e.g. a café or a street address'))}"></label>
        <label class="cp-field"><span>${esc(t('Notatka (opcjonalnie)','Note (optional)'))}</span><input name="note" maxlength="160" placeholder="${esc(t('np. obiad, bilety kupione','e.g. lunch, tickets bought'))}"></label>
        <span class="xp-add-btns"><button type="submit" class="btn-grad"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do trasy','Add to route'))}</button><button type="button" class="btn-ghost" data-xp-add-cancel>${esc(t('Anuluj','Cancel'))}</button></span></form>`
      :`<button type="button" class="btn-ghost xp-add-open" data-xp-add-open><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj własne miejsce','Add your own place'))}</button>`):'';
    return `<div class="xp-plan"><h5><i class="fa-solid fa-route" aria-hidden="true"></i> ${esc(t('Moja trasa zwiedzania','My sightseeing route'))} <small>${n?esc(t(`${n} ${n===1?'miejsce':n<5?'miejsca':'miejsc'}`,`${n} ${n===1?'place':'places'}`)):''}</small></h5>
      ${n?`<ol class="xp-list">${rows}</ol>${sum}`:`<div class="empty-note">${esc(t('Trasa jest pusta. Dodaj atrakcje z listy poniżej albo własne miejsce.','The route is empty. Add attractions from the list below or your own place.'))}</div>`}${form}</div>`;
  }

  // Atrakcje z Wikipedii: rodzaje do wyboru, sortowanie, karta z opisem i przyciskiem „Dodaj do trasy”.
  function attractionsHtml({data, kind='', sort='popular', limit=12, inPlan=new Set(), open=new Set(), edit=true, err='', t=PL}={}){
    const head=`<h5><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i> ${esc(t('Atrakcje z Wikipedii','Attractions from Wikipedia'))}${data?.attractions?.length?` <small>${data.attractions.length}</small>`:''}</h5>`;
    if(err) return `<div class="xp-attr">${head}<div class="empty-note">${esc(err)} <button type="button" class="btn-ghost" data-xp-retry>${esc(t('Spróbuj ponownie','Try again'))}</button></div></div>`;
    if(!data) return `<div class="xp-attr">${head}<div class="empty-note">${esc(t('Szukam atrakcji w Wikipedii…','Looking for attractions on Wikipedia…'))}</div></div>`;
    const all=data.attractions||[];
    if(!all.length) return `<div class="xp-attr">${head}<div class="empty-note">${esc(t('Wikipedia nie ma tu opisanych atrakcji z położeniem.','Wikipedia lists no attractions with a position here.'))}</div></div>`;
    const there=new Set(all.map(a=>a.kind)), list=all.filter(a=>!kind||a.kind===kind).slice().sort(sort==='near'?(a,b)=>a.km-b.km:(a,b)=>(b.views||0)-(a.views||0)||a.km-b.km);
    const chips=`<div class="near-cats" role="group" aria-label="${esc(t('Rodzaj atrakcji','Kind of attraction'))}">${KIND.filter(([k])=>!k||there.has(k)).map(([k,pl,en,ic])=>`<button type="button" class="near-cat ${k===kind?'on':''}" data-xp-kind="${k}" aria-pressed="${k===kind}"><i class="fa-solid fa-${ic}" aria-hidden="true"></i> ${esc(t(pl,en))}</button>`).join('')}</div>`;
    const sorter=`<label class="near-range xp-sort"><i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i><select data-xp-sort aria-label="${esc(t('Kolejność','Order'))}"><option value="popular" ${sort!=='near'?'selected':''}>${esc(t('Najpopularniejsze','Most popular'))}</option><option value="near" ${sort==='near'?'selected':''}>${esc(t('Najbliżej centrum','Closest to centre'))}</option></select></label>`;
    const cards=list.slice(0,limit).map(a=>{ const inp=inPlan.has(a.id), more=open.has(a.id);
      return `<li class="xp-card">${a.image?`<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="xp-card-ic"><i class="fa-solid fa-${KIND_ICON[a.kind]||'landmark'}" aria-hidden="true"></i></span>`}
        <div class="xp-card-tx"><b>${esc(a.title)}</b><small>${[a.description, `${fmtKm(a.km,t)} ${t('od centrum','from the centre')}`].filter(Boolean).map(esc).join(' · ')}</small>
          ${a.extract?`<p class="${more?'':'xp-clamp'}">${esc(a.extract)}</p>${a.extract.length>140?`<button type="button" class="xp-more" data-xp-open="${esc(a.id)}" aria-expanded="${more}">${esc(more?t('Zwiń','Less'):t('Czytaj dalej','Read more'))}</button>`:''}`:''}
          <span class="xp-card-act">${edit?(inp?`<button type="button" class="btn-ghost on" data-xp-unadd="${esc(a.id)}" aria-pressed="true"><i class="fa-solid fa-check" aria-hidden="true"></i> ${esc(t('W trasie','In route'))}</button>`:`<button type="button" class="btn-grad" data-xp-add="${esc(a.id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do trasy','Add to route'))}</button>`):''}<a class="btn-ghost" href="${esc(a.url)}" target="_blank" rel="noopener"><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i> Wikipedia</a></span></div></li>`; }).join('');
    const rest=list.length-limit;
    return `<div class="xp-attr"><div class="near-head">${head}<div class="near-tools">${sorter}</div></div>${chips}<ol class="xp-cards">${cards}</ol>${rest>0?`<button type="button" class="btn-ghost near-more" data-xp-more>${esc(t(`Pokaż więcej (${rest})`,`Show more (${rest})`))}</button>`:''}
      <small class="cs-src near-src">${esc(t('Opisy i zdjęcia: Wikipedia (CC BY-SA 4.0), rodzaje miejsc: Wikidata (CC0). Kolejność według czytelności artykułów z ostatnich 30 dni.','Text and pictures: Wikipedia (CC BY-SA 4.0), kinds of places: Wikidata (CC0). Ranked by article views in the last 30 days.'))}</small></div>`;
  }

  // Zapytaj AI: pole pytania, przykładowe pytania i rozmowa (ostatnie pytania z odpowiedziami).
  function askHtml({thread=[], busy=false, err='', byId=new Map(), inPlan=new Set(), edit=true, t=PL, city=''}={}){
    const ex=[t('Co warto zobaczyć tu w jeden dzień?',`What to see in ${city||'the city'} in one day?`), t('Gdzie zjeść coś lokalnego blisko mojej trasy?','Where to eat local food near my route?'), t('Czy moja trasa ma sensowną kolejność?','Is my route in a sensible order?')];
    const turns=thread.map((h,hi)=>`<div class="xp-turn"><p class="xp-q"><i class="fa-regular fa-user" aria-hidden="true"></i> ${esc(h.q)}</p><div class="xp-a">${String(h.a||'').split(/\n{2,}/).map(p=>`<p>${esc(p).replace(/\n/g,'<br>')}</p>`).join('')}
      ${(h.places||[]).length?`<ul class="xp-sugg">${h.places.map((p,pi)=>{ const a=p.id&&byId.get(p.id), inp=a&&inPlan.has(a.id);
        return `<li><span><b>${esc(a?.title||p.name)}</b>${p.why?` <small>${esc(p.why)}</small>`:''}</span>${edit?(inp?`<span class="xp-in"><i class="fa-solid fa-check" aria-hidden="true"></i> ${esc(t('W trasie','In route'))}</span>`:`<button type="button" class="btn-ghost" data-xp-ask-add="${hi}:${pi}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Do trasy','Add'))}</button>`):''}</li>`; }).join('')}</ul>`:''}</div></div>`).join('');
    return `<div class="xp-ask"><h5><i class="fa-solid fa-comments" aria-hidden="true"></i> ${esc(t('Zapytaj AI','Ask AI'))} <small>${esc(t('o miasto, atrakcje i Twoją trasę','about the city, its sights and your route'))}</small></h5>
      ${turns}${busy?`<div class="empty-note" role="status">${esc(t('Myślę nad odpowiedzią…','Thinking…'))}</div>`:''}${err?`<div class="empty-note ai-err" role="alert">${esc(err)}</div>`:''}
      ${!thread.length&&!busy?`<div class="xp-ex">${ex.map(q=>`<button type="button" class="near-cat" data-xp-ask-ex="${esc(q)}">${esc(q)}</button>`).join('')}</div>`:''}
      <form class="xp-ask-form" data-xp-ask-form><label class="visually-hidden" for="xpAskQ">${esc(t('Twoje pytanie','Your question'))}</label><input id="xpAskQ" name="q" maxlength="500" required placeholder="${esc(t('Zapytaj o miasto, zabytki, jedzenie, dojazdy…','Ask about the city, sights, food, getting around…'))}" ${busy?'disabled':''}>
        <button type="submit" class="btn-grad" ${busy?'disabled':''}><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ${esc(t('Zapytaj','Ask'))}</button>${thread.length?`<button type="button" class="btn-ghost" data-xp-ask-clear>${esc(t('Nowa rozmowa','New chat'))}</button>`:''}</form>
      <small class="ai-foot">${esc(t('Odpowiada AI na podstawie Wikipedii i Twojej trasy. Godziny otwarcia i ceny sprawdź przed wyjściem.','Answered by AI from Wikipedia and your route. Check opening hours and prices before you go.'))}</small></div>`;
  }

  root.PVX={esc, km, legs, totals, shortest, mapsUrl, walkMin, fmtKm, cityHtml, planHtml, attractionsHtml, askHtml, KIND};
})(typeof window!=='undefined'?window:globalThis);
