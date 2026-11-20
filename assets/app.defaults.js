// Default app settings, read by the app (assets/app.js) and the admin page (assets/app.admin.js). An administrator
// changes them for everyone on /admin; the server keeps only what differs (GET /api/settings) and the app adds it on top.
window.VOYAGE_DEFAULTS = Object.freeze({
  threshold: 3,           // min — od tylu minut autobus jest „spóźniony” (czerwony)
  refresh: 20,            // s
  rtUrls: [
    'https://kmrzeszow.live/gtfs/rt/gtfsrt.pb',
    'https://www.mpkrzeszow.pl/gtfs/rt/gtfsrt.pb'
  ],
  staticUrls: [
    'https://mkuran.pl/gtfs/rzeszow.zip',
    'https://cdn.zbiorkom.live/gtfs/rzeszow.zip'
  ],
  proxy: 'auto',
  proxyCustom: '',
  demo: false,
  tiles: 'esri',
  gkey: '',
  traffic: true,
  // PKS Rzeszów (ZGPKS) — linie podmiejskie.
  pks: true,
  pksRtUrls: [
    'https://kmrzeszow.live/gtfs-pks/rt/gtfsrt.pb',
    'https://www.mpkrzeszow.pl/gtfs-pks/rt/gtfsrt.pb'
  ],
  pksStaticUrls: [
    'https://kmrzeszow.live/gtfs-pks/latest.zip',
    'https://www.mpkrzeszow.pl/gtfs-pks/latest.zip'
  ],
  // Pociągi — Otwarte Dane Kolejowe PKP PLK, klucz trzyma serwer
  trains: true,
  // Pogoda — Open-Meteo (bez klucza)
  weather: true,
  // Wylogowanie na komputerze po tylu minutach bez aktywności (0 = nigdy)
  idleLogoutMinutes: 60
});
