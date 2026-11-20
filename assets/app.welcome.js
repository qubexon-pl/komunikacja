"use strict";
/* Welcome page (welcome.html). On the website it is served at / for visitors who are not signed in.
   In the Android/iOS app it is the first screen before sign-in (assets/app.native.js sends there), and its links
   lead to the app's own files instead of server addresses. */
(function(){
  const ON = window.ONWARD || {};
  try{ sessionStorage.setItem('onward.welcomed', '1'); }catch(e){}
  if(!ON.native) return;
  // The two big choices go to the login page; after signing in the app opens on the planner.
  const APP = { transit:'/index.html#buses', tour:'/index.html?tour=1', login:'/login.html' };
  document.querySelectorAll('[data-page]').forEach(a=>{ const to=APP[a.dataset.page]; if(to) a.setAttribute('href', to); });
  // A signed-in user who opens the app goes straight to the planner.
  if(ON.whenSignedIn) ON.whenSignedIn(()=>location.replace('/index.html'));
})();
