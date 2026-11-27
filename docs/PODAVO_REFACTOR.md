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
| 6. Knowledge service | 6a catalogue tables · 6b Wikidata, Wikipedia, OSM adapters · 6c refresh jobs and freshness |
| 7. Local Exploring | 7a plan tables and CRUD · 7b plan editor and manual selection · 7c AI recommendations from catalogue records |
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
