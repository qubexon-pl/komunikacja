/* Web Push in the browser (the same mechanism as in Tidy): subscribes this device to notifications sent by the
   server (src/push.js), so they arrive even when Podavo is closed. Works in the installed app on Android and on
   computers, and on iPhone/iPad (iOS 16.4+) once Podavo is added to the home screen. Exposed as window.PVPUSH. */
(function(root){
  'use strict';
  const FLAG='podavo.push', OFF='podavo.push.off', EVENT='podavo-push-change';
  const get=k=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const set=(k,v)=>{ try{ if(v) localStorage.setItem(k,'1'); else localStorage.removeItem(k); }catch(e){} };
  const native=()=>{ const c=root.Capacitor; return !!(c && c.isNativePlatform && c.isNativePlatform()); };
  const supported=()=>typeof navigator!=='undefined' && 'serviceWorker' in navigator && 'PushManager' in root && 'Notification' in root;
  const ios=()=>/iPad|iPhone|iPod/.test(navigator.userAgent||'') || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  const standalone=()=>!!(root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) || navigator.standalone===true;
  const active=()=>get(FLAG)==='1';
  const turnedOff=()=>get(OFF)==='1';
  let lastError='';
  const changed=()=>root.dispatchEvent(new Event(EVENT));

  function keyBytes(b64){
    const s=atob(b64.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-b64.length%4)%4));
    return Uint8Array.from(s,c=>c.charCodeAt(0));
  }
  async function post(path, body){
    const r=await fetch('/api/push/'+path,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||'HTTP '+r.status);
    return data;
  }
  // On a first visit the worker is registered after the page loads, so wait for it (up to 10 s).
  async function registration(){
    if(!supported()) return null;
    const now=await navigator.serviceWorker.getRegistration();
    if(now && now.active) return now;
    const timeout=new Promise(res=>setTimeout(()=>res(null),10000));
    return (await Promise.race([navigator.serviceWorker.ready, timeout])) || now || null;
  }
  async function serverKey(){
    try{ const r=await fetch('/api/push/key'); if(!r.ok) return null; return (await r.json()).publicKey||null; }catch(e){ return null; }
  }

  // What the switch can show: 'native' (the store app's web view has no Web Push), 'ios-install' (Safari outside
  // the home screen), 'unsupported', 'blocked', 'off-server', 'on' or 'off'.
  async function state(){
    if(native()) return 'native';
    if(!supported()) return ios() && !standalone() ? 'ios-install' : 'unsupported';
    if(Notification.permission==='denied') return 'blocked';
    if(!(await serverKey())) return 'off-server';
    return active() && Notification.permission==='granted' && !turnedOff() ? 'on' : 'off';
  }

  // Subscribes this device. `ask`: request the permission first (only from a tap).
  async function enable(ask=true){
    lastError='';
    if(!supported()) return false;
    try{
      if(ask && Notification.permission==='default') await Notification.requestPermission();
      if(Notification.permission!=='granted'){ lastError=Notification.permission==='denied'?'blocked':'dismissed'; changed(); return false; }
      const reg=await registration(); if(!reg){ lastError='not-ready'; changed(); return false; }
      const key=await serverKey(); if(!key){ lastError='off-server'; set(FLAG,false); changed(); return false; }
      let sub=await reg.pushManager.getSubscription();
      if(sub && sub.options && sub.options.applicationServerKey){
        // The server's keys changed: subscribe again with the new one.
        const cur=new Uint8Array(sub.options.applicationServerKey), want=keyBytes(key);
        if(cur.length!==want.length || cur.some((b,i)=>b!==want[i])){ await sub.unsubscribe().catch(()=>{}); sub=null; }
      }
      if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:keyBytes(key)});
      await post('subscribe', sub.toJSON());
      set(FLAG,true); set(OFF,false); changed();
      return true;
    }catch(e){
      console.warn('push subscribe', e);
      lastError=e && e.name==='NotAllowedError'?'blocked':'failed';
      set(FLAG,false); changed();
      return false;
    }
  }
  // Switched off here, or signing out: this device stops getting the account's notifications.
  async function disable(byUser=true){
    set(FLAG,false); if(byUser) set(OFF,true);
    try{
      const reg=supported()?await registration():null, sub=reg?await reg.pushManager.getSubscription():null;
      if(sub){ await post('unsubscribe',{endpoint:sub.endpoint}).catch(()=>{}); await sub.unsubscribe().catch(()=>{}); }
    }catch(e){}
    changed();
  }
  // After sign-in: refresh this device's subscription on the server (keys may have changed, the row may be gone).
  function resume(){ if(active() && !turnedOff() && supported() && Notification.permission==='granted') enable(false); }
  const test=()=>post('test');

  root.PVPUSH={state, enable, disable, resume, test, active, error:()=>lastError, EVENT};
})(typeof window!=='undefined'?window:globalThis);
