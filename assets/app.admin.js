"use strict";
// Panel administratora (/admin): wspólne ustawienia dla wszystkich, administratorzy i klucz PKP PLK.
// Serwer wpuszcza tu tylko administratorów; te same sprawdzenia mają wszystkie zapytania poniżej.
(function(){
  const DEFAULTS = window.VOYAGE_DEFAULTS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const day = (iso) => iso ? new Date(iso).toLocaleDateString('pl-PL', { dateStyle: 'medium' }) : '–';
  const lines = (t) => t.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) { location.assign('/login?returnTo=' + encodeURIComponent('/admin')); throw new Error('Zaloguj się ponownie.'); }
    if (!response.ok) throw new Error(body.error || 'Nie udało się. Spróbuj ponownie.');
    return body;
  }
  function message(el, text, kind = 'ok') { el.hidden = !text; el.textContent = text || ''; el.className = `adm-msg ${kind}`; }

  /* ---------- zakładki ---------- */
  document.querySelectorAll('.adm-tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.adm-tab').forEach((t) => { const on = t === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); $('tab-' + t.dataset.tab).hidden = !on; });
    history.replaceState(null, '', '#' + tab.dataset.tab);
    if (tab.dataset.tab === 'users' && !USERS.loaded) loadUsers();
    if (tab.dataset.tab === 'keys') loadPlkStatus();
  }));

  /* ---------- wspólne ustawienia ---------- */
  const f = Object.fromEntries(['sIdle', 'sThr', 'sThrLbl', 'sRefresh', 'sRefreshLbl', 'sTiles', 'gBox', 'sGkey', 'sTraffic', 'sRt', 'sStatic', 'sPks', 'sPksRt', 'sPksStatic', 'sProxy', 'sProxyCustom', 'sTrains', 'sWeather', 'sDemo'].map((id) => [id, $(id)]));
  function fill(cfg) {
    const idle = String(cfg.idleLogoutMinutes ?? 60);
    if (![...f.sIdle.options].some((o) => o.value === idle)) f.sIdle.add(new Option(`${idle} minut`, idle));
    f.sIdle.value = idle;
    f.sThr.value = cfg.threshold; f.sThrLbl.textContent = cfg.threshold; f.sRefresh.value = cfg.refresh; f.sRefreshLbl.textContent = cfg.refresh;
    f.sTiles.value = cfg.tiles; f.sGkey.value = cfg.gkey || ''; f.sTraffic.checked = cfg.traffic !== false;
    f.sRt.value = (cfg.rtUrls || []).join('\n'); f.sStatic.value = (cfg.staticUrls || []).join('\n');
    f.sPks.checked = cfg.pks !== false; f.sPksRt.value = (cfg.pksRtUrls || []).join('\n'); f.sPksStatic.value = (cfg.pksStaticUrls || []).join('\n');
    f.sProxy.value = cfg.proxy === 'custom' ? 'custom' : 'auto'; f.sProxyCustom.value = cfg.proxyCustom || '';
    f.sTrains.checked = cfg.trains !== false; f.sWeather.checked = cfg.weather !== false; f.sDemo.checked = !!cfg.demo;
    syncVisibility();
  }
  function read() {
    return {
      idleLogoutMinutes: +f.sIdle.value, threshold: +f.sThr.value, refresh: +f.sRefresh.value,
      tiles: f.sTiles.value, gkey: f.sGkey.value.trim(), traffic: f.sTraffic.checked,
      rtUrls: lines(f.sRt.value), staticUrls: lines(f.sStatic.value),
      pks: f.sPks.checked, pksRtUrls: lines(f.sPksRt.value), pksStaticUrls: lines(f.sPksStatic.value),
      proxy: f.sProxy.value, proxyCustom: f.sProxy.value === 'custom' ? f.sProxyCustom.value.trim() : '',
      trains: f.sTrains.checked, weather: f.sWeather.checked, demo: f.sDemo.checked,
    };
  }
  // Serwer trzyma tylko to, co różni się od domyślnych: gdy domyślne się zmienią, wszyscy dostaną nowe.
  function onlyChanged(cfg) {
    const out = {};
    for (const [k, v] of Object.entries(cfg)) if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) out[k] = v;
    return out;
  }
  function syncVisibility() {
    f.gBox.style.display = f.sTiles.value === 'google' ? '' : 'none';
    f.sProxyCustom.style.display = f.sProxy.value === 'custom' ? '' : 'none';
  }
  f.sThr.addEventListener('input', () => { f.sThrLbl.textContent = f.sThr.value; });
  f.sRefresh.addEventListener('input', () => { f.sRefreshLbl.textContent = f.sRefresh.value; });
  f.sTiles.addEventListener('change', syncVisibility);
  f.sProxy.addEventListener('change', syncVisibility);
  function showMeta(shared) {
    $('stUpdated').textContent = shared.updatedAt ? when(shared.updatedAt) : 'domyślne';
    $('settingsMeta').textContent = shared.updatedAt ? `Ostatnia zmiana: ${when(shared.updatedAt)}${shared.updatedBy ? `, ${shared.updatedBy}` : ''}` : 'Obowiązują ustawienia domyślne.';
  }
  async function loadSettings() {
    try { const shared = await api('/api/settings'); fill({ ...DEFAULTS, ...shared.settings }); showMeta(shared); }
    catch (e) { message($('settingsMsg'), e.message, 'err'); fill(DEFAULTS); }
  }
  $('resetSettings').addEventListener('click', () => { fill(DEFAULTS); message($('settingsMsg'), 'Przywrócono domyślne w formularzu. Zapisz, aby obowiązywały wszystkich.', 'info'); });
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = read();
    if (cfg.proxy === 'custom' && !cfg.proxyCustom) { message($('settingsMsg'), 'Wpisz adres własnego pośrednika CORS albo wybierz „Automatycznie”.', 'err'); return; }
    const btn = $('saveSettings'); btn.disabled = true;
    try {
      const shared = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: onlyChanged(cfg) }) });
      fill({ ...DEFAULTS, ...shared.settings }); showMeta(shared);
      try { localStorage.setItem('voyage.shared', JSON.stringify(shared.settings)); } catch (err) {} // ta przeglądarka od razu
      message($('settingsMsg'), 'Zapisano. Ustawienia obowiązują teraz wszystkich użytkowników.', 'ok');
    } catch (err) { message($('settingsMsg'), err.message, 'err'); }
    finally { btn.disabled = false; }
  });

  /* ---------- użytkownicy ---------- */
  const USERS = { loaded: false, me: '', timer: null };
  function userRow(u) {
    const self = u.id === USERS.me;
    const locked = u.fromConfig || (self && u.isAdmin);
    const note = u.fromConfig ? '<span class="adm-badge">ADMIN_EMAILS</span>' : self ? '<span class="adm-badge">to Ty</span>' : '';
    return `<tr>
      <td><b>${esc(u.displayName || u.email)}</b> ${note}<div class="text-soft small">${esc(u.email)}</div></td>
      <td class="text-soft small">${day(u.createdAt)}</td>
      <td class="text-end"><div class="form-check form-switch d-inline-block m-0">
        <input class="form-check-input" type="checkbox" role="switch" data-user="${esc(u.id)}" ${u.isAdmin ? 'checked' : ''} ${locked ? 'disabled' : ''}
          aria-label="Administrator: ${esc(u.displayName || u.email)}" title="${u.fromConfig ? 'Ustawione w konfiguracji serwera (ADMIN_EMAILS)' : self ? 'Nie możesz odebrać uprawnień samemu sobie' : ''}">
      </div></td></tr>`;
  }
  async function loadUsers() {
    const q = $('userSearch').value.trim();
    try {
      const data = await api('/api/admin/users?q=' + encodeURIComponent(q));
      USERS.loaded = true; USERS.me = data.me;
      $('stUsers').textContent = data.total; $('stAdmins').textContent = data.admins; $('stRecent').textContent = data.recent;
      $('usersBody').innerHTML = data.users.length ? data.users.map(userRow).join('') : `<tr><td colspan="3" class="text-soft">${q ? 'Nikt nie pasuje do wyszukiwania.' : 'Brak użytkowników.'}</td></tr>`;
    } catch (e) { message($('usersMsg'), e.message, 'err'); $('usersBody').innerHTML = ''; }
  }
  $('userSearch').addEventListener('input', () => { clearTimeout(USERS.timer); USERS.timer = setTimeout(loadUsers, 300); });
  $('usersBody').addEventListener('change', async (e) => {
    const box = e.target.closest('[data-user]'); if (!box) return;
    box.disabled = true;
    try {
      const { user } = await api('/api/admin/users/' + encodeURIComponent(box.dataset.user), { method: 'PUT', body: JSON.stringify({ isAdmin: box.checked }) });
      message($('usersMsg'), user.isAdmin ? `${user.displayName || user.email} jest teraz administratorem.` : `${user.displayName || user.email} nie jest już administratorem.`, 'ok');
      loadUsers();
    } catch (err) { box.checked = !box.checked; message($('usersMsg'), err.message, 'err'); }
    finally { box.disabled = false; }
  });

  /* ---------- klucz PKP PLK (zapisanego klucza serwer nigdy nie odsyła) ---------- */
  const OLD_PLK_KEY = 'rzbus.plk.old';
  async function loadPlkStatus() {
    const note = $('sPlkNote');
    try {
      const { configured, updatedAt } = await api('/api/settings/plk-key');
      try { const old = JSON.parse(localStorage.getItem(OLD_PLK_KEY)); if (old && !$('sPlk').value) $('sPlk').value = old; } catch (e) {}
      note.textContent = configured ? `Klucz zapisany na serwerze (${day(updatedAt)}). Wklej nowy, aby go zastąpić.` : 'Klucza nie ma jeszcze na serwerze.';
    } catch (e) { note.textContent = e.message; }
  }
  $('sPlkSave').addEventListener('click', async (e) => {
    const note = $('sPlkNote'), key = $('sPlk').value.trim();
    if (!key) { note.textContent = 'Wklej klucz API PKP PLK.'; return; }
    e.currentTarget.disabled = true; note.textContent = 'Sprawdzam klucz w PKP PLK…';
    try {
      await api('/api/settings/plk-key', { method: 'PUT', body: JSON.stringify({ key }) });
      try { localStorage.removeItem(OLD_PLK_KEY); } catch (err) {}
      $('sPlk').value = ''; note.textContent = 'Zapisano. Klucz działa teraz dla wszystkich użytkowników.';
    } catch (err) { note.textContent = err.message; }
    finally { $('sPlkSave').disabled = false; }
  });

  /* ---------- wylogowanie po bezczynności, tak jak w aplikacji (ten sam znacznik, wspólny dla kart) ---------- */
  const IDLE_KEY = 'podavo-voyage-last-activity';
  let idleTimer = null, signingOut = false, idleMinutes = DEFAULTS.idleLogoutMinutes;
  const lastActivity = () => { try { return +localStorage.getItem(IDLE_KEY) || 0; } catch (e) { return 0; } };
  const tooLong = () => idleMinutes > 0 && lastActivity() && Date.now() - lastActivity() >= idleMinutes * 60000;
  async function idleSignOut() {
    if (signingOut) return; signingOut = true; clearInterval(idleTimer);
    try { localStorage.removeItem(IDLE_KEY); } catch (e) {}
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    location.assign('/login?powod=bezczynnosc&returnTo=' + encodeURIComponent('/admin'));
  }
  function markActivity() {
    if (tooLong()) { idleSignOut(); return; }
    if (Date.now() - lastActivity() > 15000) { try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch (e) {} }
  }
  function startIdle(minutes) {
    idleMinutes = Number.isFinite(+minutes) ? +minutes : DEFAULTS.idleLogoutMinutes;
    if (!(matchMedia('(any-pointer: fine)').matches && matchMedia('(any-hover: hover)').matches)) return;
    if (tooLong()) { idleSignOut(); return; }
    markActivity();
    for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart']) addEventListener(ev, markActivity, { passive: true });
    idleTimer = setInterval(() => { if (tooLong()) idleSignOut(); }, 30000);
  }

  /* ---------- start ---------- */
  (async function start() {
    try {
      const { user } = await api('/api/auth/me');
      if (!user) { location.assign('/login?returnTo=' + encodeURIComponent('/admin')); return; }
      if (!user.canAdminister) { location.assign('/plan'); return; }
      $('admWho').textContent = user.displayName || user.email;
    } catch (e) { message($('settingsMsg'), e.message, 'err'); }
    await loadSettings();
    startIdle(+f.sIdle.value);
    loadUsers();
    const tab = location.hash.slice(1);
    if (['users', 'keys'].includes(tab)) document.querySelector(`.adm-tab[data-tab="${tab}"]`)?.click();
  })();
})();
