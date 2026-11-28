/* Transport UI: shared presentation pieces for local journeys (route cards, journey timeline, selected-route
   summary on the map). Pure functions that return HTML strings: no fetching, no state, no map calls, so the
   same markup serves the city planner, airport transfers, saved trips and (later) travel-day mode on every
   screen size. Data comes from the existing APIs unchanged (see src/transitous.js `itinerary`).

   Honesty rules (docs/TRANSPORT_REDESIGN.md §8): a leg is "live" only when the operator sent a real-time
   prediction for it (`step.live`); otherwise it is labelled as scheduled. Nothing here invents delays,
   platforms or prices — fields the source did not give are left out. */
(function(root){
  'use strict';
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const PL=(pl)=>pl;
  // kind → [Font Awesome icon, Polish name, English name]
  const MODES={
    walk:['person-walking','Pieszo','Walk'], bus:['bus','Autobus','Bus'], tram:['train-tram','Tramwaj','Tram'],
    rail:['train','Pociąg','Train'], metro:['train-subway','Metro','Metro'], ferry:['ferry','Prom','Ferry'],
    plane:['plane','Samolot','Plane'], car:['car-side','Samochód','Car'], taxi:['taxi','Taksówka','Taxi'],
    stay:['bed','Nocleg','Stay'], transfer:['right-left','Przesiadka','Transfer'], start:['location-dot','Start','Start'],
    arrive:['flag-checkered','Cel','Destination'],
  };
  const mode=k=>MODES[k]||MODES.bus;
  const ride=s=>s && s.kind!=='walk';

  // Minutes from clock a to clock b ("HH:MM"), across midnight.
  function clockGap(a,b){
    if(!/^\d\d:\d\d/.test(a||'') || !/^\d\d:\d\d/.test(b||'')) return null;
    const m=x=>+x.slice(0,2)*60 + +x.slice(3,5);
    return (m(b)-m(a)+1440)%1440;
  }
  function duration(min, t=PL){
    const m=Math.max(0,Math.round(min||0));
    if(m<60) return `${m} min`;
    return t(`${Math.floor(m/60)} godz. ${m%60} min`, `${Math.floor(m/60)} h ${m%60} min`);
  }
  function plural(n, one, few, many){ const d=n%10, h=n%100; return n===1?one:d>=2&&d<=4&&(h<10||h>=20)?few:many; }
  function transfersText(n, t=PL){
    if(!n) return t('bez przesiadek','direct');
    return t(`${n} ${plural(n,'przesiadka','przesiadki','przesiadek')}`, `${n} ${n===1?'transfer':'transfers'}`);
  }

  function chip(s){
    const [ic]=mode(s.kind), own=s.color?` style="--lc:${esc(s.color)};--lt:${esc(s.textColor||'#fff')}"`:'';
    return `<span class="cs-chip ${s.color?'own':esc(s.kind)}"${own}><i class="fa-solid fa-${ic}" aria-hidden="true"></i> ${esc(s.line||'')}</span>`;
  }

  // Real-time state of one ride: 'live' only with an operator prediction; never inferred from refreshing.
  function legStatus(s, t=PL){
    if(!ride(s)) return null;
    if(s.cancelled) return {state:'cancelled', text:t('odwołany','cancelled')};
    if(!s.live) return {state:'scheduled', text:t('wg rozkładu','scheduled')};
    const d=Math.round(s.delayMin||0);
    if(d>0) return {state:d>=3?'late':'minor', text:`+${d} min`};
    if(d<0) return {state:'early', text:t(`${-d} min wcześniej`, `${-d} min early`)};
    return {state:'ontime', text:t('punktualnie','on time')};
  }
  function statusBadge(st, t=PL){
    if(!st) return '';
    const live=st.state!=='scheduled';
    return `<span class="pvt-rt ${esc(st.state)}" title="${esc(live?t('Prognoza przewoźnika na żywo','Live prediction from the operator'):t('Brak danych na żywo — godzina z rozkładu','No live data — timetable time'))}">${live?'<i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> ':'<i class="fa-regular fa-clock" aria-hidden="true"></i> '}${esc(st.text)}</span>`;
  }
  // Whole-trip status: from the first ride (the one you must catch); scheduled unless the operator sent a prediction.
  function tripStatus(trip, t=PL){
    const first=(trip?.steps||[]).find(ride);
    return first?legStatus(first,t):null;
  }

  /* Steps of a planned itinerary → timeline events. A transfer marker goes before every ride after the first one,
     with the time between arriving on the previous ride and leaving on this one (walking included). */
  function stepsToEvents(steps, t=PL){
    const out=[]; let prevRide=null;
    for(const s of steps||[]){
      if(!s) continue;
      if(s.kind==='walk'){
        out.push({kind:'walk', time:s.dep||'', title:t(`Pieszo ${s.minutes||0} min`,`Walk ${s.minutes||0} min`), place:s.to?t(`do: ${s.to}`,`to: ${s.to}`):''});
        continue;
      }
      if(prevRide){
        const gap=clockGap(prevRide.arr, s.dep);
        out.push({kind:'transfer', title:t('Przesiadka','Transfer'), place:gap!=null?t(`${gap} min na przesiadkę`,`${gap} min to change`):'', at:prevRide.to===s.from?s.from:''});
      }
      const [,pl,en]=mode(s.kind);
      const facts=[s.headsign&&t(`kierunek ${s.headsign}`,`towards ${s.headsign}`),
        s.stops?t(`${s.stops} ${plural(s.stops,'przystanek','przystanki','przystanków')}`,`${s.stops} ${s.stops===1?'stop':'stops'}`):'',
        s.minutes?`${s.minutes} min`:'', s.agency||''].filter(Boolean);
      out.push({kind:s.kind, time:s.dep||'', endTime:s.arr||'', title:t(pl,en), line:s, place:[s.from,s.to].filter(Boolean).join(' → '),
        facts, platform:s.platform||'', status:legStatus(s,t)});
      prevRide=s;
    }
    const last=[...(steps||[])].reverse().find(Boolean);
    if(last) out.push({kind:'arrive', time:last.arr||'', title:last.to||t('Cel','Destination')});
    return out;
  }

  /* JourneyTimeline: one vertical timeline for local journeys, airport transfers, saved trips and travel day.
     Essentials (time, event, place, line, status) are always visible; facts are the secondary line. */
  function journeyTimeline(events, o={}){
    const t=o.t||PL;
    const row=e=>{
      const [ic]=mode(e.kind);
      const time=e.time?`<span class="jt-time"><b>${esc(e.time)}</b>${e.endTime?`<small>${esc(e.endTime)}</small>`:''}</span>`:'<span class="jt-time"></span>';
      const head=`<span class="jt-title">${e.line?chip(e.line):''}<b>${esc(e.title)}</b></span>`;
      const meta=[e.place&&`<span class="jt-place">${esc(e.place)}</span>`, e.facts?.length?`<small class="jt-facts">${e.facts.map(esc).join(' · ')}</small>`:''].filter(Boolean).join('');
      const side=[e.platform?`<span class="jt-plat">${esc(t('peron/stan.','platform'))} ${esc(e.platform)}</span>`:'', statusBadge(e.status,t)].join('');
      return `<li class="jt-ev jt-k-${esc(e.kind)}"${e.line?.color?` style="--lc:${esc(e.line.color)}"`:''}>${time}<span class="jt-dot" aria-hidden="true"><i class="fa-solid fa-${ic}"></i></span><span class="jt-body">${head}${meta}</span>${side?`<span class="jt-side">${side}</span>`:''}</li>`;
    };
    return `<ol class="jt${o.dense?' dense':''}">${(events||[]).map(row).join('')}</ol>`;
  }

  // Mode sequence for the collapsed card: walk icon (with minutes) and line chips, joined by chevrons.
  function modeSequence(steps){
    const parts=(steps||[]).filter(Boolean).map(s=>s.kind==='walk'
      ?`<span class="tr-walk" title="${esc(`${s.minutes||0} min`)}"><i class="fa-solid fa-person-walking" aria-hidden="true"></i><small>${esc(s.minutes||0)}</small></span>`
      :chip(s));
    return parts.join('<i class="fa-solid fa-chevron-right tr-sep" aria-hidden="true"></i>');
  }

  /* TransportRouteCard. Collapsed: times, duration, transfers, mode sequence, badges, real-time state.
     Expanded (native <details>, so it keeps working without script and with a keyboard): the timeline.
     The whole head selects the route (the card's one primary action); the rest are secondary. */
  function routeCard(trip, i, o={}){
    const t=o.t||PL, badges=[];
    if(o.fastest) badges.push(`<span class="cs-badge fast"><i class="fa-solid fa-bolt" aria-hidden="true"></i> ${esc(t('Najszybciej','Fastest'))}</span>`);
    if(o.fewest) badges.push(`<span class="cs-badge direct"><i class="fa-solid fa-shuffle" aria-hidden="true"></i> ${esc(t('Najmniej przesiadek','Fewest transfers'))}</span>`);
    const meta=[transfersText(trip.transfers,t), trip.walkMin?t(`${trip.walkMin} min pieszo`,`${trip.walkMin} min walk`):''].filter(Boolean).join(' · ');
    const price=o.price?`<span class="tr-price">${esc(o.price)}</span>`:'';
    const actions=[
      `<button type="button" class="tr-act" data-cp-show="${i}"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> ${esc(t('Pokaż na mapie','Show on map'))}</button>`,
      o.canSave?`<button type="button" class="tr-act" data-cp-save="${i}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(t('Dodaj do planu','Add to plan'))}</button>`:'',
      o.navUrl?`<a class="tr-act" href="${esc(o.navUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i> ${esc(t('Nawiguj','Navigate'))}</a>`:'',
    ].join('');
    return `<article class="tr-card cp-trip${o.selected?' on':''}" data-cp-card="${i}">
      <button type="button" class="tr-head cp-trip-head" data-cp-trip="${i}" aria-pressed="${o.selected?'true':'false'}">
        <span class="tr-row"><span class="tr-dur">${esc(duration(trip.minutes,t))}</span>${price}</span>
        <span class="tr-row"><span class="tr-times">${esc(trip.dep?.clock||'')} – ${esc(trip.arr?.clock||'')}</span><span class="tr-meta">${esc(meta)}</span></span>
        <span class="tr-seq">${modeSequence(trip.steps)}</span>
        ${badges.length||tripStatus(trip,t)?`<span class="tr-badges">${badges.join('')}${statusBadge(tripStatus(trip,t),t)}</span>`:''}
      </button>
      <details class="tr-more" data-cp-more="${i}"${o.open?' open':''}><summary>${esc(t('Szczegóły trasy','Route details'))}</summary>${journeyTimeline(stepsToEvents(trip.steps,t),{t})}</details>
      <div class="tr-actions">${actions}</div>
    </article>`;
  }

  // Floating summary of the selected route over the map (desktop) / bottom sheet (phone map mode).
  function mapSummary(trip, i, o={}){
    if(!trip) return '';
    const t=o.t||PL;
    const legs=(trip.steps||[]).filter(Boolean).map(s=>s.kind==='walk'
      ?`<li class="ms-leg walk"><i class="fa-solid fa-person-walking" aria-hidden="true"></i><span><b>${esc(s.minutes||0)} min</b></span></li>`
      :`<li class="ms-leg">${chip(s)}<span><b>${esc(s.dep||'')} – ${esc(s.arr||'')}</b><small>${esc([s.from,s.to].filter(Boolean).join(' → '))}</small></span></li>`).join('<li class="ms-sep" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></li>');
    return `<div class="ms-head"><b>${esc(t('Wybrana trasa','Selected route'))} · ${esc(duration(trip.minutes,t))}</b><span>${esc(trip.dep?.clock||'')} – ${esc(trip.arr?.clock||'')} · ${esc(transfersText(trip.transfers,t))}</span>${statusBadge(tripStatus(trip,t),t)}
      <button type="button" class="ms-detail" data-cp-detail="${i}">${esc(t('Szczegóły','Details'))} <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>
      <ol class="ms-legs">${legs}</ol>`;
  }

  // "Data as of" line: source and the time the server fetched it, in the journey's zone.
  function freshness(fetchedAt, zone, source, t=PL){
    let at='';
    try{ if(Number.isFinite(fetchedAt)) at=new Date(fetchedAt).toLocaleTimeString('pl-PL',{hour:'2-digit', minute:'2-digit', timeZone:zone||'Europe/Warsaw'}); }catch{ at=''; }
    return `<small class="cs-src pvt-fresh">${esc(source||'Transitous')}${at?` · ${esc(t(`stan na ${at}`,`as of ${at}`))}`:''}${zone?` · ${esc(t('godziny lokalne','local times'))} (${esc(zone)})`:''}</small>`;
  }

  /* DepartureBoard (Phase 4c): one list of departures for every provider, from the shared Departure model of
     /api/transport/departures (src/transport.js): {line, headsign, mode, scheduled, expected, at, delayMin,
     realtime:'live'|'scheduled', platform, track, cancelled, color, textColor}. A delay or "on time" is shown only
     for a live departure; a scheduled one shows its timetable time and nothing else. */
  function departureRow(x, o={}){
    const t=o.t||PL, now=o.now??Date.now(), mins=Math.round((x.at-now)/60000);
    const clock=String(x.expected||'').slice(11,16), planned=String(x.scheduled||'').slice(11,16), live=x.realtime==='live';
    const when=x.cancelled?`<s>${esc(planned||clock)}</s>`:live&&x.delayMin&&planned&&planned!==clock?`<b>${esc(clock)}</b> <s>${esc(planned)}</s>`:`<b>${esc(clock)}</b>`;
    const state=x.cancelled?`<span class="ctx-st cancel">${esc(t('odwołany','cancelled'))}</span>`
      :live?`<span class="ctx-st live">${x.delayMin>0?`+${x.delayMin} min`:x.delayMin<0?`${x.delayMin} min`:esc(t('na czas','on time'))}</span>`:'';
    const where=x.mode==='rail'?(x.platform?` <small>${esc(t('peron','platform'))} ${esc(x.platform)}${x.track?` · ${esc(t('tor','track'))} ${esc(x.track)}`:''}</small>`:'')
      :x.platform?` <small>${esc(t('stan.','stand'))} ${esc(x.platform)}</small>`:'';
    const past=x.at<now-60000, cells=`<span class="ctx-when">${when}<small>${past?'':mins<=0?esc(t('teraz','now')):mins<60?`${mins} min`:''}</small></span>${chip({kind:x.mode, line:x.line, color:x.color, textColor:x.textColor})}<span class="ctx-head-sign">${esc(x.headsign)}${where}</span>${state}`;
    const cls=[x.cancelled?'cancelled':'', past?'past':''].filter(Boolean).join(' ');
    // o.open(x) → [attribute, value]: the row opens something (e.g. the line); o.after(x) → HTML beside it (a star).
    const open=o.open?o.open(x):null, after=o.after?o.after(x):'';
    if(!open && !after) return `<li class="${cls}">${cells}</li>`;
    const inner=open?`<button type="button" class="ctx-dep-open" ${esc(open[0])}="${esc(open[1])}">${cells}</button>`:`<span class="ctx-dep-open">${cells}</span>`;
    return `<li class="${cls} has-open">${inner}${after}</li>`;
  }
  function departureBoard(list, o={}){
    const t=o.t||PL, rows=(list||[]).filter(x=>!o.line||x.line===o.line).map(x=>departureRow(x,o)).join('');
    return rows?`<ol class="ctx-deps">${rows}</ol>`:`<div class="empty-note">${esc(o.empty||t('Brak odjazdów w najbliższym czasie.','No departures soon.'))}</div>`;
  }

  root.PVT={esc, MODES, clockGap, duration, transfersText, chip, legStatus, statusBadge, tripStatus, stepsToEvents, journeyTimeline, modeSequence, routeCard, mapSummary, freshness, departureRow, departureBoard};
})(typeof window!=='undefined'?window:globalThis);
