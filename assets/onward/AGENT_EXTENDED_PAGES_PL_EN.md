# ON/WARD — Extended Graphics Implementation Guide (PL / EN)

## Scope
Use these original SVG assets across the eight screenshot-matched pages. Existing application functionality, maps, live bus statuses, pricing, itinerary, weather, language choice and API responses MUST remain unchanged. These are illustrative assets, not live data.

## Install
Copy package contents to `public/assets/onward/`. Reference graphics as `/assets/onward/page-banners/flight-destinations.svg`, etc. For a bundler-specific public path adjust accordingly. Do not link to this design-sheet PNG as a UI asset.

## Page-by-page exact placement

| Screen | Banner file | Rule |
|---|---|---|
| Flight destinations | `page-banners/flight-destinations.svg` | Above destination filters; keep route map interactive |
| City buses | `page-banners/city-buses.svg` | Header only; never replace live bus map |
| Timetable | `page-banners/timetable.svg` | Header; empty-timetable illustration only for true empty state |
| Suburban buses | `page-banners/suburban-buses.svg` | Header; retain searchable town grid |
| My trips | `page-banners/my-trips.svg` | Header; no-trips only if list empty |
| Favourites | `page-banners/favourites.svg` | Header; no-favourites only if empty |
| Trip details | `page-banners/trip-details.svg` | Header; route graphic optional; actual itinerary from data |
| Search results | `page-banners/search-results.svg` | Header; compare-routes for introductory empty state only |

## Layout and display
- Keep the existing navy global navbar and logo. Use a single illustration per page header, with `background-size: cover; background-position: center right;`.
- Hero header height: 190–240px desktop, 150–200px tablet, 130–180px mobile. Keep content within existing max-width container.
- Place title and subtitle on the LEFT in a dark-blue overlay, never over high-detail graphics. Weather card on RIGHT with its own opaque dark backing and sufficient contrast.
- Never overlay hero art on maps, result cards, timetable cells or important controls.
- Use `icons/suburban-bus.svg` for suburban lines, `icons/clock.svg` for timetable, `icons/transfer.svg` for interchange, `icons/price.svg` for fare info, `icons/walking.svg` for walking legs. Other existing icons stay valid.
- Empty states: `illustrations/no-favourites.svg`, `no-trips.svg`, `no-departures.svg`, `empty-timetable.svg`, `journey-planned.svg`, `airport-transfer.svg`, `flight-connection.svg`, `compare-routes.svg`. Display ONLY when semantically appropriate.
- Route/map decoration: `decorations/route-dotted.svg` or `soft-waves.svg` on static decorative areas only. NEVER substitute for Google Maps/Leaflet or real route geometry.
- Status colors are semantic: success green, warning amber, danger red. Bus route tags may retain their existing operator colours.
- Keep SVGs as external images where possible; do not recolour them with CSS filters. Use accessible descriptive alt for meaningful imagery, `alt=""` for decorative hero images.
- Test 320px, 390px, 768px, 1280px, 1600px. Check nav overflow, weather card, title wrapping and map interactions.

## Localization
- Use `i18n/pl-PL.json` and `i18n/en-GB.json`; new keys are under `extendedPages`.
- Translate all UI text, including status messages and aria-labels, NOT the logo or proper place names.
- Keep prices and dates locale-formatted (`pl-PL`: PLN, DD.MM.YYYY; `en-GB`: GBP/PLN as applicable, DD/MM/YYYY). Do not change monetary values or currencies just because the language changed.
- Existing translation keys must take precedence; reconcile key naming rather than introducing duplicated visible labels.

## Acceptance criteria
1. Every one of the eight screens uses its correct page banner.
2. All original search, map, timetable, favourites, trip and weather behaviours still work.
3. No nonexistent image paths; no references to preview collages.
4. Polish and English strings switch without full page duplication.
5. Text contrast is WCAG AA and mobile layouts remain readable.
6. Decorative assets do not masquerade as factual journey or live-transport information.
