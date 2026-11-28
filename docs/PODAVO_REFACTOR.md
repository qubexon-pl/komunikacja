# Podavo.voyage: UI/UX refactor and Local Exploring

Working plan for the brief "Podavo.voyage — UI/UX Refactoring and Local Exploring Implementation". The full plan, with the audit and the data model, is kept as a shared document in the project; this file is the copy that travels with the code. It continues [TRANSPORT_REDESIGN.md](./TRANSPORT_REDESIGN.md), whose first slice is already merged.

The work ships as small PRs, one part of a phase at a time. Nothing is rewritten and no working integration is replaced.

## Decisions

1. **No React.** The app stays plain JavaScript with Bootstrap, Leaflet and Capacitor, and no build step. The brief's components become pure render functions in small modules, like `window.PVT` in `assets/app.transport.js`.
2. **Saved trips stay in `dbo.UserFavorites`** (`type:'trip'`, keyed by `tid`). A thin `dbo.UserTrip` index row is added for the exploration plans; the trip JSON is not migrated.
3. **New endpoints go into the Node server** (`src/`). FastAPI keeps trip sharing and photos.
4. **Podavo colours stay.** The look follows Podavo Clean: navy #173B70, blue #2878D0, teal #20A995, amber #F2B84B, the same fonts, white cards on the pale blue background and the painted illustrations. The brief's hex values are not adopted.
5. **Breakpoints:** phone below 768 px, tablet 768–1023, desktop 1024–1439, wide from 1440. Listed in `assets/onward/css/tokens.css`.
6. **Mobile apps stay first-class.** Every phase keeps the Android and iOS builds working (camera, location, share, secure storage, Google sign-in). Push notifications are added in Phase 9.

## Phases

| Phase | PRs |
| --- | --- |
| 2. Tokens and shell | 2a tokens and breakpoints (no visual change) · 2b desktop sidebar, content widths, mobile header and bottom bar · 2c shared modal and bottom sheet |
| 3. Planner | 3a compact stepper · 3b JourneySegment / JourneyTimeline, details in modals · 3c one primary action, save without accommodation, labelled booking links |
| 4. Transport | 4a provider adapters and normalised models, cities and capabilities endpoints · 4b Rzeszów GTFS/live and PLK as adapters · 4c shared screens · 4d Rzeszów and trains moved onto them |
| 5. Discovery | 5a discover endpoint from real fares and weather · 5b discovery-first page with Map/List · 5c natural-language search to validated filters |
| 6. Knowledge service | 6a Wikipedia and Wikidata adapter, kept in the snapshot catalogue with a 30-day refresh · 6b "O miejscu" sheet (OSM moved to 7a) |
| 7. Local Exploring | 7a places nearby from OpenStreetMap · 7b "W okolicy" list and adding places to the trip plan · 7c AI recommendations from catalogue records |
| 8. Route fit | 8a optimise endpoint · 8b conflict detection |
| 9. Trip workspace | 9a dashboard · 9b phase-aware actions · 9c push notifications |
| 10. Hardening | offline plans, accessibility, performance, tests per acceptance criterion |

## 2a: tokens and breakpoints

- The theme variables used to be defined five times in `assets/app.css`, once per earlier visual style, each layer overriding the one before. They are now one block at the top of the file with the values that were already winning, so nothing changes colour.
- Hard-coded Podavo colours in rules use the base tokens (`--onward-navy`, `--onward-blue`, `--onward-teal`, `--onward-amber`, `--onward-background`).
- The phone breakpoint moved from 760 to 768 px in the style sheets and in the scripts that test for a phone (`app.js`, `app.native.js`, `app.tour.js`).
- `tokens.css` lists the breakpoint scale and adds type and radius steps for the next PRs.

Checked by screenshots of nine pages at 320, 390, 768, 1024 and 1440 px in light and dark, before and after: the only differences are the clock, the loading spinner and the timing of the tour prompt, which also differ between two runs of the unchanged code.

## 2b: responsive shell

- **Desktop (from 1024 px):** a persistent left sidebar with Planuj, Kierunki, Podróże, Ulubione and Komunikacja. It is the same `<nav class="bottom-nav">` the phone uses, styled as a sidebar in `assets/app.shell.css`, so both bars share one list of pages and one active state (`syncNav`). The top bar keeps the logo, help, language, alerts, admin and account; its page tabs move into the sidebar.
- **Collapsible:** "Zwiń menu" at the bottom of the sidebar shrinks it to icons (76 px). The choice is kept in the browser (`podavo.sideCollapsed`). Collapsed labels stay for screen readers and show as tooltips.
- **Content width:** the page and the header text are capped at `--pv-content-max` (1360 px), so cards no longer stretch across wide screens.
- **Tablet (768–1023 px):** unchanged, with the page tabs in the top bar.
- **Phone (below 768 px):** unchanged look. The top bar buttons (language, alerts, account) get an invisible 44 × 44 px touch area. `--app-bottom` now counts the bottom bar only on phones, so desktop dialogs are not squeezed by the sidebar.

Checked for horizontal overflow on six pages at 320, 360, 390, 430, 768, 1024, 1440 and 1920 px (none), with screenshots in light and dark.

## 2c: shared sheets

- `assets/app.ui.js` (`window.PVUI`) is the one way to show contextual details. `PVUI.sheet.open({title, html, size, footer, onClose})` returns a handle with `close`, `setContent` and `setTitle`. Sizes: `md` (default), `lg`, `wide`.
- Layout (in `app.shell.css`): a bottom sheet with a grab handle above the bottom bar on phones, a centred window on tablets, and a right-hand panel under the top bar on desktop. `wide` sheets stay a centred window on desktop.
- Behaviour for every sheet:
  - Escape and a click on the backdrop close it.
  - Tab and Shift+Tab stay inside it.
  - The page behind does not scroll.
  - Focus returns to the button that opened it.
  - The phone or browser Back button closes the sheet without leaving the page. `app.ui.js` loads before `app.js`, so the page router never sees that Back press.
- Screens that render their own sheet use `PVUI.layer.enter(id, close)` / `PVUI.layer.leave(id)` and mark the dialog with `data-pv-trap`. The trip page's sheets (costs, stay, photos, stages, people) now do this: they open as a right-hand panel on desktop and a bottom sheet on phones. The map and city plan sheets keep the full window.

## 3a: compact stepper

- `PVUI.stepper(steps, cur, {attr, extra})` in `assets/app.ui.js` draws one row of numbered steps, all the same width, joined by a line. Done steps show a tick in Podavo teal, and the current step is blue. Steps not reached yet are disabled unless the screen enables them.
- The flight planner (Loty → Dojazd na lotnisko → Na miejscu / Z lotniska do centrum → Plan podróży) and the ground planner (Połączenie → Zapisz podróż) both use it. This is already the brief's order: main transport, transport to the departure point, transport at the destination, summary.
- On screens narrower than 900 px the row shows only the dots, and one line under it says where you are ("Krok 2 z 4 · Dojazd na lotnisko · Autobus 0A"). Wider screens show each step's name and a short summary of what was chosen.
- Choices stay in the planner state (`P.flightStep`, `P.accessPick`, `P.xferPick`), so going back to an earlier step keeps them. This was already the case and is unchanged.

## 3b (part 1): journey details in a window

- The planner's "Przebieg podróży" list now shows only the essentials for each point: the mode, where, the times, the duration and the cost.
- The details that used to sit open in a second column next to the list now open in a `PVUI.sheet` when you click a point: the step-by-step route, map links, check-in notes and "Szczegóły lotu". On phones that is a bottom sheet, and on desktop a panel on the right.
- The second column ("Szczegóły wybranych punktów pojawią się tutaj") is gone, so the planner is one column on every screen.
- Moved in part 2: the access comparison table, the cost card (fuel assumptions, per-person maths), provider and ticket links, and baggage notes are now behind the same windows.

## 3b (part 2): costs and assumptions in windows

- `infoButton(label, title, html)` in `app.js` renders a small button whose content is ready when the screen is drawn; clicking it opens the content in a `PVUI.sheet`. A map or flight button inside a sheet closes the sheet first and then opens the map or flight window (`wireSheet`).
- **Step 2, Dojazd na lotnisko:** the comparison table stays, because it is where you choose. The fuel and ticket-price assumptions under it moved to "Jak liczymy koszt dojazdu". The chosen way to the airport is now one line with "Trasa krok po kroku" (the steps there and back in a window), "Trasa na mapie" and Google Maps, instead of the full step list on the page.
- **Step 4, Plan podróży:** the cost card shows the total and the price per person. Each cost row, with the fuel and ticket assumptions, is under "Szczegóły kosztów". The per-mode price list under the price box is gone, because it repeated the cost card.
- **Flight cards:** the per-mode price list moved to "Rozbicie ceny", together with the baggage note (a small under-seat bag only) and the estimate note. The short "W cenie: mała torba pod siedzenie" line stays on the card.
- The trip page's own cost sheet still shows every row.

## Phone fix: round-trip dates

- On phones the round-trip "Termin podróży" field now takes the whole row, and the time takes its own row, so both dates and the number of days are visible.

## Stay: Booking.com options and the city

- Next to "Szukaj na Booking.com" (planner and trip page) you choose the type of place (all, hotels, apartments, B&Bs, hostels, holiday homes) and the number of rooms. The link gets `nflt=ht_id=…` and `no_rooms`, never more rooms than adults. The choice is remembered in this browser and changes the link without redrawing the screen.
- When the destination is the airport itself (for example "Rzym Fiumicino"), the server already swaps it for the city centre. The stay now uses that city too ("Rome"), so Booking.com searches the city and not the airport.

## Phone fix: time picker

- On touch screens the time is chosen from two lists (hour, minutes in 5-minute steps; "Teraz" means now). Android's own clock dialog cut off its "Ustaw" button when the phone uses a larger text size. `#plTime` stays the only source of the value, so nothing else in the planner changed.

## 3c: one primary action, saving is not booking

- Step 4 has one filled (primary) button: "Zapisz moją podróż". "Zobacz szczegóły", "Szukaj noclegu" and the purchase links are secondary. After saving, "Zakończ" becomes the primary button and the save buttons turn secondary.
- Every save bar (flight, train/bus/car, several places) says under the buttons that saving does not book tickets or a stay, and that the stay can be added now, later or not at all. Saving never needed a hotel; a test now guards that.
- Purchase links say where you buy: "Kup bilet na ryanair.com / wizzair.com" or "Sprawdź w Google Flights", with a line that the link opens the airline's site.

## 4a: providers, cities and capabilities

- `src/transport.js` describes every transport provider the app already uses: ZTM and PKS Rzeszów (imported GTFS with live GTFS-RT), PKP PLK (rail departures and delays near Rzeszów), Transitous (48 Polish cities) and the airport transfers. Each provider says what it can do: `plan`, `departures`, `stops`, `lines`, `vehicles` (`live`, `scheduled` or none), `realtime` and `fares`.
- A city's capabilities are joined from its providers. Transitous cities are `live` only where the operator publishes GTFS-RT (`live` in `assets/app.cities.js`); elsewhere vehicles are `scheduled`. No Transitous city claims fares.
- The normalised models (Departure, Journey, Leg, fare) are documented in the module. `journeyFromTransitous` converts a Transitous itinerary; a leg is `live` only when the source says so, a scheduled leg never shows a delay, and fares stay `null` unless a source gives one.
- New public endpoints (no provider is asked; rate-limited like the other public routes):
  - `GET /api/transport/cities`: every city with its providers and capabilities.
  - `GET /api/transport/cities/:id`: one city (404 if unknown).
  - `GET /api/transport/providers`: the provider list.
- Nothing on screen changes yet. 4b puts Rzeszów and PLK behind adapters that return these models; 4c builds the shared transport screens on them.

## 4b: Rzeszów and PKP PLK as adapters

- `src/transport-adapters.js` answers departures in the shared Departure model from what the background jobs already keep in the database: the imported Rzeszów timetables (`schedule:ztm`, `schedule:pks`) and PKP PLK's timetable and operations (`plk:schedule:<day>`, `plk:operations`). A visitor never makes the server call ZTM, PKS or PKP. Each snapshot is parsed once and kept until its ETag changes.
- `GET /api/transport/departures?provider=rzeszow-gtfs&stop=ztm:<id>` or `?provider=pkp-plk&stop=<station id>`, with optional `time` (local, `YYYY-MM-DDTHH:MM`) and `limit` (1–50). 503 when the timetable is not ready, 400 for a bad stop or time, 404 for an unknown Rzeszów stop.
- Rzeszów: the weekly calendar and its exceptions decide which trips run; trips after midnight (GTFS times over 24:00) are included; nobody boards at a trip's last stop. GTFS-RT delays are still decoded in the browser, so the server marks every Rzeszów departure `scheduled`.
- PKP PLK: a departure is `live` only when PKP's operations feed has that train. The delay is the station's own report or, while the train runs, the last delay reported before it (the rule the train board uses). Cancelled trains are marked.
- The screens still use their current data paths; 4c and 4d move them onto these adapters.

## 4c: shared departure board

- `PVT.departureBoard(list, {now, line, t, empty})` and `PVT.departureRow` in `assets/app.transport.js` draw any list in the shared Departure model. A delay or "na czas" appears only for a `live` departure; a scheduled one shows its timetable time only. Trains show platform and track; buses and trams show the stand. Cancelled departures are struck out.
- `/api/transport/departures` also answers `provider=transitous` (the 48 cities), converting Transitous departures with `transitousDeparture`: live only when the operator sent a prediction.
- The city stop board (Komunikacja → a city → Rozkład jazdy) now reads `/api/transport/departures` and draws `PVT.departureBoard`, with the source and fetch time under it. The look is unchanged.
- 4d moves the Rzeszów stop board and the train board onto the same board.

## 4d: deferred

The Rzeszów stop board and the train board keep their own layouts (arrivals tab, map, GTFS-RT decoded in the browser).
They already use the same "wg rozkładu / na czas / +N min / odwołany" wording as the shared board; a full move onto it
was postponed by the owner in favour of discovery.

## 5a: discovery from real fares and weather

`GET /api/discover?origin=lat,lon&from=YYYY-MM-DD&to=YYYY-MM-DD&nights=0..30&radius=km|any&limit=` (rate limit
"discover", 30/min) answers "where can I fly from here": the cheapest stored fare to each place, from airports within
the radius (default 300 km), in a window of at most 92 days (default 30).

- Fares: only what the airlines or the fare API gave and the flight store keeps (`flights.discover()` in
  src/flights.js). A per-departure "list" price that is only the day's lowest is left out. With `nights`, a place is
  listed only when a stored flight home exists exactly that many days later, possibly from another airport of the same
  city.
- Places: airports of one country within 70 km join one entry (Stansted and Luton are London), shown at the cheapest
  one with `alsoAirports`.
- Ranking: flight price plus the drive to the airport (`groundPln`, a fuel-cost estimate, labelled as such in
  `groundNote`), as the planner already ranks.
- Weather (src/discover.js): Open-Meteo for the first 8 places whose trip falls within its 16-day forecast; otherwise
  `weather: null` and `weatherFrom`, the day the forecast will exist. Only the destination's coordinates are sent.

Every answer carries `collectedAt` of the newest fare and `source`. The page that uses it is 5b.

## 5b: discovery-first Kierunki page

The Kierunki page now opens on **Lista z cenami**: the cheapest stored flight to each place from `/api/discover`, with
the existing route map one tab away (**Mapa**). The choice of view and the filters stay in this browser
(`podavo.disc.mode`, `podavo.disc.filters`).

- Filters: when (next 30 days, next 3 months, or one of the next four months), stay (one way, or 2–7 nights with a
  stored flight home) and the airport radius. The search box above filters the list by city, country or airport.
- Card (`PVD.card`, assets/app.discover.js): place and nearby airports, flight out (and home) with day, time, airline
  and airports, the forecast where one exists or the day it will, the price "od X zł" per person, and the drive to
  the airport marked as an estimate. "Zaplanuj" fills the planner with the place and the dates (round trip when it
  has a flight home) and asks the person to search for current prices.
- Under the list: where the prices come from, when the newest was collected, and that weather is Open-Meteo.
- Only the start point rounded to about 1 km is sent to the server.

## 5c: typed search to checked filters

In the list view the search box takes a wish such as "Hiszpania w lutym na weekend do 400 zł" or "Rome in March for a
week under 300". `PVD.parseQuery` (assets/app.discover.js) reads it in the browser, without a server or an LLM:

- month (Polish forms such as "w lutym", "w marcu", "w maju"; English names), the next such month from today;
- stay ("weekend" = 2 nights, "tydzień/week" = 7, "N nocy", "N dni" = N−1 nights, "w jedną stronę"), clamped to the
  stays the filter offers;
- price ceiling ("do/max/poniżej/under 400", "400 zł"), accepted between 20 and 20 000 zł, otherwise ignored;
- country, matched against the countries in the current answer (with the common Polish endings: "we Włoszech",
  "do Grecji").

Month and stay set the selects (and so the `/api/discover` query); price and country filter the answer. Whatever is
left filters by place name. The chips above the list show what was understood, so nothing is applied silently.
The months list reaches 12 months ahead. Service worker onward-v39.

## 6a: destination knowledge from open sources

`GET /api/places/about?name=&lat=&lon=&lang=pl|en` (rate limit "places", 30/min) says what open sources know about a
destination (src/knowledge.js):

- Wikipedia in the chosen language: the article named like the place among pages within 10 km of the point, or, when
  the point is at an airport, the article of that name if it lies within 60 km and is not a disambiguation page. From
  it: title, short description, summary (at most 1200 characters), picture and link.
- Wikidata, through the article's item: population with its year (newest value), elevation in metres, official
  website, country and time zone (as labels in the chosen language). A fact the source does not have is left out.
- Every answer lists its sources with licences (Wikipedia CC BY-SA 4.0, Wikidata CC0) for the attribution line.
- Only the place's name and coordinates are sent out. Answers that found an article are kept in the database for 30
  days (`know:` snapshots via src/stored.js), so the catalogue fills up as places are looked at and refreshes itself
  when an entry is older than that. A miss is not stored.

The card that shows it on a destination and on a saved trip is 6b; points of interest from OpenStreetMap follow with
Local Exploring.

## 6b: "O miejscu" card

`PVD.aboutHtml` (assets/app.discover.js) shows the answer of `/api/places/about` in a sheet: the picture, title, short
description and summary from Wikipedia, the facts Wikidata has (country, population with its year, elevation, time
zone, official website), a link to the article and the sources with their licences. Facts a source does not give are
not listed. It opens from:

- "O miejscu" on every card of the Destinations list (the place's name and the airport's coordinates);
- the new "O miejscu" tool on a saved trip's page (its first city and the city centre).

Answers are kept in memory for the session as well as in the database. Service worker onward-v40.

## 7a: places nearby from OpenStreetMap

`GET /api/places/nearby?lat=&lon=&radius=300..5000&cats=museum,sight,view,park,food,cafe,nightlife&lang=` (rate limit
"nearby", 20/min; src/nearby.js) lists named places around a point from OpenStreetMap through the Overpass API,
nearest first, at most 120:

- kinds: museum (museums, galleries), sight (attractions and historic places such as castles, palaces, churches,
  monuments, ruins; not wayside crosses or milestones), view, park (parks, gardens, zoos), food, cafe, nightlife;
- per place: OSM id, name (in the chosen language when OSM has it), kind, position, distance, and, only when OSM has
  them, opening hours, website (http/https only), Wikipedia link, wheelchair access and cuisine;
- the same place mapped as a point and a building is listed once.

Only the point rounded to about 100 m and the radius are sent to Overpass. Answers with places are kept in the
database for 14 days (`osm:` snapshots), which is the catalogue 7c recommends from. Every answer carries
"© OpenStreetMap contributors" and the ODbL licence.

Saved trips keep their exploration plans in the trip JSON (`trip.local`), as they do today; no new table was needed.

## 7b: "W okolicy" in the trip's city plan

The city plan of a saved trip ("Plan zwiedzania") now starts with **W okolicy**: named places within 2 km of the
stay (or of the city centre when no stay is saved), from `/api/places/nearby` (`PVD.nearList`,
assets/app.discover.js).

- Kind chips (all, sights, museums, views, parks, food, cafés, evening), showing only kinds that are there; 12
  places at a time with "Pokaż więcej".
- Each place: distance, OSM's opening hours as written (no "open now" guess), cuisine, wheelchair access when OSM says
  yes, "O miejscu" when OSM links a Wikipedia article (6b sheet), and "Dojazd", which fills the city planner from the
  stay to that place. A found connection is added to the plan with the existing "Dodaj do planu", so the plan keeps
  one format.
- The section can be folded (remembered in this browser). The ODbL line is under the list.
- Service worker onward-v41.

## 7c: AI recommendations from catalogued places

The AI sightseeing plan (src/ai-planner.js) now asks the OpenStreetMap catalogue for places within 3 km of the stay
(or the city centre) first. When there are at least 8, the model gets them as `catalogue` (id, name, kind, distance,
opening hours) and must pick every stop from it, copying the id into `placeId`:

- a stop whose `placeId` is not in the catalogue (an invented or misremembered place) is dropped;
- a kept stop takes its name, position and kind from the catalogue, not from the model, plus its OSM id and opening
  hours;
- the plan says `source: "osm"`, and the page shows the OSM attribution under it, with the opening hours on each stop.

With fewer places (or Overpass unavailable) the plan works as before (`source: "model"`) and the page asks the
traveller to check names and hours. Only the stay's point goes to Overpass. Service worker onward-v42.

## 8a: fitting a day's route

`src/route-fit.js` orders a day's stops so the walk from the stay is shortest (nearest neighbour, then 2-opt). Walking
time is an estimate from the straight-line distance (×1.3 for streets, 4.5 km/h) and is labelled as one. The day keeps
its earliest planned time; each stop lasts its own minutes (60 when unknown) and the walk is added before it. A stop
without a position stays right after the stop it followed.

`POST /api/ai/city-plan-fit {tid, city, day, start}` (signed in, own trip only) fits one day of the saved AI plan,
stores it (`fitted: true`, `walkKm`, `walkMin` per stop) and answers how many kilometres it saved. The plan shows
"Ułóż trasę dnia" on days with at least 3 positioned stops, the walking minutes before each stop and the day's total.
Service worker onward-v43.

## 8b: conflicts in a planned day

Every AI plan the server returns carries `conflicts` per day (`checkDay` in src/route-fit.js), worked out on each read
and never stored:

- **overlap**: a stop's planned time plus its length (and the walk to the next) runs more than 5 minutes into the next
  stop;
- **closed**: OSM's opening hours say the place is closed that weekday (in OSM a weekday no rule mentions is closed);
- **outside**: the visit does not fit in any of that day's opening ranges.

Opening hours are read only in the common OSM forms (weekday ranges, several time ranges, `off`, `24/7`, past
midnight). Anything else (months, holidays, sunrise, free text) makes the hours unknown, and then nothing is said. The
plan marks such stops in amber with a short note "(według OSM)". Service worker onward-v44.

## 9a/9b: next trip on Moje podróże

- The "Upcoming" tab opens with a "Najbliższa podróż" card for the earliest booked or shared trip that has not ended.
- `tripPhase(day, back, today)` gives the phase: `before` (days to go), `travel` (leaving today), `during` (day N of M), `after` or `undated`.
- The actions follow the phase:
  - before: open the trip, add a stay (own trips without a hotel only), plan sightseeing;
  - travel: the journey step first;
  - during: nearby places and "O miejscu" for the destination.
- The weather chip uses the existing forecast endpoint. When no forecast exists yet it shows the "forecast from" date and never an invented one.

## Kierunki map: lazy routes, viewport markers, list and bottom sheet

- **Routes on demand.** No route is drawn until a destination is picked, from the list or the map. Then only its routes appear. Clicking a departure airport draws only that airport's routes. The pulsing, glowing and dashed animations are removed.
- **Viewport markers.** Destination dots are created only once they come into the visible area (plus a 25% margin). They are drawn on one canvas (`preferCanvas`), and routes sit in their own pane under the dots.
- **On-demand details.** The destination card loads today's weather (`/api/weather`, cached 3 h on the server) and a short description (`/api/places/about`, cached 30 days) only when it opens. "Więcej o miejscu" opens the full "O miejscu" sheet. Prices are the lowest fares stored in the database and are labelled that way.
- **Caching.** The route network is refreshed weekly and stored in the database (as before). `/api/flights/network` now sends an ETag and `Cache-Control: public, max-age=3600`, so browsers reuse it and get a 304 when nothing changed.
- **Layout.**
  - Desktop (992px and up): a list of the destinations in view on the left, sorted by stored price, with a large map on the right.
  - Smaller screens: the map with a bottom sheet that expands into the same list. The destination card opens as a sheet over the map.
  - The statistics panel is replaced by the list count and an airline legend.
- **MapLibre GL.** Not adopted yet. With routes drawn on demand and markers limited to the view, Leaflet with a canvas renderer stays fast at the current size (hundreds of destinations). MapLibre would add about 800 KB and needs a vector tile provider. Worth revisiting if the map grows to thousands of points or needs custom vector styling.

## 9c: push notifications (Web Push, as in Tidy)

- The same mechanism as Tidy: VAPID keys on the server and the browser's own push service. No Firebase project is needed.
- **Server (`src/push.js`).**
  - Routes: `GET /api/push/key`, `POST /api/push/subscribe`, `/unsubscribe` and `/test`. All need a signed-in user, and the writes are same-origin only.
  - Subscriptions live in `dbo.PushSubscription`: at most 10 per user, deleted with the account. Dead subscriptions (404/410 or a key mismatch) are removed when a send fails.
- **What is sent.**
  - A price alert that reaches its price, sent next to the email. Either one counts as the user being told.
  - At 8:00 Polish time, once a day (claimed in `dbo.AppSetting` across restarts): a booked trip leaving tomorrow, or coming back tomorrow.
  - Payloads hold only the user's own route, dates and limit. There are no other participants' names and no addresses.
- **Client.**
  - `assets/app.push.js` (`window.PVPUSH`) backs a "Powiadomienia na tym urządzeniu" card at the top of the Komunikaty panel: turn on, send a test, turn off.
  - Signing out removes this device's subscription. Signing in refreshes it.
  - The service worker shows the notification and opens its page, same-origin only.
- **Setup.**
  1. Run `npm run push:keys`.
  2. Set `PODAVO_VAPID_PUBLIC_KEY`, `PODAVO_VAPID_PRIVATE_KEY` and `PODAVO_VAPID_SUBJECT` in the App Service settings.
  3. Run `npm run db:migrate`.
  - Without the keys, push stays off and the card is hidden.
- **Where it works.**
  - The installed web app on Android and desktop.
  - iPhone and iPad from iOS 16.4, once Podavo is added to the Home Screen.
  - Not in the Capacitor store app: its web view has no Web Push, so the card explains how to install the web app instead. Native push in the store app would need FCM/APNs (`@capacitor/push-notifications`) and is left for later.

## 10a: trip plans offline

- **What the service worker now keeps.** These GET endpoints are kept as network-first copies in the per-user `onward-api` cache, which is cleared at sign-out:
  - AI day plans: `/api/ai/city-plan`, plus `/api/ai/status` and `/api/ai/style`;
  - places nearby: `/api/places/nearby`;
  - place descriptions: `/api/places/about`;
  - shared trips: `/api/trips/shared` and `/api/trips/mine/shares`.
- **Age of a copy.** Every cached copy carries `X-Podavo-Saved-At`. When the page is offline and gets a copy, the AI plan and the nearby list show "Bez połączenia: zapisana kopia z …". Saved data is never presented as fresh.
- **Saving ahead.** When a trip opens with a connection (and AI plans are on), the saved day plans of its cities are fetched in idle time, so they are on the device before the trip.
- **Not kept.** Live data (departures, prices, vehicle positions) is still never served from a copy.

## 10b: accessibility pass

- **How it was checked.** axe-core (WCAG 2.0/2.1 A and AA), light and dark, at 390px, on:
  - Plan, Kierunki (list and map), Moje podróże, a trip, Ulubione, Komunikacja and login;
  - the open Komunikaty panel and the trip's city and journey sheets.
  - Everything now reports no violations.
- **Fixes.**
  - **Mobile bottom bar in dark mode.** It stayed white with light text (2.2:1). It now uses the dark surface.
  - **Small text on Podavo blue.** It sat at 4.47:1, so buttons, active tabs, the active bottom-bar item and share links use a shade darker (`--btn` #2472C8, `--nav-active` #1F63B3, light #8FB3E8 in dark). The fills stay Podavo blue.
  - **Section numbers.** The amber number was 2.7:1. It is a darker amber in light mode and Podavo amber in dark mode.
  - **"spóźn." in line tiles.** Uses `--danger-text`.
  - **Kierunki search field.** Its text was white on white in dark mode.
  - **Line tiles.** The star sat inside the line button (nested interactive controls). It is now a separate button next to the line button, which still fills the tile.
  - **Smaller fixes.** The date field gets `role="combobox"`, the Komunikaty panel body is focusable, and the Kierunki map is a labelled region.

## Feedback fixes: compact trip screen, About and nearby

- **Trip page on phones.** The first screen is now the trip itself.
  - The page hero and the Rzeszów weather box are hidden there.
  - The trip header has short actions.
  - The step timeline is a horizontal strip that scrolls to the current step, instead of a tall wrapping grid.
  - The tool tiles are low rows.
  - A flight trip went from about 1,300px to under 600px.
- **"O miejscu".** A place named after its airport ("Rzym Fiumicino") is looked up as the full name, then with trailing words dropped ("Rzym"). The sheet title shows the article found.
- **"W okolicy".** Overpass servers are tried in order: overpass-api.de, kumi.systems, private.coffee, each with a 15 s limit. If all are slow, the user sees a Polish message with "Spróbuj ponownie" instead of a raw "operation was aborted" error.
- **"W okolicy" controls.** The hide/show button is a round arrow (up when open, down when closed). A picker next to it sets the search radius: 1, 2, 3 or 5 km. The choice is kept on the device (`podavo.near.radius`) and is part of the cache key.

## Komunikacja: suburban inside Autobusy, Rzeszów like other cities

- The mode row has two choices in every city: "Autobusy" (or "Komunikacja miejska" where Transitous has trams or metro) and "Pociągi". "Podmiejskie" is no longer a separate section.
- In Rzeszów, Autobusy has a "Miejskie / Podmiejskie" switch under the same city header the other cities use (name, kinds of transport, operators, live badge). The views and URLs underneath are unchanged (`/buses`, `/suburban`).
- The line list lives only in the "Linie" tab, as in other cities, instead of also appearing under the Rzeszów search.
- `/suburban` in a city without suburban buses opens that city's transport (or trains) instead of Rzeszów's suburban data.
- 4d, stop board: the Rzeszów stop board (Rozkład jazdy) now draws `PVT.departureBoard`, the same rows as other cities. Its departures come from the GTFS timetable in the browser and are marked `scheduled`, so no delay is shown. `departureRow` gained two options: `open(x)` makes the row a button (here it opens the line), and `after(x)` adds HTML beside it (the line star). Past rows are dimmed and have no countdown.
- The train board keeps its own layout. It is the same in every city, and it shows the carrier, arrivals, platform and track, and a "Na mapie" button that the shared row doesn't have.

## Feedback fixes: Clean map on Kierunki, one bus mode, price alert, browser install

- **Kierunki map style "Podavo" (default).** The same pastel vector map as Podavo Clean (`assets/app.mapstyle.js`,
  OpenFreeMap positron restyled with Clean's palette through MapLibre), loaded only when the map opens. If MapLibre or the
  style cannot load, the map shows the light Esri tiles. Ciemna, Jasna and Satelita stay as choices; the choice is kept
  under `podavo.explore.style`.
- **Count bubbles like Clean's district bubbles.** Destinations that fall within 64 px of each other form one teal bubble
  with the number of destinations (size `30 + log2(n)·8`, at most 64 px, white ring, Clean's shadow). A single
  destination is a smaller bubble with a plane; the selected one turns coral; departure airports are sun-yellow bubbles.
  Clicking a bubble with several places zooms in to them; one place opens its card. The map now zooms to 9 so close
  airports separate.
- **Airline colours.** Bubbles are Ryanair yellow or Wizz Air purple; where both fly, the bubble is split in proportion to
  the destinations each serves. Departure airports are teal. A small legend sits in the map's top-right corner.
- **Empty map on phones fixed.** The phone rule `img,svg,video,canvas{max-width:100%}` squeezed Leaflet's canvas (dots and
  routes) to 0 px; canvases and images inside `.leaflet-container` are now exempt.
- **Planuj: no "Podmiejskie" chip.** "Autobus" covers city and suburban buses (`busModes()` adds `pks` whenever `bus` is
  ticked), on the single trip form and on every stage of a multi-stop trip. Saved choices with `pks` still tick Autobus.
- **Price alert on the trip page.** Saved trips with a flight that has not passed show an "Alert cenowy" tile next to
  Koszt, Nocleg and Mapa; it shows the limit once an alert is set and opens the same alert dialog.
- **Install from the browser on Android.** "Pobierz aplikację" on Android now opens a window with the browser install
  first (Chrome's install prompt, or the steps from the ⋮ menu when Chrome does not offer it), because only that version
  has Web Push; the APK stays below, marked as without push for now.

## 10c: performance pass

Measured with Chromium at 390px and the CPU profiler on /plan, /buses, /destinations and /trains (demo data, no network).

- **City list at start-up.** The city list (Komunikacja → Miasto) took about 300 ms on the main thread at every load. There were two causes:
  - Every name sort built a new `Intl.Collator`, because `localeCompare` was called with options. Sorts now share one collator (`NAT_COLLATOR`, `PL_COLLATOR`).
  - Each city filtered all station names. One pass over the names now fills every city.
  - The result is about 18 ms, and the same list.
- **English mode.** The translation layer tested every text node against all of its patterns on each re-render. Answers are now remembered (up to 5,000 texts), which halves the time spent translating.
- **Static files.** The server gzipped `app.js` (750 KB) on every full download. Compressed files up to 4 MB are now kept in memory, at level 9, until the file's ETag changes. Browsers still revalidate with ETag and get 304 when nothing changed.
- **Result.** The longest main-thread task at start-up fell from 200–270 ms to 75–90 ms. Script time fell by about 20%, and `load` came about 250 ms earlier on every page measured.
- **Not changed.**
  - Bootstrap, Leaflet, JSZip and protobuf.js still load on every page, because the Rzeszów timetable and live positions start at boot.
  - The web fonts are kept, for the look.

## 10d: tests per acceptance criterion

`test/acceptance.test.js` lists the 15 acceptance criteria of the brief (section 18) and, for each one, the tests that prove it. Its first test fails if any of those tests is renamed or removed. Criteria that nothing covered yet got their own tests:

| Criterion | Proven by |
| --- | --- |
| No unintended horizontal scrolling | `scripts/check-layout.mjs` (below); phone bar gutter test |
| Same transport UI in every city | shared departure board for Transitous and Rzeszów; shared step lists and city results |
| Existing integrations keep working | Transitous, city transit, Duffel, push tests (and the rest of the suite) |
| Journey details don't overwhelm the main screen | journey line and costs open in a sheet; sheet is a labelled modal |
| Save a trip without accommodation | step 4 save does not depend on a hotel; a trip without a plane is saved |
| Recommendations use real data | discover from stored fares only; forecast only where one exists |
| Shared attraction information is reused | DB-first lookups (`stored.js`); About and Nearby cache keys hold the place only, never the user (new) |
| Users see when destination info was refreshed | freshness line on boards; About and Nearby show "stan na <date>" of the catalogue copy (new) |
| Several exploration plans in one trip | multi-place trip saved as one; each city keeps its own AI plan (new) |
| Plans respect time and commitments | plan days limited to the trip; 8b conflicts; fitted day keeps its first time |
| Public transport where supported | city journeys and airport transfers from Transitous |
| Plans can be changed by hand | fit endpoint; move, remove and add stops in the trip's city plan (new) |
| Saved plans aren't changed by catalogue refreshes | a stored plan reads back unchanged after the catalogue renames and drops places (new) |
| Polish and English | sheet labels follow the page language; typed wishes in both languages |
| Mobile and desktop tested separately | sidebar/bottom-bar breakpoints; layout check per size |

**Layout check.** `node scripts/check-layout.mjs` opens 12 pages at 320, 390, 768, 1024 and 1440 px, in light and dark mode (120 views). It fails when a page is wider than the screen, and names the element that sticks out. It needs Playwright, so it is not part of `npm test`. It serves the repo's files with the API turned off, so it checks the shell and the empty states.

**New in the UI.** "O miejscu" and "W okolicy" now end their source line with the date the shared catalogue fetched the data ("stan na 2 lis 2026"). Copies are kept for days, so the date can be older than today.
