/* Discovery (Phase 5b, docs/PODAVO_REFACTOR.md): the list of places to fly to, from /api/discover (src/discover.js).
   Pure functions that return HTML strings; app.js fetches and wires them.

   Honesty rules: a price is the stored fare an airline gave, shown with when it was collected; the drive to the
   airport is labelled as an estimate; weather appears only when Open-Meteo has a forecast for those days, otherwise
   the card says from when it will. Nothing is filled in from climate averages. */
(function(root){
  'use strict';
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const PL=(pl)=>pl;
  const AIRLINE={RYANAIR:'Ryanair', WIZZ:'Wizz Air'};
  // WMO weather code → [Font Awesome icon, Polish, English]
  function sky(code){
    const c=code==null||code===''?NaN:Number(code);
    if(!Number.isFinite(c)) return null;
    if(c<=1) return ['sun','Słonecznie','Sunny'];
    if(c<=3) return ['cloud-sun','Częściowe zachmurzenie','Partly cloudy'];
    if(c<=48) return ['smog','Mgła','Fog'];
    if(c>=71&&c<=77||c===85||c===86) return ['snowflake','Śnieg','Snow'];
    if(c>=95) return ['cloud-bolt','Burze','Storms'];
    return ['cloud-rain','Deszcz','Rain'];
  }
  function day(d, t){
    try{ return new Date(`${d}T12:00:00Z`).toLocaleDateString(t('pl','en')==='en'?'en-GB':'pl-PL',{weekday:'short', day:'numeric', month:'short', timeZone:'UTC'}); }catch{ return d; }
  }
  const flight=(f,t)=>`${esc(day(f.day,t))}${f.departure?` ${esc(String(f.departure).slice(11,16))}`:''} · ${esc(AIRLINE[f.airline]||f.airlineName||f.airline)} · ${esc(f.from)} → ${esc(f.to)}`;

  function weather(d, t){
    if(d.weather){
      const w=d.weather, s=sky(w.code);
      return `<span class="disc-wx" title="${esc(t('Prognoza Open-Meteo','Open-Meteo forecast'))}">${s?`<i class="fa-solid fa-${s[0]}" aria-hidden="true"></i> <span class="visually-hidden">${esc(t(s[1],s[2]))}</span>`:''}${esc(w.min)}–${esc(w.max)}°C${w.rainChance!=null?` · ${esc(t('deszcz','rain'))} ${esc(w.rainChance)}%`:''}</span>`;
    }
    if(d.weatherFrom) return `<span class="disc-wx none">${esc(t(`Prognoza od ${day(d.weatherFrom,t)}`,`Forecast from ${day(d.weatherFrom,t)}`))}</span>`;
    return '';
  }

  function card(d, o={}){
    const t=o.t||PL, also=(d.alsoAirports||[]).length?` <small>${esc(t('także','also'))} ${esc(d.alsoAirports.join(', '))}</small>`:'';
    const price=d.ret?t('lot w obie strony','return flights'):t('lot w jedną stronę','one-way flight');
    return `<li class="disc-card">
      <div class="disc-main">
        <h4>${esc(d.city)} <small>${esc(d.code)}</small>${also}</h4>
        <div class="disc-country">${esc(d.country||'')}${d.days>1?` · ${esc(t(`loty w ${d.days} dni`,`flights on ${d.days} days`))}`:''}</div>
        <div class="disc-fl"><i class="oi oi-plane" aria-hidden="true"></i> ${flight(d.outbound,t)}</div>
        ${d.ret?`<div class="disc-fl back"><i class="oi oi-plane" aria-hidden="true"></i> ${flight(d.ret,t)}</div>`:''}
        ${weather(d,t)}
      </div>
      <div class="disc-side">
        <div class="disc-price"><small>${esc(t('od','from'))}</small> <b>${esc(d.flightPln)} zł</b><small>${esc(price)} · ${esc(t('1 os.','1 person'))}</small></div>
        ${d.groundPln?`<small class="disc-ground">+ ${esc(t(`ok. ${d.groundPln} zł dojazd na lotnisko (szacunek)`,`about ${d.groundPln} zł to the airport (estimate)`))}</small>`:''}
        <button type="button" class="btn-ghost disc-about" data-disc-about="${esc(d.code)}">${esc(t('O miejscu','About'))}</button>
        <button type="button" class="btn-grad disc-plan" data-disc-plan="${esc(d.code)}">${esc(t('Zaplanuj','Plan'))} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      </div>
    </li>`;
  }

  function collected(at, t){
    if(!at) return '';
    try{ return new Date(at).toLocaleString(t('pl','en')==='en'?'en-GB':'pl-PL',{day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Warsaw'}); }catch{ return ''; }
  }

  function list(answer, o={}){
    const t=o.t||PL, items=(answer?.destinations||[]);
    if(!items.length){
      const msg=answer?.nights
        ?t('Nie mamy zapisanych lotów tam i z powrotem na te dni. Spróbuj innej liczby nocy albo dłuższego okresu.','No stored return flights for these days. Try another number of nights or a longer period.')
        :t('Nie mamy zapisanych lotów z lotnisk w pobliżu w tym okresie.','No stored flights from nearby airports in this period.');
      return `<div class="empty-note">${esc(msg)}</div>`;
    }
    const at=collected(answer.collectedAt,t);
    return `<ol class="disc-list">${items.map(d=>card(d,o)).join('')}</ol>
      <small class="cs-src disc-src">${esc(t('Ceny z zapisanych wyszukiwań linii lotniczych; przed zakupem mogą się zmienić.','Prices from stored airline searches; they may change before you buy.'))}${at?` · ${esc(t(`najnowsza z ${at}`,`newest from ${at}`))}`:''} · ${esc(t('Pogoda: Open-Meteo','Weather: Open-Meteo'))}</small>`;
  }

  /* 5c: a typed wish ("Hiszpania w lutym na weekend do 400 zł", "Rome in March for a week under 300") turned into
     the same filters the selects offer, checked and clamped here, in the browser. Nothing is sent anywhere: no LLM,
     no server. Words it does not understand stay as a name filter, and the chips show what was understood. */
  // per month: stems that may be followed by any ending (Polish: "lutym", "marcu"; English full names), then whole words
  const MONTHS=[
    [['stycz','january'],['jan']],[['lut','february'],['feb']],[['marz','marc','march'],['mar']],[['kwie','april'],['apr']],
    [['may'],['maj','maja','maju']],[['czerw','june'],['jun']],[['lipc','lipie','july'],['jul']],[['sierp','august'],['aug']],
    [['wrze','september'],['sep']],[['paźdz','pazdz','october'],['oct']],[['listop','november'],['nov']],[['grud','december'],['dec']],
  ];
  // Polish country names change their ending ("do Hiszpanii", "we Włoszech"); these stems cover the irregular ones.
  const COUNTRY_ALIAS={'włosz':'Włochy','wlosz':'Włochy','italy':'Włochy','spain':'Hiszpania','niemcz':'Niemcy','germany':'Niemcy','greece':'Grecja','france':'Francja','francji':'Francja','portugal':'Portugalia','uk':'Wielka Brytania','anglii':'Wielka Brytania','england':'Wielka Brytania','britain':'Wielka Brytania','norway':'Norwegia','croatia':'Chorwacja','cyprus':'Cypr','cyprze':'Cypr','malta':'Malta','malcie':'Malta','turkey':'Turcja','turcji':'Turcja','egypt':'Egipt','egipcie':'Egipt','sweden':'Szwecja','denmark':'Dania','danii':'Dania','netherlands':'Holandia','holland':'Holandia','belgium':'Belgia','austria':'Austria','austrii':'Austria','ireland':'Irlandia','irlandii':'Irlandia','georgia':'Gruzja','gruzji':'Gruzja'};
  const fold=s=>String(s||'').toLocaleLowerCase('pl');
  function parseQuery(text, o={}){
    const today=o.today||new Date().toISOString().slice(0,10), countries=o.countries||[];
    let rest=` ${fold(text).replace(/[,.;!?]/g,' ')} `;
    const out={}, take=(re,fn)=>{ rest=rest.replace(re,(...m)=>{ fn(m); return ' '; }); };
    // price: "do 400 zł", "max 400", "poniżej 400", "under 400", "< 400", "400 zł"
    take(/\s(?:do|max|maks\.?|poniżej|ponizej|under|below|up to|<)\s*(\d{2,5})\s*(?:zł|zl|pln)?(?=\s)/, m=>{ out.maxPrice=+m[1]; });
    if(out.maxPrice==null) take(/\s(\d{2,5})\s*(?:zł|zl|pln)(?=\s)/, m=>{ out.maxPrice=+m[1]; });
    // stay
    take(/\s(\d{1,2})\s*(?:noc|noce|nocy|nights?)(?=\s)/, m=>{ out.nights=+m[1]; });
    take(/\s(\d{1,2})\s*(?:dni|dzień|dzien|days?)(?=\s)/, m=>{ if(out.nights==null) out.nights=Math.max(0,+m[1]-1); });
    take(/\s(?:na\s+)?(?:weekend|łikend)(?=\s)/, ()=>{ if(out.nights==null) out.nights=2; });
    take(/\s(?:na\s+|for\s+a\s+|a\s+)?(?:tydzień|tydzien|week)(?=\s)/, ()=>{ if(out.nights==null) out.nights=7; });
    take(/\s(?:w\s+jedną\s+stronę|w\s+jedna\s+strone|one[\s-]way)(?=\s)/, ()=>{ out.nights=0; });
    // month
    const words=rest.split(/\s+/).filter(Boolean), keep=[];
    for(const w of words){
      const i=out.month==null&&/^[a-ząćęłńóśźż]{3,}$/.test(w)?MONTHS.findIndex(([stems,exact])=>exact.includes(w)||stems.some(st=>w.startsWith(st) && (st!=='may'||w==='may'))):-1;
      if(i<0){ keep.push(w); continue; }
      const [y,mo]=today.split('-').map(Number);
      out.month=`${i+1<mo?y+1:y}-${String(i+1).padStart(2,'0')}`;
    }
    rest=` ${keep.join(' ')} `;
    // country: by name or its stem, against the countries in the answer
    for(const w of rest.split(/\s+/).filter(x=>x.length>=4)){
      const alias=Object.entries(COUNTRY_ALIAS).find(([k])=>w.startsWith(k))?.[1];
      const c=alias&&countries.includes(alias)?alias:countries.find(c=>{ const f=fold(c); return f===w || (w.length>=5 && f.slice(0,5)===w.slice(0,5)); });
      if(c){ out.country=c; rest=rest.replace(` ${w} `,' '); break; }
    }
    // validate and clamp
    if(out.maxPrice!=null && !(out.maxPrice>=20 && out.maxPrice<=20000)) delete out.maxPrice;
    if(out.nights!=null) out.nights=[0,2,3,4,5,7].reduce((a,b)=>Math.abs(b-out.nights)<Math.abs(a-out.nights)?b:a, 0);
    out.text=rest.replace(/\s(?:do|na|w|we|z|ze|i|in|to|for|a|the|lot|loty|flights?|tanio|cheap|tanie)(?=\s)/g,' ').replace(/\s+/g,' ').trim();
    return out;
  }
  function queryChips(q, t=PL){
    const c=[];
    if(q.month){ try{ c.push(new Date(q.month+'-15T12:00:00Z').toLocaleDateString(t('pl','en')==='en'?'en-GB':'pl-PL',{month:'long', year:'numeric', timeZone:'UTC'})); }catch{ c.push(q.month); } }
    if(q.nights!=null) c.push(q.nights?t(`${q.nights} ${q.nights<5?'noce':'nocy'}`,`${q.nights} nights`):t('w jedną stronę','one way'));
    if(q.maxPrice!=null) c.push(t(`do ${q.maxPrice} zł`,`up to ${q.maxPrice} zł`));
    if(q.country) c.push(q.country);
    if(q.text) c.push(`„${q.text}”`);
    return c.length?`<div class="disc-chips" aria-live="polite"><span>${esc(t('Szukam:','Looking for:'))}</span>${c.map(x=>`<span class="disc-chip">${esc(x)}</span>`).join('')}</div>`:'';
  }

  // 10d: when the shared catalogue last fetched this from its source (answers are kept for days, so it can be older than today).
  function asOf(at, t){
    const d=new Date(at||''); if(isNaN(d)) return '';
    const day=d.toLocaleDateString(t('pl','en')==='en'?'en-GB':'pl-PL',{day:'numeric', month:'short', year:'numeric'});
    return ` · ${esc(t(`stan na ${day}`,`as of ${day}`))}`;
  }

  /* 6b: "O miejscu", from /api/places/about (src/knowledge.js). Shows only what Wikipedia and Wikidata gave, with the
     attribution their licences ask for; a missing fact is simply not listed. */
  function aboutHtml(info, o={}){
    const t=o.t||PL;
    if(!info?.found) return `<div class="empty-note">${esc(t('Nie znaleźliśmy opisu tego miejsca w Wikipedii.','We found no Wikipedia article about this place.'))}</div>`;
    const f=info.facts||{}, num=n=>Number(n).toLocaleString(t('pl','en')==='en'?'en-GB':'pl-PL');
    const rows=[
      f.country&&[t('Kraj','Country'), esc(f.country)],
      f.population&&[t('Mieszkańcy','Population'), `${esc(num(f.population.value))}${f.population.year?` <small>(${esc(f.population.year)})</small>`:''}`],
      f.elevationM!=null&&[t('Wysokość','Elevation'), `${esc(num(f.elevationM))} m n.p.m.`.replace(' n.p.m.', t(' n.p.m.',' above sea level'))],
      f.timeZone&&[t('Strefa czasowa','Time zone'), esc(f.timeZone)],
      f.website&&[t('Strona miasta','Official website'), `<a href="${esc(f.website)}" target="_blank" rel="noopener">${esc(f.website.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,''))}</a>`],
    ].filter(Boolean);
    const src=(info.sources||[]).map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> (${esc(s.license)})`).join(', ');
    return `<article class="pv-about">
      ${info.image?`<img class="pv-about-img" src="${esc(info.image)}" alt="${esc(info.title)}" loading="lazy" decoding="async">`:''}
      <h4>${esc(info.title)}</h4>${info.description?`<div class="pv-about-desc">${esc(info.description)}</div>`:''}
      ${info.extract?`<p>${esc(info.extract)}</p>`:''}
      ${rows.length?`<dl class="pv-about-facts">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`:''}
      <a class="btn-ghost pv-about-more" href="${esc(info.url)}" target="_blank" rel="noopener">${esc(t('Czytaj dalej w Wikipedii','Read more on Wikipedia'))} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
      ${src?`<small class="cs-src pv-about-src">${esc(t('Źródła:','Sources:'))} ${src}${asOf(info.fetchedAt,t)}</small>`:''}
    </article>`;
  }

  /* 7b: "W okolicy": named places around the stay (or the city centre) from /api/places/nearby (OpenStreetMap).
     Opening hours are OSM's own text, shown as given; nothing is said about "open now" without parsing it. */
  const NEAR_CATS=[['','Wszystko','All','compass'],['sight','Zabytki','Sights','landmark'],['museum','Muzea','Museums','building-columns'],['view','Widoki','Views','binoculars'],['park','Parki','Parks','tree'],['food','Jedzenie','Food','utensils'],['cafe','Kawiarnie','Cafés','mug-hot'],['nightlife','Wieczorem','Evening','martini-glass']];
  const NEAR_ICON=Object.fromEntries(NEAR_CATS.slice(1).map(([k,,,i])=>[k,i]));
  function nearList(answer, o={}){
    const t=o.t||PL, cat=o.cat||'', limit=o.limit||12, all=answer?.places||[], list=all.filter(p=>!cat||p.cat===cat);
    const have=new Set(all.map(p=>p.cat));
    const chips=`<div class="near-cats" role="group" aria-label="${esc(t('Rodzaj miejsc','Kind of place'))}">${NEAR_CATS.filter(([k])=>!k||have.has(k)).map(([k,pl,en,ic])=>`<button type="button" class="near-cat ${k===cat?'on':''}" data-near-cat="${k}" aria-pressed="${k===cat}"><i class="fa-solid fa-${ic}" aria-hidden="true"></i> ${esc(t(pl,en))}</button>`).join('')}</div>`;
    if(!all.length) return `<div class="empty-note">${esc(t('OpenStreetMap nie zna tu nazwanych miejsc do zwiedzania.','OpenStreetMap lists no named places to visit here.'))}</div>`;
    const dist=km=>km<1?`${Math.round(km*1000/10)*10} m`:`${km.toFixed(1).replace('.',t(',','.'))} km`;
    const rows=list.slice(0,limit).map(p=>`<li class="near-row">
        <span class="near-ic"><i class="fa-solid fa-${NEAR_ICON[p.cat]||'location-dot'}" aria-hidden="true"></i></span>
        <span class="near-tx"><b>${esc(p.name)}</b><small>${esc(dist(p.km))}${p.cuisine?` · ${esc(p.cuisine)}`:''}${p.wheelchair==='yes'?` · <i class="fa-solid fa-wheelchair" aria-hidden="true"></i><span class="visually-hidden">${esc(t('dostępne dla wózków','wheelchair accessible'))}</span>`:''}</small>${p.openingHours?`<small class="near-hours" title="${esc(t('Godziny otwarcia z OpenStreetMap','Opening hours from OpenStreetMap'))}"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${esc(p.openingHours)}</small>`:''}</span>
        <span class="near-act">${p.wikipedia?`<button type="button" class="btn-ghost" data-near-about="${esc(p.id)}">${esc(t('O miejscu','About'))}</button>`:''}<button type="button" class="btn-ghost" data-near-route="${esc(p.id)}"><i class="fa-solid fa-route" aria-hidden="true"></i> ${esc(t('Dojazd','Get there'))}</button></span>
      </li>`).join('');
    const more=list.length>limit?`<button type="button" class="btn-ghost near-more" data-near-more>${esc(t(`Pokaż więcej (${list.length-limit})`,`Show more (${list.length-limit})`))}</button>`:'';
    return `${chips}<ol class="near-list">${rows}</ol>${more}<small class="cs-src near-src">${esc(answer.attribution||'© OpenStreetMap contributors')} (${esc(answer.license||'ODbL')})${asOf(answer.fetchedAt,t)}</small>`;
  }

  root.PVD={esc, sky, card, list, parseQuery, queryChips, aboutHtml, nearList, NEAR_CATS};
})(typeof window!=='undefined'?window:globalThis);
