# Transport UI/UX redesign

This is the working plan for the transport redesign: the brief ("Podavo.voyage — Transport UI/UX Redesign") and the concept mockups, applied to this codebase. The concepts are used for layout only. The visual style stays Podavo's: navy, interactive blue, amber for primary actions, the existing fonts and the Font Awesome / `oi` icons.

The work ships in small PRs, one phase or part of a phase at a time. Nothing is rebuilt from scratch.

## Phase 1: audit

### What the app is built on

The brief assumes a React/TypeScript app. This repository has none: the front end is **plain JavaScript** (`assets/app.js`, about 8,000 lines) with Bootstrap 5, Leaflet 1.9 and Font Awesome, all loaded from a CDN, and the same files are wrapped by Capacitor for Android and iOS. The back end is Node (`src/server.js`) with Azure SQL. There is also a FastAPI service in `api/`.

The redesign therefore follows the existing conventions:

- No new framework and no build step.
- The brief's "components" are **pure render functions** returning HTML strings. They live in `assets/app.transport.js` and are exposed as `window.PVT`.
- The presentation stays separate from fetching and state, which remain in `app.js` (`CITY`, `CTX`), so the functions can be unit-tested in `node:vm` like the rest of the front end.
- Styles go in `assets/app.transport.css`, loaded after `app.css` and `app.mobile.css`. Sizes come from `assets/onward/css/tokens.css`.

### Where transport lives today

| Brief | Existing code |
|---|---|
| Połączenia (route search) | City planner `cityPanel()` / `cityPlan()` → `/api/transit/plan` (Transitous). Rzeszów ZTM/PKS planners are in `#planForm` and `renderStage()`. Trains: `#trRouteForm`. |
| Odjazdy | `syncCityTx()` "Rozkład jazdy" (`/api/transit/departures`), Rzeszów `#ttForm`, train board `#trainBoard` |
| Mapa | Leaflet maps: `CITY.map` (city planner plus vehicles), `#map` (Rzeszów live), `#exploreMap` (flights) |
| Journey timeline | `csSteps()` (airport transfers and city trips), trip page itineraries, `renderStage()` legs |
| Trip integration | `saveLocalTrip()` / `data-cp-save` (only when the planner runs inside a trip: `CITY.want.canSave`), favourites `type:'trip'` |
| Responsive shell | Already has a sticky top bar, a 5-item bottom nav under 760 px, safe areas, the language switch in the top bar, and PL/EN through `L2()` / `i18n.js` |

### What the data can and cannot back

These limits decide which controls appear in the UI.

- **Mode filters and advanced filters** (maximum walk, maximum transfers, accessible routes, avoided modes, minimum transfer time): `/api/transit/plan` passes only `from`, `to`, `time`, `zone` and `arriveBy` to Transitous. None of these filters are shown yet. Exposing them needs `src/city-transit.js` to forward MOTIS parameters (`transitModes`, `maxTransfers`, `pedestrianProfile`, `minTransferTime`) first, which is a back-end change for a later PR.
- **Prices** for city trips: Transitous returns no fares, so city route cards show no price. Airport transfers keep their curated fares.
- **Platforms**: plan legs carry none. Departures do (`platform`). The timeline shows a platform only when the source gives one.
- **Real time**: a leg is "live" only when `realTime` is set by the operator, with `delayMin` derived from the scheduled time. Everything else is labelled "wg rozkładu" (scheduled). Nothing is marked live just because the page refreshes.
- **Vehicles on the city map**: positions are interpolated from the timetable. The tooltip and legend already distinguish "na żywo" from "wg rozkładu". This stays as it is; no positions are invented.
- **Route geometry**: drawn from the planner's `legGeometry`. Walking is dashed and rides are solid. No straight-line substitutes are drawn.

## Phases 2–4, first slice (this PR)

The scope is the city transport workspace (Komunikacja miejska → planner) and the shared step-by-step list.

- **Tokens** (`tokens.css`): secondary text, card and input radii, control height, a 44 px target, the 4–32 px spacing scale and mode colours, all on top of the existing Podavo palette.
- **`PVT.routeCard`** (TransportRouteCard):
  - Collapsed: duration, departure–arrival, transfers and walking, the mode sequence, Najszybciej / Najmniej przesiadek, and the real-time state of the first ride.
  - Expanded: the journey timeline, in a native `<details>` so it works with the keyboard.
  - Selecting the card head is the one primary action. Secondary actions: Pokaż na mapie, Dodaj do planu (when the planner can save) and Nawiguj.
- **`PVT.journeyTimeline` / `PVT.stepsToEvents`** (JourneyTimeline / JourneyStep): a vertical timeline with mode icons and line colours. It adds transfer markers showing the real gap between rides, and ends with the arrival. Long Polish stop names wrap. `csSteps()` now renders through it, so airport transfers and city trips share one component.
- **`PVT.mapSummary`**: summary of the selected route.
  - On desktop and tablet it floats over the map.
  - On a phone it is a bottom sheet in full-screen map mode.
  - "Szczegóły" goes back to the card and opens it.
- **`PVT.freshness`**: shows the source and the time the server fetched the plan.
- **Split view**:
  - ≥1200 px: a 360–420 px left panel (search and results) with the map sticky on the right.
  - 900–1199 px: a 40/60 split.
  - 761–899 px: stacked.
  - The map is open by default except on phones. "Ukryj mapę" collapses it.
- **Phone (≤760 px)**: the list comes first. "Pokaż mapę" / "Pokaż na mapie" opens a full-screen map between the top bar and the bottom nav, with a "Lista" button. The scroll position is restored on return, and rotating to a wider screen leaves full-screen mode.
- **Search panel**:
  - Swap button, "Moja lokalizacja" (geolocation plus reverse geocoding, only when permitted), and picking a point on the map.
  - The primary search button is amber.
  - Inline error line.
  - Long addresses keep the full field width on phones.
- **Selection state** lives in one place (`CITY.sel`). Selecting a card highlights it, redraws the route on the map and updates the summary.

Tested by `test/transport-ui.test.js`. Layouts were checked at 360, 390, 768, 1024, 1440 and 1920 px with no horizontal overflow.

## Next PRs

1. **Back end: routing filters.** Forward the supported MOTIS options and show only those filters (`TransportModeFilter`, advanced filters).
2. **Map.**
   - Clicking a map marker opens the matching card.
   - Clicking a stop opens a popup (`StopDetails`), and clicking a vehicle opens `VehicleDetails`.
   - Map style and layer selector (`MapLayerControl`).
   - Current-location control.
   - Stop clustering with viewport loading.
   - A draggable bottom sheet on phones.
   - A resizable left panel on desktop.
3. **Odjazdy.**
   - Restyle "Rozkład jazdy" into `DepartureBoard`.
   - Add `NearbyDepartures`: 3–5 rows on phones, a panel under the results on desktop, with favourite and recent stops.
   - Show the time of the last update per board.
4. **Połączenia / Odjazdy / Mapa tabs** across the transport pages. Keep the city picker and the Rzeszów ZTM/PKS/PKP pages and their operator-specific features.
5. **Trips.**
   - Save city routes to an existing trip from the transport page, not only from inside the planner.
   - Re-check a saved route against newer timetables, keeping the saved plan separate from live updates.
   - Trip timelines rendered with `JourneyTimeline`.
6. **Travel-day mode.** Next segment, time left from the clock only (no invented countdowns or delay predictions), transfer steps, disruption alerts and offline copies of the instructions.
7. **Rzeszów planners.** Move `#planForm` results and the train results onto `routeCard` / `journeyTimeline`.
8. **Testing pass** for each acceptance criterion at the listed widths, plus accessibility (focus order, contrast in the dark theme) and performance.
