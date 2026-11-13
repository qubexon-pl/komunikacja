# ON/WARD missing asset supplement — PL/EN

Original SVG graphics created for this package. No external stock assets. All banners are 1440 × 300, text-free, with illustration on the right for an HTML/CSS heading on the left.

## Page banner mapping
- Flight destinations / Kierunki lotów → banners/flight-destinations.svg
- City buses / Autobusy miejskie → banners/city-buses.svg
- Timetable / Rozkład jazdy → banners/timetable.svg
- Suburban buses / Autobusy podmiejskie → banners/suburban-buses.svg
- My trips / Moje podróże → banners/my-trips.svg
- Favourites / Ulubione → banners/favourites.svg
- Trip details / Szczegóły podróży → banners/trip-details.svg
- Search results / Wyniki wyszukiwania → banners/search-results.svg

## Icons and illustrations
- weather/{partly-cloudy,rain,storm,snow}.svg
- icons/{bookmark,info,error}.svg
- illustrations/{no-results,trip-saved,ready-to-travel,plan-a-trip}.svg: no embedded words; add all labels via i18n.
- logos/wordmark-tagline-{dark,light}.svg: English tagline is intentionally baked in. For Polish, hide tagline and render translated HTML text or use the separate brand wordmark.
- map/{pin-a,pin-b,route-ab,journey-stepper}.svg: static decoration only; interactive routes, stop labels and state should be rendered in code.

## Agent instructions
1. Copy the folders into public/assets/onward.
2. Update each page hero to the mapped SVG, use CSS background-size:cover and background-position:center; use a gradient overlay behind text.
3. Never place localized text inside SVGs; use existing translation keys.
4. Use weather icons by actual weather condition codes, not string guesses alone.
5. Keep existing functional map markers, route geometry, timeline and interactions in application code. Static SVGs are not a replacement.
6. Add alt text for meaningful graphics, alt="" for decorative banners.
7. Preserve data, page functionality and PL/EN switching.
8. Test mobile crop, WCAG contrast and asset paths.
