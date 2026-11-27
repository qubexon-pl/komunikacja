/* Shared dialogs (docs/PODAVO_REFACTOR.md, Phase 2c): one way to show contextual details on every screen size.

     phone   (< 768 px)   bottom sheet above the bottom bar, with a grab handle
     tablet  (768-1023)   centred window
     desktop (>= 1024)    panel on the right, under the top bar ("wide" sheets stay a centred window)

   What every sheet does, whoever opened it:
     - Escape closes the top-most sheet; clicking the dimmed backdrop closes it too;
     - Tab and Shift+Tab stay inside the sheet while it is open (focus trap);
     - the phone or browser Back button closes the sheet instead of leaving the page;
     - the page behind does not scroll; focus returns to the button that opened it.

   Two ways in:
     PVUI.sheet.open({title, html, size, onClose})  builds the sheet (new screens use this);
     PVUI.layer.enter(id, close) / PVUI.layer.leave(id)  give the same Back button and scroll behaviour to a sheet a
       screen renders itself (the trip page), whose markup carries data-pv-trap so the focus trap finds it.

   Pure helpers (sheetHtml, nextFocus) are exported for tests in node:vm, like PVT in app.transport.js. */
(function(root){
  'use strict';
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lang=()=>root.document?.documentElement?.lang==='en'?'en':'pl';
  const T=(pl,en)=>lang()==='en'?en:pl;
  const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const SIZES=['md','lg','wide'];

  // Index of the element to focus after Tab (or Shift+Tab) from `index` among `count` elements, wrapping round.
  // index -1 means focus is outside the sheet: Tab goes to the first element, Shift+Tab to the last.
  function nextFocus(index, count, back){
    if(!count) return -1;
    if(index<0) return back?count-1:0;
    return (index+(back?-1:1)+count)%count;
  }

  // Markup of a sheet. `html` is trusted markup built by the app (escape data before passing it in).
  function sheetHtml({id, title='', html='', size='md', footer=''}={}){
    const s=SIZES.includes(size)?size:'md', tid=`${id}-title`;
    return `<div class="pv-sheet-layer" data-pv-layer="${esc(id)}">`
      + `<section class="pv-sheet pv-sheet-${s}" role="dialog" aria-modal="true" aria-labelledby="${esc(tid)}" data-pv-trap tabindex="-1">`
      + `<span class="pv-sheet-grip" aria-hidden="true"></span>`
      + `<header class="pv-sheet-head"><h2 class="pv-sheet-title" id="${esc(tid)}">${esc(title)}</h2>`
      + `<button type="button" class="pv-sheet-x" data-pv-close aria-label="${esc(T('Zamknij','Close'))}" title="${esc(T('Zamknij','Close'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header>`
      + `<div class="pv-sheet-body">${html}</div>`
      + (footer?`<footer class="pv-sheet-foot">${footer}</footer>`:'')
      + `</section></div>`;
  }

  /* ---------- open layers: Back button, scroll lock, Escape and focus trap ---------- */
  const STACK=[]; // {id, close, before}
  let seq=0, locked=null;
  const doc=()=>root.document;
  const top=()=>STACK[STACK.length-1];

  function lockScroll(on){
    const b=doc()?.body; if(!b) return;
    if(on && locked==null){ locked=b.style.overflow; b.style.overflow='hidden'; b.classList.add('pv-sheet-open'); }
    if(!on && locked!=null){ b.style.overflow=locked; locked=null; b.classList.remove('pv-sheet-open'); }
  }

  // A sheet is now open: one history entry for it, so Back closes it. Calling enter again for the same id does
  // nothing (screens that re-render their sheet call it on every render).
  function enter(id, close){
    if(STACK.some(x=>x.id===id)) return;
    STACK.push({id, close, before:doc()?.activeElement||null});
    try{ root.history?.pushState({...(root.history.state||{}), pvSheet:id}, ''); }catch(e){}
    lockScroll(true);
  }
  // The sheet closed by itself (button, Escape, backdrop): drop its history entry without leaving the page.
  function leave(id){
    const i=STACK.findIndex(x=>x.id===id); if(i<0) return;
    const [item]=STACK.splice(i,1);
    if(!STACK.length) lockScroll(false);
    if(root.history?.state?.pvSheet===id){ IGNORE.add(id); try{ root.history.back(); }catch(e){ IGNORE.delete(id); } }
    const f=item.before; if(f && f.isConnected && f.focus) setTimeout(()=>f.focus({preventScroll:true}), 0);
  }
  const IGNORE=new Set();
  const isOpen=id=>id?STACK.some(x=>x.id===id):STACK.length>0;

  if(root.addEventListener){
    // Registered before app.js, so a Back press that only closes a sheet never reaches the page router.
    root.addEventListener('popstate', e=>{
      const id=STACK.length?top().id:null;
      if(IGNORE.size){ const was=[...IGNORE][0]; IGNORE.delete(was); e.stopImmediatePropagation(); return; }
      if(id && e.state?.pvSheet!==id){
        e.stopImmediatePropagation();
        const item=STACK.pop(); if(!STACK.length) lockScroll(false);
        item.close?.('back');
        const f=item.before; if(f && f.isConnected && f.focus) setTimeout(()=>f.focus({preventScroll:true}), 0);
      }
    });
    root.addEventListener('keydown', e=>{
      if(!STACK.length) return;
      const d=doc(), traps=[...d.querySelectorAll('[data-pv-trap]')].filter(el=>el.getClientRects().length), box=traps[traps.length-1];
      if(e.key==='Escape'){
        if(d.querySelector('.ask-layer, .modal.show')) return; // a confirmation or Bootstrap dialog on top handles it
        e.preventDefault(); e.stopImmediatePropagation(); top().close?.('escape');
        return;
      }
      if(e.key!=='Tab' || !box) return;
      const items=[...box.querySelectorAll(FOCUSABLE)].filter(el=>el.getClientRects().length);
      if(!items.length){ e.preventDefault(); box.focus(); return; }
      const i=items.indexOf(d.activeElement), n=nextFocus(i, items.length, e.shiftKey);
      // inside the list and not at an edge: let the browser move focus normally
      if(i>=0 && n===i+(e.shiftKey?-1:1)) return;
      e.preventDefault(); items[n].focus();
    }, true);
  }

  /* ---------- sheets built here ---------- */
  function open(opts={}){
    const d=doc(), id=opts.id||`pv-sheet-${++seq}`;
    d.querySelector(`[data-pv-layer="${id}"]`)?.remove();
    const wrap=d.createElement('div'); wrap.innerHTML=sheetHtml({...opts, id});
    const layer=wrap.firstElementChild, sheet=layer.querySelector('.pv-sheet'), body=layer.querySelector('.pv-sheet-body');
    let closed=false;
    const finish=(why)=>{
      if(closed) return; closed=true;
      layer.classList.remove('show');
      setTimeout(()=>layer.remove(), 180);
      opts.onClose?.(why);
    };
    const handle={id, el:sheet, body,
      close(why='code'){ if(closed) return; leave(id); finish(why); },
      setContent(html){ body.innerHTML=html; },
      setTitle(t){ sheet.querySelector('.pv-sheet-title').textContent=t; }};
    layer.addEventListener('click', e=>{ if(e.target===layer || e.target.closest('[data-pv-close]')) handle.close(e.target===layer?'backdrop':'button'); });
    d.body.appendChild(layer);
    enter(id, why=>handle.close(why)); // Escape and Back go through handle.close, so the history entry is dropped too
    root.requestAnimationFrame?root.requestAnimationFrame(()=>layer.classList.add('show')):layer.classList.add('show');
    (sheet.querySelector('[autofocus]')||sheet.querySelector('[data-pv-close]')).focus({preventScroll:true});
    return handle;
  }

  root.PVUI={sheet:{open, html:sheetHtml}, layer:{enter, leave, isOpen}, nextFocus, sheetHtml, FOCUSABLE};
})(typeof window!=='undefined'?window:this);
