/* iPhone-style drop-down lists for every <select> in the app.

   A tap, click or keyboard opening of a single-choice <select> shows a floating, rounded list anchored to the field
   (below it, or above when there is more room there) instead of the system menu. The page behind is dimmed and
   blurred, the chosen option is highlighted and scrolled into view, and the list scrolls on its own.

   The <select> stays the source of truth: picking an option sets its value and fires "input" and "change" exactly
   like the native menu, so screens need no changes. Selects added later (rendered by the app) work too, because the
   listener sits on the document.

   Keyboard: Enter, Space, Alt+Down, F4 and the arrow keys open the list; inside it Up/Down, Home/End, PageUp/PageDown
   and type-ahead move, Enter or Space picks, Escape or Tab closes. The list is a labelled listbox whose highlighted
   option is announced through aria-activedescendant.

   Opt out: <select multiple>, <select size="2+"> and <select data-native> keep the system menu.

   Pure helper place() is exported for tests in node:vm. */
(function(root){
  'use strict';
  const GAP=6, EDGE=8, MIN_W=180, MAX_H=420, ROW=44;

  /* Where the list goes. rect: the field's box; vw/vh: the viewport; want: the list's natural height.
     Below the field when it fits (or when there is more room below), otherwise above. */
  function place(rect, vw, vh, want, natural=0){
    const below=vh-rect.bottom-GAP-EDGE, above=rect.top-GAP-EDGE;
    const need=Math.min(want, MAX_H, ROW*5);
    const down=below>=need || below>=above;
    const maxH=Math.max(ROW*2, Math.min(MAX_H, down?below:above));
    const h=Math.min(want, maxH);
    const width=Math.min(Math.max(rect.width, MIN_W, Math.min(natural, 360)), vw-EDGE*2);
    const left=Math.min(Math.max(EDGE, rect.left), vw-EDGE-width);
    const top=down ? rect.bottom+GAP : rect.top-GAP-h;
    return {top:Math.round(top), left:Math.round(left), width:Math.round(width), maxHeight:Math.round(maxH), down};
  }

  const api={place};
  root.PVSelect=api;
  const d=root.document;
  if(!d || !root.addEventListener) return;

  const eligible=el=>el && el.tagName==='SELECT' && !el.multiple && !(el.size>1) && !el.disabled
    && !el.hasAttribute('data-native') && !el.closest('[data-native-selects]');

  function labelOf(sel){
    const a=sel.getAttribute('aria-label'); if(a) return a;
    const by=sel.getAttribute('aria-labelledby'); if(by){ const t=by.split(/\s+/).map(id=>d.getElementById(id)?.textContent||'').join(' ').trim(); if(t) return t; }
    const l=sel.labels?.[0]; if(l){ const c=l.cloneNode(true); c.querySelectorAll('select').forEach(x=>x.remove()); const t=c.textContent.replace(/\s+/g,' ').trim(); if(t) return t; }
    return sel.title||'';
  }

  let cur=null, seq=0, lastTouch=0;

  function close(pick, why){
    if(!cur) return;
    const c=cur; cur=null;
    if(pick!=null && pick!==c.sel.selectedIndex){
      c.sel.selectedIndex=pick;
      c.sel.dispatchEvent(new Event('input', {bubbles:true}));
      c.sel.dispatchEvent(new Event('change', {bubbles:true}));
    }
    c.sel.classList.remove('pv-sel-open');
    c.sel.removeAttribute('aria-expanded');
    root.removeEventListener('resize', c.onWin);
    root.removeEventListener('scroll', c.onScroll, true);
    c.layer.classList.remove('show');
    setTimeout(()=>c.layer.remove(), 160);
    if(why!=='tab' && c.sel.isConnected) c.sel.focus({preventScroll:true});
  }

  function open(sel, byKey){
    if(cur) close(null, 'code');
    if(!sel.options.length) return;
    const id=`pv-sel-${++seq}`;
    const layer=d.createElement('div'); layer.className='pv-sel-layer';
    const field=d.createElement('div'); field.className='pv-sel-field'; field.setAttribute('aria-hidden','true');
    const list=d.createElement('div'); list.className='pv-sel-list'; list.id=id;
    list.setAttribute('role','listbox'); list.tabIndex=-1;
    const name=labelOf(sel); if(name) list.setAttribute('aria-label', name);

    // rows: optgroup headers and options, in order
    const rows=[]; let idx=0;
    const addOpt=(o)=>{
      const i=idx++;
      if(o.hidden) return;
      const r=d.createElement('div'); r.className='pv-sel-opt'; r.id=`${id}-${i}`; r.dataset.i=i;
      r.setAttribute('role','option'); r.setAttribute('aria-selected', o.selected?'true':'false');
      if(o.disabled || o.parentElement?.disabled){ r.setAttribute('aria-disabled','true'); r.classList.add('is-off'); }
      if(o.selected) r.classList.add('is-sel');
      const t=d.createElement('span'); t.className='pv-sel-text'; t.textContent=o.label||o.textContent; r.appendChild(t);
      const ck=d.createElement('i'); ck.className='pv-sel-check fa-solid fa-check'; ck.setAttribute('aria-hidden','true'); r.appendChild(ck);
      list.appendChild(r); rows.push(r);
    };
    for(const ch of sel.children){
      if(ch.tagName==='OPTGROUP'){
        const g=d.createElement('div'); g.className='pv-sel-group'; g.setAttribute('role','presentation'); g.textContent=ch.label; list.appendChild(g);
        for(const o of ch.children) if(o.tagName==='OPTION') addOpt(o);
      } else if(ch.tagName==='OPTION') addOpt(ch);
    }
    if(!rows.length) return;

    // the field, drawn again above the dimmed page so the user sees what they are choosing for
    const cs=root.getComputedStyle(sel), rect=sel.getBoundingClientRect();
    Object.assign(field.style, {top:`${rect.top}px`, left:`${rect.left}px`, width:`${rect.width}px`, height:`${rect.height}px`,
      borderRadius:cs.borderRadius, font:cs.font, paddingLeft:cs.paddingLeft});
    const ft=d.createElement('span'); ft.textContent=sel.selectedOptions[0]?.label||''; field.appendChild(ft);
    const fc=d.createElement('i'); fc.className='fa-solid fa-chevron-up'; field.appendChild(fc);

    layer.append(field, list);
    // inside a Bootstrap modal the list must live in the modal, or its focus trap pulls focus back out
    (sel.closest('.modal, dialog')||d.body).appendChild(layer);

    const position=()=>{
      const r=sel.getBoundingClientRect();
      Object.assign(field.style, {top:`${r.top}px`, left:`${r.left}px`, width:`${r.width}px`, height:`${r.height}px`});
      Object.assign(list.style, {maxHeight:'none', width:'max-content'});
      const natural=Math.ceil(list.getBoundingClientRect().width)+2;
      list.style.width=`${Math.max(r.width, MIN_W)}px`;
      const p=place(r, root.innerWidth, root.innerHeight, list.scrollHeight, natural);
      Object.assign(list.style, {top:`${p.top}px`, left:`${p.left}px`, width:`${p.width}px`, maxHeight:`${p.maxHeight}px`});
      list.classList.toggle('up', !p.down);
    };
    position();

    const enabled=()=>rows.filter(r=>!r.classList.contains('is-off'));
    let active=rows.find(r=>r.classList.contains('is-sel'))||enabled()[0]||rows[0];
    const setActive=(r, scroll=true)=>{
      if(!r) return;
      active?.classList.remove('is-active'); active=r; r.classList.add('is-active');
      list.setAttribute('aria-activedescendant', r.id);
      if(scroll){
        const top=r.offsetTop, bot=top+r.offsetHeight;
        if(top<list.scrollTop) list.scrollTop=top-4;
        else if(bot>list.scrollTop+list.clientHeight) list.scrollTop=bot-list.clientHeight+4;
      }
    };
    setActive(active, false);
    list.scrollTop=Math.max(0, active.offsetTop-(list.clientHeight-active.offsetHeight)/2);

    let typed='', typedAt=0;
    list.addEventListener('keydown', e=>{
      const en=enabled(), i=en.indexOf(active), page=Math.max(1, Math.floor(list.clientHeight/ROW)-1);
      let next=null;
      switch(e.key){
        case 'ArrowDown': next=en[Math.min(en.length-1, i+1)]; break;
        case 'ArrowUp': if(e.altKey){ close(+active.dataset.i, 'key'); e.preventDefault(); return; } next=en[Math.max(0, i-1)]; break;
        case 'Home': next=en[0]; break;
        case 'End': next=en[en.length-1]; break;
        case 'PageDown': next=en[Math.min(en.length-1, i+page)]; break;
        case 'PageUp': next=en[Math.max(0, i-page)]; break;
        case 'Enter': case ' ':
          if(e.key===' ' && typed && Date.now()-typedAt<700) break;
          e.preventDefault(); e.stopPropagation(); close(active.classList.contains('is-off')?null:+active.dataset.i, 'key'); return;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(null, 'escape'); return;
        case 'Tab': close(null, 'tab'); return; // let the browser move focus on from the field
        default:
          if(e.key.length===1 && !e.ctrlKey && !e.metaKey && !e.altKey){
            typed=(Date.now()-typedAt>700?'':typed)+e.key.toLowerCase(); typedAt=Date.now();
            const from=typed.length===1?i+1:i, order=[...en.slice(from), ...en.slice(0, from)];
            next=order.find(r=>r.textContent.trim().toLowerCase().startsWith(typed));
          }
      }
      if(next){ e.preventDefault(); list.classList.add('kb'); setActive(next); }
    });
    list.addEventListener('pointermove', e=>{ const r=e.target.closest('.pv-sel-opt'); if(r && r!==active && !r.classList.contains('is-off') && e.pointerType==='mouse') setActive(r, false); });
    list.addEventListener('click', e=>{
      const r=e.target.closest('.pv-sel-opt'); if(!r || r.classList.contains('is-off')) return;
      close(+r.dataset.i, 'pick');
    });
    // a click (or tap) anywhere outside the list closes it without changing the value
    layer.addEventListener('pointerdown', e=>{ if(!list.contains(e.target)){ e.preventDefault(); } });
    layer.addEventListener('click', e=>{ if(!list.contains(e.target)) close(null, 'backdrop'); });

    const onWin=()=>close(null, 'resize');
    const onScroll=e=>{ if(e.target!==list && !list.contains(e.target)) position(); };
    root.addEventListener('resize', onWin);
    root.addEventListener('scroll', onScroll, true);

    if(byKey) list.classList.add('kb');
    sel.classList.add('pv-sel-open');
    sel.setAttribute('aria-expanded','true');
    cur={sel, layer, list, onWin, onScroll};
    root.requestAnimationFrame?root.requestAnimationFrame(()=>layer.classList.add('show')):layer.classList.add('show');
    list.focus({preventScroll:true});
  }

  // Mouse: open on press (the system menu also opens on press); touch: on lift, so a scroll that starts on a field
  // still scrolls the page.
  let touch=null;
  d.addEventListener('mousedown', e=>{
    const s=e.target; if(e.button!==0 || !eligible(s)) return;
    if(Date.now()-lastTouch<800){ e.preventDefault(); return; } // the mouse event a browser sends after a tap
    e.preventDefault(); s.focus({preventScroll:true}); open(s);
  }, true);
  d.addEventListener('touchstart', e=>{
    const s=e.target; if(!eligible(s) || e.touches.length!==1) { touch=null; return; }
    touch={s, x:e.touches[0].clientX, y:e.touches[0].clientY};
  }, {capture:true, passive:true});
  d.addEventListener('touchend', e=>{
    const t=touch; touch=null; if(!t || e.target!==t.s) return;
    const p=e.changedTouches[0]; if(Math.hypot(p.clientX-t.x, p.clientY-t.y)>10) return;
    e.preventDefault(); lastTouch=Date.now(); open(t.s);
  }, {capture:true, passive:false});
  d.addEventListener('click', e=>{ if(eligible(e.target)) e.preventDefault(); }, true);
  d.addEventListener('keydown', e=>{
    const s=e.target; if(!eligible(s) || cur) return;
    const k=e.key;
    if(k==='Enter' || k===' ' || k==='F4' || k==='ArrowDown' || k==='ArrowUp'){ e.preventDefault(); open(s, true); }
  }, true);

  api.open=s=>eligible(s)&&open(s);
  api.close=()=>close(null, 'code');
  api.isOpen=()=>!!cur;
})(typeof window!=='undefined'?window:this);
