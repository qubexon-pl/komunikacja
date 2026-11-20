"use strict";
/* „Przewodnik po aplikacji” (the same walk-through as in Podavo Clean): each step opens its page, lights up the element
   it talks about and explains it in a card next to it. Offered once per device on the first visit (a small card, not
   blocking the page) and always available from the „?” button in the top bar and from the Konto menu.
   Loaded before app.js so it can read „?tour=1” (link from the welcome page) before the app rewrites the address. */
(function(){
  const KEY='onward.tour';
  const startNow=new URLSearchParams(location.search).has('tour');
  const phone=()=>matchMedia('(max-width:760px)').matches;
  const guest=()=>document.body.classList.contains('guest');
  const go=(view, sub)=>{ if(typeof goPage==='function') goPage(view, sub||''); };

  /* Each step: title, text; optional: open (page to show first), target (CSS selectors, the first visible one wins),
     phone (added on phones), guest / user (text that depends on being signed in), optional (skip when nothing to light). */
  const STEPS=[
    { title:'Witaj w podavo.voyage!',
      text:'Tu zaplanujesz podróż autobusem, pociągiem, samolotem albo samochodem, sprawdzisz kierunki lotów i komunikację miejską na żywo. Pokażemy Ci w minutę, gdzie co jest.' },
    { title:'Dokąd jedziesz?', open:()=>go('podroz',''),
      target:'#planForm',
      text:'Zacznij tutaj: wpisz, skąd i dokąd jedziesz, i wybierz datę. Porównamy autobusy, pociągi, loty i samochód w jednym planie.' },
    { title:'Rodzaj podróży', open:()=>go('podroz',''),
      target:'.trip-tabs',
      text:'W jedną stronę, w obie strony albo „Wiele miejsc”: zaplanujesz kilka etapów, np. Rzeszów → Gdańsk → Wrocław.' },
    { title:'Czym jedziesz', open:()=>go('podroz',''),
      target:'#plModes',
      text:'Odznacz środki transportu, których nie chcesz. Przy lotach ustawisz też preferowane lotnisko i promień, w jakim go szukać.' },
    { title:'Sprawdź kierunki', open:()=>go('podroz','kierunki'),
      target:'#explore .explore-map-wrap, .view-tab[data-view="kierunki"], .bottom-nav [data-sub="kierunki"]',
      text:'Mapa lotów tanich linii z polskich lotnisk. Kliknij kierunek, żeby zobaczyć ceny i dni lotów, albo lotnisko, żeby je dodać lub usunąć.' },
    { title:'Komunikacja miejska', open:()=>go('podroz',''),
      target:'.view-tab[data-view="transit"], .bottom-nav [data-transit]',
      text:'Autobusy miejskie i podmiejskie na żywo, rozkłady jazdy i pociągi. Spóźnione pojazdy zaznaczamy na mapie.' },
    { title:'Pogoda', target:'#wx', optional:true,
      text:'Aktualna pogoda i prognoza na najbliższe godziny.' },
    { title:'Moje podróże',
      target:'#myTripsLink, .bottom-nav [data-proxy="myTripsLink"]',
      text:'Zaplanowane podróże w jednym miejscu, z planem krok po kroku i pogodą na miejscu.' },
    { title:'Ulubione',
      target:'#favLink, .bottom-nav [data-proxy="favLink"]',
      text:'Zapisane trasy, przystanki, stacje i podróże. Gwiazdka przy wyniku dodaje go tutaj.' },
    { title:'Komunikaty', target:'#alertsBtn',
      text:'Utrudnienia w komunikacji, stan danych na żywo i Twoje alerty cenowe lotów.' },
    { title:'Konto', target:'#userMenu',
      guest:'Zaloguj się, żeby zapisywać podróże i ulubione na wszystkich urządzeniach. Jedno konto Podavo działa we wszystkich aplikacjach Podavo.',
      user:'Motyw, hasło, wylogowanie i usuwanie konta. Tu też pobierzesz aplikację i ponownie otworzysz ten przewodnik.' },
    { title:'Gotowe!', target:'[data-tour="help"], #userMenu',
      text:'Przewodnik zawsze otworzysz ponownie przyciskiem ze znakiem zapytania albo z menu Konto. Szerokiej drogi!',
      phone:'Na telefonie znajdziesz go w menu Konto.' },
  ];

  /* ---------- remembered per device ---------- */
  const seen=()=>{ try{ return localStorage.getItem(KEY); }catch(e){ return 'later'; } };
  const markSeen=how=>{ try{ localStorage.setItem(KEY, how); }catch(e){ /* private mode: the card may come back */ } };

  /* ---------- geometry ---------- */
  const visible=el=>{ const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) return false; const s=getComputedStyle(el); return s.visibility!=='hidden' && s.display!=='none'; };
  function findTarget(selector){
    if(!selector) return null;
    // Each selector in order, so the list states a preference (top bar on a computer, bottom bar on a phone).
    for(const one of selector.split(/,(?![^[]*\])/)){
      const hit=[...document.querySelectorAll(one.trim())].find(visible);
      if(hit) return hit;
    }
    return null;
  }
  function boxOf(el){
    const r=el.getBoundingClientRect(), pad=6, edge=3;
    const top=Math.max(edge, r.top-pad), left=Math.max(edge, r.left-pad);
    const bottom=Math.min(innerHeight-edge, r.bottom+pad), right=Math.min(innerWidth-edge, r.right+pad);
    return { top, left, width:right-left, height:bottom-top };
  }

  /* ---------- the overlay ---------- */
  let ui=null;
  function build(){
    const root=document.createElement('div');
    root.className='tour'; root.setAttribute('role','presentation');
    root.innerHTML=`<div class="tour__shade"></div>
      <div class="tour__spot" aria-hidden="true" hidden><span class="tour__pulse"></span></div>
      <div class="tour__card" role="dialog" aria-modal="true" aria-labelledby="tourH" aria-describedby="tourT" tabindex="-1">
        <div class="tour__top"><span class="tour__badge"><i class="fa-regular fa-compass" aria-hidden="true"></i> Przewodnik</span>
          <button type="button" class="tour__close" aria-label="Zamknij przewodnik"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
        <p class="tour__count" aria-live="polite"></p>
        <h2 id="tourH"></h2>
        <p id="tourT"></p>
        <div class="tour__dots" aria-hidden="true"></div>
        <div class="tour__actions"><button type="button" class="tour__btn tour__btn--ghost" data-tour-back></button><button type="button" class="tour__btn" data-tour-next></button></div>
      </div>`;
    document.body.appendChild(root);
    const $=s=>root.querySelector(s);
    return { root, shade:$('.tour__shade'), spot:$('.tour__spot'), card:$('.tour__card'), count:$('.tour__count'), h:$('#tourH'), t:$('#tourT'),
      dots:$('.tour__dots'), back:$('[data-tour-back]'), next:$('[data-tour-next]'), close:$('.tour__close') };
  }

  const state={ i:0, steps:[], el:null, box:null, timers:[], opener:null };
  function clearTimers(){ state.timers.forEach(t=>{ clearInterval(t); clearTimeout(t); cancelAnimationFrame(t); }); state.timers=[]; }

  function place(){
    const c=ui.card, vw=innerWidth, vh=innerHeight, w=c.offsetWidth, h=c.offsetHeight, gap=14, m=12, box=state.box;
    let top, left;
    if(!box){ top=Math.max(m,(vh-h)/2); left=Math.max(m,(vw-w)/2); }
    else{
      top=box.top+box.height+gap;
      if(top+h>vh-m) top=box.top-h-gap;
      if(top<m) top=vw<640 ? (box.top>vh/2 ? m : vh-h-m) : Math.min(vh-h-m, Math.max(m, box.top));
      left=box.left+box.width/2-w/2;
      // No room above or below on a wide screen: beside the element.
      if(vw>=640 && top+h>box.top && top<box.top+box.height) left=box.left+box.width+gap+w<vw-m ? box.left+box.width+gap : box.left-w-gap;
      left=Math.min(vw-w-m, Math.max(m, left));
    }
    c.style.top=top+'px'; c.style.left=left+'px';
  }
  function light(){
    const box=state.el && document.contains(state.el) && visible(state.el) ? boxOf(state.el) : null;
    state.box=box;
    ui.spot.hidden=!box; ui.shade.classList.toggle('is-full', !box);
    if(box) Object.assign(ui.spot.style, { top:box.top+'px', left:box.left+'px', width:box.width+'px', height:box.height+'px' });
    place();
  }
  const follow=()=>{ if(ui) light(); };

  function show(i){
    clearTimers();
    state.i=i;
    const step=state.steps[i], n=state.steps.length, last=i===n-1;
    if(step.open) step.open();
    ui.count.textContent=`Krok ${i+1} z ${n}`;
    ui.h.textContent=step.title;
    const text=(guest()?step.guest:step.user)||step.text;
    ui.t.textContent=text+(step.phone && phone() && !document.querySelector('[data-tour="help"]')?.offsetParent ? ' '+step.phone : '');
    ui.dots.innerHTML=state.steps.map((s,k)=>`<span class="${k===i?'is-on':k<i?'is-past':''}"></span>`).join('');
    ui.back.textContent=i>0?'← Wstecz':'Pomiń';
    ui.next.textContent=last?'Zakończ':i===0?'Zaczynamy →':'Dalej →';
    state.el=null; light();
    ui.card.focus({preventScroll:true});
    // The element may appear a moment after the page opens; scroll it into view once, then follow it.
    let tries=0, scrolled=false;
    const seek=()=>{
      const el=findTarget(step.target);
      if(el){
        state.el=el;
        const r=el.getBoundingClientRect();
        if(!scrolled && (r.top<70 || r.bottom>innerHeight-90)){ scrolled=true; el.scrollIntoView({block:'center', behavior:'smooth'}); }
        light();
      } else if(step.target && tries++<60) state.timers.push(requestAnimationFrame(seek));
    };
    seek();
    const settle=setInterval(follow, 120);
    state.timers.push(settle, setTimeout(()=>clearInterval(settle), 1500));
  }

  function keys(e){
    if(!ui) return;
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    else if(e.key==='ArrowRight') next();
    else if(e.key==='ArrowLeft') back();
    else if(e.key==='Tab'){ // keep focus inside the card
      const f=[...ui.card.querySelectorAll('button')]; if(!f.length) return;
      const first=f[0], lastEl=f[f.length-1];
      if(e.shiftKey && document.activeElement===first){ e.preventDefault(); lastEl.focus(); }
      else if(!e.shiftKey && document.activeElement===lastEl){ e.preventDefault(); first.focus(); }
    }
  }
  const next=()=>state.i===state.steps.length-1 ? close() : show(state.i+1);
  const back=()=>state.i>0 ? show(state.i-1) : close();

  function open(){
    hideSuggestion();
    markSeen('done');
    if(ui) return;
    // Optional steps (install, weather) only when there is something to show on this device.
    state.steps=STEPS.filter(s=>!s.optional || findTarget(s.target));
    state.opener=document.activeElement;
    document.querySelectorAll('.modal.show').forEach(m=>window.bootstrap?.Modal.getInstance(m)?.hide());
    ui=build();
    ui.next.addEventListener('click', next);
    ui.back.addEventListener('click', back);
    ui.close.addEventListener('click', close);
    ui.shade.addEventListener('click', e=>e.stopPropagation());
    addEventListener('keydown', keys, true);
    addEventListener('resize', follow);
    addEventListener('scroll', follow, true);
    document.body.classList.add('tour-open');
    show(0);
  }
  function close(){
    if(!ui) return;
    clearTimers();
    removeEventListener('keydown', keys, true);
    removeEventListener('resize', follow);
    removeEventListener('scroll', follow, true);
    ui.root.remove(); ui=null;
    document.body.classList.remove('tour-open');
    state.opener?.focus?.({preventScroll:true});
  }

  /* ---------- first-visit suggestion ---------- */
  let card=null;
  function hideSuggestion(){ card?.remove(); card=null; }
  function suggest(){
    if(card || ui || seen()) return;
    card=document.createElement('aside');
    card.className='tour-suggest'; card.setAttribute('aria-labelledby','tourSuggestH');
    card.innerHTML=`<span class="tour-suggest__icon" aria-hidden="true"><i class="fa-regular fa-compass"></i></span>
      <div><h2 id="tourSuggestH">Pierwszy raz w podavo.voyage?</h2>
      <p>Pokażemy Ci w minutę, co możesz tu zrobić. Przewodnik otworzysz też później z menu Konto.</p>
      <div class="tour-suggest__actions"><button type="button" class="tour__btn" data-tour-start>Pokaż mi</button><button type="button" class="tour__btn tour__btn--ghost" data-tour-later>Nie teraz</button></div></div>
      <button type="button" class="tour-suggest__close" aria-label="Zamknij" data-tour-later><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    card.addEventListener('click', e=>{
      if(e.target.closest('[data-tour-start]')) open();
      else if(e.target.closest('[data-tour-later]')){ markSeen('later'); hideSuggestion(); }
    });
    document.body.appendChild(card);
  }
  // Wait until nothing else asks for attention (an alerts dialog that opened by itself, the sign-in check).
  function whenQuiet(fn, tries=0){
    if(document.querySelector('.modal.show') && tries<120) return setTimeout(()=>whenQuiet(fn, tries+1), 500);
    fn();
  }

  window.openTour=open;
  window.addEventListener('load', ()=>{
    document.getElementById('tourHelp')?.addEventListener('click', open);
    document.getElementById('tourBtn')?.addEventListener('click', open);
    if(startNow) setTimeout(()=>whenQuiet(open), 600);
    else setTimeout(()=>whenQuiet(suggest), 1500);
  });
})();
