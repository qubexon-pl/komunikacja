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
