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
