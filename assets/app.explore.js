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

  // Lista atrakcji: jeden wiersz na miejsce (miniatura, nazwa, krótki opis) i przycisk „Dodaj do planu”.
  // Kliknięcie wiersza otwiera okno ze szczegółami.
  function attrListHtml({data, kind='', limit=20, inPlan=new Set(), edit=true, err='', t=PL}={}){
    if(err) return `<div class="empty-note">${esc(err)} <button type="button" class="btn-ghost" data-xp-retry>${esc(t('Spróbuj ponownie','Try again'))}</button></div>`;
    if(!data) return `<div class="empty-note" role="status">${esc(t('Szukam atrakcji w Wikipedii…','Looking for attractions on Wikipedia…'))}</div>`;
    const all=data.attractions||[];
    if(!all.length) return `<div class="empty-note">${esc(t('Wikipedia nie opisuje tu atrakcji z położeniem na mapie.','Wikipedia lists no attractions with a map position here.'))}</div>`;
    const there=new Set(all.map(a=>a.kind)), list=all.filter(a=>!kind||a.kind===kind);
    const chips=there.size>2?`<div class="xa-kinds" role="group" aria-label="${esc(t('Rodzaj','Kind'))}">${KIND.filter(([k])=>!k||there.has(k)).map(([k,pl,en])=>`<button type="button" class="xa-kind${k===kind?' on':''}" data-xp-kind="${k}" aria-pressed="${k===kind}">${esc(t(pl,en))}</button>`).join('')}</div>`:'';
    const rows=list.slice(0,limit).map(a=>{ const inp=inPlan.has(a.id), sub=a.description||String(a.extract||'').split('. ')[0];
      return `<li class="xa-row"><button type="button" class="xa-open" data-xa-open="${esc(a.id)}" aria-haspopup="dialog">${a.image?`<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="xa-ic"><i class="fa-solid fa-${KIND_ICON[a.kind]||'landmark'}" aria-hidden="true"></i></span>`}<span class="xa-tx"><b>${esc(a.title)}</b>${sub?`<small>${esc(sub)}</small>`:''}</span></button>
        ${edit?(inp?`<button type="button" class="xa-add on" data-xp-unadd="${esc(a.id)}" aria-pressed="true" aria-label="${esc(t(`Usuń z planu: ${a.title}`,`Remove from plan: ${a.title}`))}"><i class="fa-solid fa-check" aria-hidden="true"></i><span> ${esc(t('W planie','In plan'))}</span></button>`:`<button type="button" class="xa-add" data-xp-add="${esc(a.id)}" aria-label="${esc(t(`Dodaj do planu: ${a.title}`,`Add to plan: ${a.title}`))}"><i class="fa-solid fa-plus" aria-hidden="true"></i><span> ${esc(t('Dodaj do planu','Add to plan'))}</span></button>`):''}</li>`; }).join('');
    const rest=list.length-limit;
    return `${chips}<ol class="xa-list">${rows}</ol>${rest>0?`<button type="button" class="btn-ghost xa-more" data-xp-more>${esc(t(`Pokaż więcej (${rest})`,`Show more (${rest})`))}</button>`:''}
      <small class="cs-src xa-src">${esc(t('Atrakcje z artykułu o mieście i okolicznych artykułów Wikipedii (CC BY-SA 4.0); rodzaje: Wikidata (CC0).','Attractions from the city article and nearby Wikipedia articles (CC BY-SA 4.0); kinds: Wikidata (CC0).'))}</small>`;
  }

  // Okno ze szczegółami atrakcji albo punktu planu: zdjęcie, opis, odległość, dodaj/usuń, dojazd, Wikipedia.
  function detailHtml(a, {inPlan=false, edit=true, fromKm=null, fromLabel='', t=PL}={}){
    const meta=[kindLabel(a.kind,t), a.description, fromKm!=null?`${fmtKm(fromKm,t)} ${t('od','from')} ${fromLabel}`:''].filter(Boolean);
    const id=a.id||'', plan=a.planId||'';
    return `<div class="xa-detail">${a.image?`<img class="xa-detail-img" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">`:''}
      ${meta.length?`<p class="xa-detail-meta">${meta.map(esc).join(' · ')}</p>`:''}
      ${a.extract?`<p class="xa-detail-tx">${esc(a.extract)}</p>`:a.note?`<p class="xa-detail-tx">${esc(a.note)}</p>`:''}
      ${a.lat==null?`<p class="xp-nogeo">${esc(t('Bez położenia na mapie: nie liczymy do niego odległości.','No map position: no distance is counted to it.'))}</p>`:''}
      <div class="xa-detail-act">${edit?(inPlan?`<button type="button" class="btn-ghost" data-xa-m="remove" data-id="${esc(id)}" data-plan="${esc(plan)}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> ${esc(t('Usuń z planu','Remove from plan'))}</button>`:`<button type="button" class="btn-grad" data-xa-m="add" data-id="${esc(id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do planu','Add to plan'))}</button>`):''}
        ${a.lat!=null?`<button type="button" class="btn-ghost" data-xa-m="route" data-id="${esc(id)}" data-plan="${esc(plan)}"><i class="fa-solid fa-route" aria-hidden="true"></i> ${esc(t('Dojazd','Get there'))}</button><a class="btn-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${(+a.lat).toFixed(5)},${(+a.lon).toFixed(5)}" target="_blank" rel="noopener"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> ${esc(t('Mapa','Map'))}</a>`:''}
        ${a.url?`<a class="btn-ghost" href="${esc(a.url)}" target="_blank" rel="noopener"><i class="fa-brands fa-wikipedia-w" aria-hidden="true"></i> Wikipedia</a>`:''}</div>
      ${a.url?`<small class="cs-src">${esc(t('Opis i zdjęcie: Wikipedia, CC BY-SA 4.0.','Text and picture: Wikipedia, CC BY-SA 4.0.'))}</small>`:''}</div>`;
  }

  // Mój plan: punkty po kolei z odległościami (od noclegu do pierwszego, potem między kolejnymi) i sumą.
  function planHtml({items=[], start=null, edit=true, t=PL, adding=false}={}){
    const T=totals(items, start), n=items.length;
    const leg=(d,label)=>d==null?'':`<li class="xa-leg"><i class="fa-solid fa-person-walking" aria-hidden="true"></i> ${esc(fmtKm(d,t))} · ${esc(t('ok.','about'))} ${esc(fmtMin(walkMin(d),t))}${label?` <span>${esc(label)}</span>`:''}</li>`;
    const rows=items.map((x,i)=>`${i===0&&T.fromStart!=null?leg(T.fromStart, t(`od: ${start.label||'nocleg'}`,`from ${start.label||'your stay'}`)):i>0?leg(T.legs[i],''):''}
      <li class="xa-item${x.manual?' manual':''}"><span class="xa-num" aria-hidden="true">${i+1}</span>
        <button type="button" class="xa-item-tx" data-xa-plan="${esc(x.id)}" aria-haspopup="dialog"><b>${esc(x.name)}</b>${x.note?`<small>${esc(x.note)}</small>`:''}${!has(x)?`<small class="xp-nogeo">${esc(t('bez położenia na mapie','no map position'))}</small>`:''}</button>
        ${edit?`<span class="xa-item-act">${n>1?`<button type="button" class="xa-icon" data-xp-move="${esc(x.id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="${esc(t(`Przesuń wyżej: ${x.name}`,`Move up: ${x.name}`))}"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" class="xa-icon" data-xp-move="${esc(x.id)}" data-dir="1" ${i===n-1?'disabled':''} aria-label="${esc(t(`Przesuń niżej: ${x.name}`,`Move down: ${x.name}`))}"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>`:''}<button type="button" class="xa-icon" data-xp-remove="${esc(x.id)}" aria-label="${esc(t(`Usuń z planu: ${x.name}`,`Remove from plan: ${x.name}`))}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></span>`:''}</li>`).join('');
    const sum=n?`<div class="xa-total" role="status"><span><i class="fa-solid fa-ruler" aria-hidden="true"></i> ${esc(t('Razem','Total'))}: <b>${esc(fmtKm(T.km,t))}</b> ${esc(t('w linii prostej','in a straight line'))}${T.walkMin?` · ${esc(t('ok.','about'))} ${esc(fmtMin(T.walkMin,t))} ${esc(t('pieszo','on foot'))}`:''}</span>
      <span class="xa-total-act">${edit&&items.filter(has).length>=3?`<button type="button" class="btn-ghost" data-xp-shortest><i class="fa-solid fa-shuffle" aria-hidden="true"></i> ${esc(t('Ułóż najkrócej','Shortest order'))}</button>`:''}${mapsUrl(items,start)?`<a class="btn-ghost" href="${esc(mapsUrl(items,start))}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> ${esc(t('Trasa w Google Maps','Route in Google Maps'))}</a>`:''}</span></div>`:'';
    const form=edit?(adding?`<form class="xa-addform" data-xp-add-form autocomplete="off"><label class="cp-field"><span>${esc(t('Miejsce lub adres','Place or address'))}</span><input id="xpAddName" name="name" required maxlength="120" placeholder="${esc(t('np. kawiarnia albo ulica i numer','e.g. a café or a street address'))}"></label>
        <label class="cp-field"><span>${esc(t('Notatka (opcjonalnie)','Note (optional)'))}</span><input name="note" maxlength="160" placeholder="${esc(t('np. obiad, bilety kupione','e.g. lunch, tickets bought'))}"></label>
        <span class="xa-addform-btns"><button type="submit" class="btn-grad"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do planu','Add to plan'))}</button><button type="button" class="btn-ghost" data-xp-add-cancel>${esc(t('Anuluj','Cancel'))}</button></span></form>`
      :`<button type="button" class="btn-ghost xa-own" data-xp-add-open><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj własne miejsce','Add your own place'))}</button>`):'';
    return `${n?`<ol class="xa-plan">${rows}</ol>${sum}`:`<div class="empty-note">${esc(t('Plan jest pusty. W zakładce „Atrakcje” dodaj miejsca przyciskiem „Dodaj do planu” albo dodaj własne miejsce.','The plan is empty. Add places from the Sights tab, or add your own place.'))}</div>`}${form}`;
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


  root.PVX={esc, km, legs, totals, shortest, mapsUrl, walkMin, fmtKm, headHtml, tabsHtml, attrListHtml, detailHtml, planHtml, askHtml, KIND};
})(typeof window!=='undefined'?window:globalThis);
