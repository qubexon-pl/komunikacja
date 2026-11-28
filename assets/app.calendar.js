/* Trip calendar ("Moje podróże" → "Kalendarz", /my-trips#calendar): every trip with dates, saved plans from the
   favourites, and the days the traveller blocks (days off that are free for travel, or days that are taken).
   Pure functions that return HTML strings; app.js keeps the state, loads /api/calendar and wires the clicks.
   The look follows the Podavo Clean calendar (month grid, chips, day panel, private events form). */
(function(root){
  'use strict';
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad=n=>String(n).padStart(2,'0');
  const ymd=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const at=day=>new Date(`${day}T12:00:00Z`);
  const addDays=(day,n)=>{ const d=at(day); d.setUTCDate(d.getUTCDate()+n); return ymd(d); };
  const between=(a,b)=>Math.round((at(b)-at(a))/864e5);
  const locale=t=>t('pl','en')==='en'?'en-GB':'pl-PL';
  const fmt=(day,t,opts)=>at(day).toLocaleDateString(locale(t),{timeZone:'UTC', ...opts});

  const TONES={
    trip:['suitcase-rolling','Moja podróż','My trip'],
    plan:['star','Plan z ulubionych','Saved plan'],
    off:['umbrella-beach','Dzień wolny','Day off'],
    busy:['lock','Zajęty','Busy'],
  };
  const toneLabel=(tone,t)=>t(TONES[tone][1],TONES[tone][2]);

  /* Events of the calendar. trips: [{key, tid, title, route, from, to, status:'booked'|'planned', shared}] with
     from/to as YYYY-MM-DD (to may be empty for a one-day trip); blocks: [{id, from, to, kind, note}]. */
  function events(trips, blocks, t){
    const out=[];
    for(const x of trips||[]){
      if(!x||!x.from) continue;
      const to=x.to&&x.to>=x.from?x.to:x.from;
      out.push({id:'t:'+(x.tid||x.key), tone:x.status==='booked'||x.shared?'trip':'plan', from:x.from, to,
        title:x.title||x.route||t('Podróż','Trip'), detail:x.route&&x.route!==x.title?x.route:'', key:x.key||'', tid:x.tid||'', shared:!!x.shared});
    }
    for(const b of blocks||[]){
      if(!b||!b.from) continue;
      out.push({id:'b:'+b.id, blockId:b.id, tone:b.kind==='busy'?'busy':'off', from:b.from, to:b.to&&b.to>=b.from?b.to:b.from,
        title:b.note||toneLabel(b.kind==='busy'?'busy':'off',t), note:b.note||'', kind:b.kind==='busy'?'busy':'off'});
    }
    // Longer events first, so a trip keeps its row across the week; then trips before blocked days.
    const order={trip:0, plan:1, off:2, busy:3};
    return out.sort((a,b)=>a.from.localeCompare(b.from)||between(b.from,b.to)-between(a.from,a.to)||order[a.tone]-order[b.tone]||a.title.localeCompare(b.title));
  }
  const onDay=(list,day)=>list.filter(e=>e.from<=day&&day<=e.to);

  /* Whole weeks of the month, Monday first; month is 'YYYY-MM'. */
  function monthDays(month){
    const first=at(month+'-01'), start=addDays(month+'-01', -((first.getUTCDay()+6)%7));
    const days=Array.from({length:42},(_,i)=>addDays(start,i));
    return days[35].slice(0,7)!==month?days.slice(0,35):days;
  }
  const shiftMonth=(month,n)=>{ const d=at(month+'-01'); d.setUTCMonth(d.getUTCMonth()+n); return ymd(d).slice(0,7); };

  function chip(e, day, weekStart, t){
    const start=e.from===day, end=e.to===day, label=start||day===weekStart;
    return `<span class="tcal-chip tcal-chip--${e.tone}${start?' is-start':''}${end?' is-end':''}"${label?'':' aria-hidden="true"'}>${label?esc(e.title):'&nbsp;'}</span>`;
  }

  function grid({month, selected, today, list, t}){
    const days=monthDays(month), weeks=[];
    const wd=t('Pn Wt Śr Cz Pt So Nd','Mo Tu We Th Fr Sa Su').split(' ');
    for(let w=0; w<days.length/7; w++){
      const week=days.slice(w*7,w*7+7);
      weeks.push(`<div class="tcal-row" role="row">${week.map(day=>{
        const evs=onDay(list,day), outside=day.slice(0,7)!==month;
        const aria=`${fmt(day,t,{weekday:'long', day:'numeric', month:'long'})}${evs.length?`, ${evs.map(e=>e.title).join(', ')}`:''}`;
        return `<button type="button" role="gridcell" class="tcal-day${outside?' is-outside':''}${day===today?' is-today':''}${evs.some(e=>e.tone==='off')?' is-off':''}${evs.some(e=>e.tone==='busy')?' is-busy':''}" data-cal-day="${day}" aria-selected="${day===selected}" aria-label="${esc(aria)}">
          <span class="tcal-num">${+day.slice(8)}</span>
          <span class="tcal-events">${evs.slice(0,3).map(e=>chip(e,day,week[0],t)).join('')}${evs.length>3?`<span class="tcal-more">+${evs.length-3}</span>`:''}</span>
          <span class="tcal-dots" aria-hidden="true">${evs.slice(0,4).map(e=>`<span class="tcal-dot tcal-dot--${e.tone}"></span>`).join('')}</span></button>`;
      }).join('')}</div>`);
    }
    return `<div class="tcal-grid" role="grid" aria-label="${esc(fmt(month+'-15',t,{month:'long', year:'numeric'}))}">
      <div class="tcal-row" role="row">${wd.map(w=>`<span class="tcal-weekday" role="columnheader">${w}</span>`).join('')}</div>${weeks.join('')}</div>`;
  }

  function row(e, t, {canEdit}){
    const span=between(e.from,e.to)+1;
    const when=span>1?`${fmt(e.from,t,{day:'numeric', month:'short'})} – ${fmt(e.to,t,{day:'numeric', month:'short'})} · ${span} ${t('dni','days')}`:t('Cały dzień','All day');
    const [icon]=TONES[e.tone];
    const open=e.blockId?`<b>${esc(e.title)}</b>`
      :`<button type="button" class="tcal-row-open" ${e.shared||!e.key?`data-trip-open="${esc(e.tid)}"`:`data-fav-open="${esc(e.key)}"`}><b>${esc(e.title)}</b></button>`;
    const acts=e.blockId&&canEdit?`<button type="button" class="icon-btn" data-cal-edit="${esc(e.blockId)}" title="${t('Zmień','Edit')}" aria-label="${esc(t('Zmień: ','Edit: ')+e.title)}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
      <button type="button" class="icon-btn" data-cal-remove="${esc(e.blockId)}" title="${t('Usuń','Remove')}" aria-label="${esc(t('Usuń: ','Remove: ')+e.title)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`:'';
    return `<li class="tcal-item tcal-item--${e.tone}"><span class="tcal-ico" aria-hidden="true"><i class="fa-solid fa-${icon}"></i></span>
      <span class="tcal-item-text">${open}<span class="tcal-item-meta"><span class="tcal-status tcal-status--${e.tone}">${toneLabel(e.tone,t)}</span><small>${esc(when)}${e.detail?` · ${esc(e.detail)}`:''}</small></span></span>${acts}</li>`;
  }

  const conflictHtml=(list,t)=>list&&list.length?`<p class="tcal-conflict"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${t('W tych dniach masz też','On these days you also have')}: ${esc(list.join(', '))}. ${t('Możesz zapisać mimo to.','You can save anyway.')}</p>`:'';
  function form(f, t){
    const kind=k=>`<label class="tcal-kind tcal-kind--${k}"><input type="radio" name="calKind" value="${k}"${f.kind===k?' checked':''}> <i class="fa-solid fa-${TONES[k][0]}" aria-hidden="true"></i> ${toneLabel(k,t)}</label>`;
    return `<form class="tcal-form" id="calForm" novalidate aria-label="${f.id?t('Zmień zablokowane dni','Edit blocked days'):t('Zablokuj dni','Block days')}">
      <div class="tcal-kinds" role="radiogroup" aria-label="${t('Rodzaj','Kind')}">${kind('off')}${kind('busy')}</div>
      <div class="tcal-dates">
        <label><small>${t('Od','From')}</small><input type="date" id="calFrom" value="${esc(f.from)}" required></label>
        <label><small>${t('Do','To')}</small><input type="date" id="calTo" value="${esc(f.to)}" min="${esc(f.from)}" required></label>
      </div>
      <label class="tcal-note"><small>${t('Nazwa (opcjonalnie)','Name (optional)')}</small><input id="calNote" maxlength="200" value="${esc(f.note||'')}" placeholder="${t('np. urlop, majówka, praca','e.g. holiday, long weekend, work')}"></label>
      ${f.error?`<p class="tcal-error" role="alert">${esc(f.error)}</p>`:''}
      <div id="calConflict" role="status">${conflictHtml(f.conflicts,t)}</div>
      <div class="tcal-form-acts"><button type="button" class="btn-ghost" data-cal-cancel>${t('Anuluj','Cancel')}</button><button type="submit" class="btn-grad">${f.id?t('Zapisz zmiany','Save changes'):t('Zablokuj','Block')}</button></div>
    </form>`;
  }

  /* The whole calendar tab. state: {month, selected, form, saving}; trips/blocks as for events();
     signedIn: blocking days needs an account (they are kept on it, like the trips). */
  function render({state, trips, blocks, today, signedIn, loaded, t}){
    const list=events(trips, blocks, t), month=state.month||today.slice(0,7), selected=state.selected||today;
    const dayList=onDay(list, selected);
    const title=fmt(month+'-15',t,{month:'long', year:'numeric'});
    const legend=Object.keys(TONES).map(k=>`<li><span class="tcal-dot tcal-dot--${k}" aria-hidden="true"></span>${toneLabel(k,t)}</li>`).join('');
    const upcoming=list.filter(e=>e.to>=today);
    const offDays=list.filter(e=>e.tone==='off'&&e.to>=today).reduce((n,e)=>n+between(e.from<today?today:e.from,e.to)+1,0);
    const blockSection=!signedIn
      ?`<p class="tcal-private"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${t('Zaloguj się, aby blokować dni w kalendarzu.','Sign in to block days in the calendar.')} <a href="/login">${t('Zaloguj się','Sign in')}</a></p>`
      :state.form?form(state.form,t)
      :`<button type="button" class="btn-ghost tcal-add" data-cal-add><i class="fa-solid fa-plus" aria-hidden="true"></i> ${t('Zablokuj dni','Block days')}</button>`;
    return `<section class="tcal" aria-label="${t('Kalendarz podróży','Trip calendar')}">
      <div class="tcal-summary">
        <span>${t('Nadchodzące podróże','Upcoming trips')}: <b>${upcoming.filter(e=>e.tone==='trip').length}</b></span>
        <span>${t('Plany z ulubionych','Saved plans')}: <b>${upcoming.filter(e=>e.tone==='plan').length}</b></span>
        <span>${t('Wolne dni przed Tobą','Days off ahead')}: <b>${offDays}</b></span>
        ${loaded===false&&signedIn?`<span class="tcal-loading"><span class="spin sm" aria-hidden="true"></span> ${t('Wczytuję zablokowane dni…','Loading blocked days…')}</span>`:''}
      </div>
      <div class="tcal-layout">
        <div class="tcal-card tcal-month">
          <header class="tcal-head">
            <button type="button" class="icon-btn" data-cal-shift="-1" aria-label="${t('Poprzedni miesiąc','Previous month')}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <h3>${esc(title)}</h3>
            <button type="button" class="icon-btn" data-cal-shift="1" aria-label="${t('Następny miesiąc','Next month')}"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
            <button type="button" class="btn-ghost tcal-today" data-cal-today>${t('Dziś','Today')}</button>
          </header>
          ${grid({month, selected, today, list, t})}
          <ul class="tcal-legend" aria-label="${t('Legenda','Legend')}">${legend}</ul>
        </div>
        <aside class="tcal-card tcal-side" aria-labelledby="calDayH">
          <h3 id="calDayH">${esc(fmt(selected,t,{weekday:'long', day:'numeric', month:'long'}))}</h3>
          ${dayList.length?`<ul class="tcal-list">${dayList.map(e=>row(e,t,{canEdit:signedIn})).join('')}</ul>`:`<p class="tcal-empty">${t('Nic zaplanowanego tego dnia.','Nothing planned on this day.')}</p>`}
          <div class="tcal-block">
            <h4>${t('Twój czas','Your time')}</h4>
            ${blockSection}
            ${signedIn?`<p class="tcal-private"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${t('Widzisz tylko Ty. Dni wolne pomagają wybrać termin podróży.','Only you can see this. Days off help you pick when to travel.')}</p>`:''}
          </div>
        </aside>
      </div>
    </section>`;
  }

  /* What a block form would overlap (not blocking, only pointed out). */
  function conflicts(f, trips, blocks, t){
    if(!f||!f.from) return [];
    const to=f.to&&f.to>=f.from?f.to:f.from;
    return events(trips, blocks, t).filter(e=>!(f.id&&e.blockId===f.id) && e.from<=to && f.from<=e.to).map(e=>e.title);
  }

  root.PVCAL={conflictHtml, events, monthDays, shiftMonth, render, conflicts, onDay, addDays};
})(typeof window!=='undefined'?window:this);
