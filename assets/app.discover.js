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

  root.PVD={esc, sky, card, list};
})(typeof window!=='undefined'?window:globalThis);
