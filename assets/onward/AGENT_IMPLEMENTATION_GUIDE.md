# ON/WARD — AI Coding Agent Asset Implementation Guide

## Objective
Integrate the supplied original SVG asset package into the existing ON/WARD travel planning web application (desktop, responsive mobile, PWA). Preserve existing functionality, routing, authentication, form fields, data fetching, weather values, labels and search logic. Change presentation only unless separately instructed. Do not rebuild the UI from an illustrative mockup.

## Source of truth
All paths below are relative to `public/assets/onward/` after copying the contents of `onward-assets/` there. `manifest.json` enumerates every included asset. `css/tokens.css` contains the canonical brand colours. These are **vector illustrations, not photographs**. Do not claim any photographic banners are in this package. Do not use generated reference-sheet images as sprites or production UI.

## Exact placement map
| App area | File(s) | Placement / rule |
|---|---|---|
| Desktop navbar, dark background | `logos/wordmark-light.svg` | Top left, ~150–185px wide, maintain aspect ratio; light lettering |
| Navbar on white | `logos/wordmark-dark.svg` | Alternative for light navigation |
| Footer on dark | `logos/wordmark-light.svg` | Brand footer, ~140px wide |
| Footer on white | `logos/wordmark-dark.svg` | Brand footer on light background |
| App launch icon, PWA | `logos/mark-dark.svg` | Starting artwork; export separate square PNGs for install icons; verify safe area |
| Light-themed app tile | `logos/mark-light.svg` | Only when the surrounding tile is light |
| Small brand symbol | `logos/mark-transparent.svg` | Use for decorative brand mark; favicon source after checking 16px legibility |
| Main landing hero | `banners/coast.svg` | Optional right-side artwork or background, with legible overlay and search card above it |
| City/destination section | `banners/city.svg` | Secondary section background or destination discovery panel |
| Outdoors / inspiration section | `banners/mountains.svg` | Secondary discovery panel, not repeated on every card |
| Search: plane toggle | `icons/plane.svg` | 18–20px alongside Plane label |
| Search: city/suburban bus | `icons/bus.svg` | 18–20px for both; distinguish via label, not invented icon |
| Search: train toggle | `icons/train.svg` | 18–20px |
| Search: car toggle | `icons/car.svg` | 18–20px |
| Origin and destination | `icons/pin.svg` | 18–20px inside/adjacent to field |
| Date field | `icons/calendar.svg` | 18–20px |
| Passenger count | `icons/users.svg` | 18–20px |
| Search action | `icons/search.svg` | 18–20px, white/contrast checked against button |
| Journey comparison / routes | `icons/route.svg` | Route section title or journey summary |
| Ticket / fare | `icons/ticket.svg` | Ticket info and itinerary card |
| Luggage | `icons/suitcase.svg` | Baggage details and packing section |
| Favourites | `icons/heart.svg` or `icons/star.svg` | Heart for saved destinations; star for featured/recommended items; consistent semantics |
| Weather | `icons/sun.svg`, `icons/cloud.svg` | Match actual weather state; do not hardcode sun |
| Alerts | `icons/alert.svg` | Real warnings only, not decorative |
| Successful action | `icons/check.svg` | Saved/available/complete states |
| Settings/admin | `icons/settings.svg` | Settings action, not user avatar |
| No itinerary results | `illustrations/no-results.svg` | Empty search result state; suggest adjusting route/date |
| Saved itinerary confirmation | `illustrations/trip-saved.svg` | After verified successful save |
| Ready / trip preparation | `illustrations/ready-to-go.svg` | Trip detail preparation or booking-ready section; not a booking guarantee |

## Layout and visual hierarchy
1. Keep the existing ON/WARD navigation structure. Use navy `#173B70` as the principal header colour, white text and the light wordmark.
2. Use a restrained hero with blue/teal overlay or the `coast.svg` vector. Keep hero heading, live status and weather visible and readable. Existing weather text/data must remain dynamic.
3. Keep the white rounded search form as the most prominent interactive surface. Use blue `#2878D0` for the primary Search CTA, not amber.
4. Use neutral surfaces `#FFFFFF`, background `#F4F7FB`, borders `#E2E9F2`, primary text `#172B45`. Use teal `#20A995` for positive accents and amber `#F2B84B` sparingly for discovery/highlights.
5. Transport mode chips should have consistent size and selected-state styling; use the SVG icons and text labels. Do not use colour alone to indicate selection.
6. On narrow screens, stack form controls, keep a full-width search button, preserve accessible tap targets (at least 44px), and prevent the hero artwork from obscuring text.
7. Use SVG illustrations for empty states, not for every row in dense search results. Limit repeated decorative imagery to improve loading and clarity.

## Implementation steps
1. Inspect the current framework and directory structure. Do not assume React, Vue, Next.js or any specific CSS library.
2. Copy all `onward-assets/` contents into `public/assets/onward/` (or the framework's equivalent static directory). Preserve file names and paths.
3. Import `css/tokens.css` once in the global stylesheet, or map its variables to existing theme tokens without duplicating conflicting declarations.
4. Build a centralized `assetPaths` constant/object for references. Example: `const A='/assets/onward/'; const assetPaths={logoLight:A+'logos/wordmark-light.svg',plane:A+'icons/plane.svg',noResults:A+'illustrations/no-results.svg'}`.
5. Replace old branding with the correct wordmark for its background. Do not stretch SVGs or add unapproved effects to the logo.
6. Update transport, navigation, date, people, weather, search and state icons where a matching file exists. Retain the existing icon library for controls without supplied equivalents (e.g., swap arrows, chevrons, clock, hamburger), styled consistently.
7. Add the banners only in appropriate landing/destination sections. Ensure responsive cropping/contain behaviour and text contrast.
8. Add the three illustrations only for their corresponding application states.
9. Generate PWA PNGs from the app mark at 192x192 and 512x512, plus a maskable 512x512 with safe padding. Also export favicon PNG/ICO as needed; these raster outputs are **not included** in the source ZIP. Update the web manifest paths only after export.
10. Run build, lint and UI checks; validate every asset path resolves successfully.

## Accessibility and performance
- Meaningful images get descriptive alt text; decorative graphics use `alt=""` and `aria-hidden="true"` where appropriate.
- Icon-only buttons must have an accessible label; adjacent icon + text should not repeat the same screen-reader announcement.
- Ensure WCAG AA text contrast; check light wordmark on navy, buttons and active chips.
- Prefer SVG `<img>` references for simple static icons, and set explicit dimensions to prevent layout shift.
- Lazy-load below-the-fold banners/illustrations; do not lazy-load the navbar logo or visible hero.
- Never use a graphic to replace live weather data, fare data or dynamic status.
- Avoid inline recolouring that breaks multicolour logos. For monochrome UI controls, use the supplied asset as-is or existing icon components if colour adaptation is necessary.

## Agent acceptance criteria
- Existing search, filters, date/time, people, airports, favourites, admin and navigation still work.
- Logo displays correctly on dark and light backgrounds.
- All referenced files exist in the package; no invented filenames.
- No 404 asset requests, broken images, stretched icons or horizontal overflow.
- Responsive layout verified at ~375px, 768px and 1440px widths.
- No fabricated destination photographs, real-time weather, booking states or search results.
- Changes are scoped to visual integration; report modified files and any missing asset needs.

## Copy/paste task for coding agent
> Integrate the supplied `onward-assets` pack into my existing ON/WARD travel planning app. Read `AGENT_IMPLEMENTATION_GUIDE.md`, `manifest.json`, and `css/tokens.css` first. Follow the exact asset-to-component placement table. Preserve all business logic and existing data bindings. Apply the navy/blue/teal/amber visual system, use the correct logo on each background, replace relevant transport and utility icons, add landing banners and state illustrations, and maintain responsive/accessibility standards. Do not invent filenames or assume photographic images exist. Generate PWA raster icons from the supplied SVG mark if required. Run checks and summarize changed files and any missing assets.
