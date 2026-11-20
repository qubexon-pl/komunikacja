# podavo.voyage on web, Android and iOS

One frontend (the existing pages in `index.html`, `login.html` and `assets/`) runs in the browser, as an installable PWA
and inside native Android/iOS apps built with Capacitor. All three call the same API.

## Architecture

```
 Browser / PWA ──┐                 ┌── Azure SQL (Entra ID, Managed Identity)
 Android app  ───┼──► FastAPI (api/) ┤
 iOS app      ───┘   public, HTTPS   ├── ADLS Gen2 "trip-photos" (private, Managed Identity)
                                     └──► Node server (src/) on 127.0.0.1 — endpoints not yet moved to FastAPI
```

**FastAPI (`api/`)** is the public entry point. It serves directly:

| Area | Endpoints |
|---|---|
| Sign-in | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/config`, `GET /api/auth/google` + `/callback` (web), `POST /api/auth/google/native` (apps) |
| User data | `GET/PUT /api/favorites` (incl. saved trips and itineraries), `GET/PUT /api/preferences` |
| Photos | `POST /api/photos`, `GET /api/photos?tripId=`, `GET /api/photos/{id}`, `PUT /api/photos/{id}/content`, `GET /api/photos/{id}/file`, `DELETE /api/photos/{id}` |
| Health | `GET /api/health` |

Every other request (pages, timetables, live buses, trains, flights, weather, transfers, e-mail-code sign-up/reset/delete)
is passed to the Node server, which keeps running on the same machine until each module is ported. Both use the same
tables (`AppUser`, `AuthSession`, …) and the same session token, so a user signed in through FastAPI is signed in for
Node too.

**Users and sessions.** Google only proves identity: the first Google sign-in creates an app user with its own id
(`AppUser.user_id`) and links it in `ExternalIdentity`. Sessions are 32 random bytes; only their SHA-256 is stored.
The web gets the session as an `HttpOnly; Secure; SameSite=Lax` cookie (state-changing requests must come from the app
origin). The apps get the same token in the response body, keep it in the Keychain / Android Keystore
(`capacitor-secure-storage-plugin`) and send `Authorization: Bearer …`. Requests from the apps' web views
(`capacitor://localhost`, `https://localhost`) are the only cross-origin calls CORS allows.

**Photos.** `POST /api/photos` checks that the trip is one of the caller's own saved trips, then the app sends 4 MB
chunks with `Upload-Offset`. A chunk at the wrong offset gets `409` with the offset the server has; after a dropped
connection the app asks `GET /api/photos/{id}` and continues. The first bytes must match the declared image type
(JPEG, PNG, WebP, HEIC). Files are stored at `<userId>/<tripId>/<photoId>.<ext>`, become readable only after the
last chunk, and are served only to their owner (`Cache-Control: private`). Metadata is in `dbo.TripPhoto`.

**Offline.**
- Web/PWA: `/sw.js` caches the app shell and libraries and keeps the signed-in user's own data (account, favourites
  with saved trips, photos, trip weather) readable offline. Live data and map tiles are not cached. The user cache is
  cleared at logout.
- Apps: pages and libraries ship inside the app (`www/`, built by `scripts/build-web.mjs`, no CDN needed).
- Both: saved trips are kept in local storage; changes made offline are marked pending and sent when the connection
  returns. Photos wait in IndexedDB and upload when online.

**Device features** (in `assets/app.native.js`, inactive on the web): native Google sign-in
(`@capgo/capacitor-social-login`), camera and gallery (`@capacitor/camera`), GPS with the native permission prompt
(`@capacitor/geolocation`), native share sheet (`@capacitor/share`), Google Maps links opened in the Maps app
(`@capacitor/app-launcher`; every itinerary "Google Maps / directions" link carries the destination and travel mode),
Android back button (closes a dialog or menu, then goes back, then exits), status bar, splash screen and keyboard.

## Configuration

`.env` (development) or App Service settings (Azure). Secrets stay on the server; the apps get only public values.

| Setting | Used by | Notes |
|---|---|---|
| `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE` | FastAPI, Node | Entra ID only; no SQL passwords |
| `AZURE_CLIENT_ID` | FastAPI, Node | client id of a user-assigned Managed Identity (omit for system-assigned) |
| `APP_BASE_URL` | FastAPI, Node | public HTTPS address, e.g. `https://onward.example.com` |
| `NODE_UPSTREAM` | FastAPI | default `http://127.0.0.1:3000` |
| `HOST=127.0.0.1`, `TRUST_PROXY=true` | Node | Node reachable only through FastAPI; per-user rate limits use `X-Forwarded-For` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | FastAPI (web sign-in) | Web client from Google Cloud |
| `GOOGLE_NATIVE_CLIENT_IDS` | FastAPI | comma-separated Android and iOS client ids (accepted ID-token audiences) |
| `ADMIN_EMAILS` | FastAPI, Node | |
| `PHOTO_STORAGE=adls`, `ADLS_ACCOUNT_URL`, `ADLS_FILE_SYSTEM` | FastAPI | e.g. `https://<account>.dfs.core.windows.net`, `trip-photos`; without them photos go to `.cache/photos` (development only) |
| `NATIVE_ORIGINS` | FastAPI | default `capacitor://localhost,https://localhost,http://localhost` |
| `ONWARD_API_BASE`, `GOOGLE_IOS_CLIENT_ID` | app build | public values written into the app by `npm run web:build` |
| `ONWARD_API_BASE`, `GOOGLE_CLIENT_ID` | GitHub repository variables | used by the CI debug APK build (Settings → Secrets and variables → Actions → Variables) |

## One-time setup

1. **Database** – create the photo table (adds `dbo.TripPhoto`, changes nothing else): `npm run db:migrate`.
   Then, as an Entra admin of the database, run `database/fastapi-permissions.sql` for the identity that runs FastAPI
   (only the table rights FastAPI uses — no roles, no DDL).
2. **Photo storage** – a StorageV2 account with *hierarchical namespace* enabled, a private file system
   `trip-photos` (no public access, shared-key access disabled), and the role **Storage Blob Data Contributor** on that
   file system for FastAPI's Managed Identity. Locally your own Azure sign-in needs the same role.
3. **Google Cloud** (OAuth consent screen + three OAuth clients in the same project):
   - *Web*: authorized redirect URI `https://<APP_BASE_URL>/api/auth/google/callback` → `GOOGLE_CLIENT_ID`/`SECRET`.
   - *Android*: package `app.podavo.voyage` and the SHA-1 of your upload key **and** of the Play App Signing key.
   - *iOS*: bundle id `app.podavo.voyage`; put its id in `GOOGLE_IOS_CLIENT_ID` and its reversed form
     (`com.googleusercontent.apps.<id>`) in `ios/App/App/Info.plist` instead of `REPLACE_WITH_IOS_CLIENT_ID`.
   - Add the Android and iOS client ids to `GOOGLE_NATIVE_CLIENT_IDS` on the server.
4. **App id** – `app.podavo.voyage` is in `capacitor.config.json`, `android/app/build.gradle` and the Xcode project;
   change it everywhere before the first store upload if you want a different one.

## Running

```bash
# backend (two processes; in Azure run both in one App Service / container, FastAPI on the public port)
HOST=127.0.0.1 TRUST_PROXY=true npm start                # Node on :3000
cd api && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
npm run api:dev                                          # FastAPI on :8000 → open http://localhost:8000/plan

npm run test:all                                         # Node tests + FastAPI tests (no Azure needed)
```

Simplest locally: `npm run dev:all` starts both (Node on :3000, FastAPI on :8000). Keep opening
http://localhost:3000 — Node passes `/api/trips/*` (trip sharing, locations) on to FastAPI
(`API_UPSTREAM`, default `http://127.0.0.1:8000`). With only `npm start`, the trip page says that
sharing needs FastAPI.

Production start command for FastAPI: `uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --workers 2`
(working directory `api/`, ODBC Driver 18 installed — included in the App Service Python images).

## Building the apps

```bash
ONWARD_ENV=production ONWARD_API_BASE=https://onward.example.com npm run cap:sync   # builds www/ and copies it into both apps
npm run android:open      # Android Studio (bundles JDK 21 and Android SDK 36 that the build needs)
npm run ios:open          # Xcode on a Mac
```

- **Android / Google Play**: create an upload key (`keytool -genkeypair -v -keystore onward-upload.jks -keyalg RSA
  -keysize 2048 -validity 10000 -alias onward`), write `android/keystore.properties` (`storeFile`, `storePassword`,
  `keyAlias`, `keyPassword`; not in git), raise `versionCode`/`versionName` in `android/app/build.gradle`, then
  `npm run android:release` → `android/app/build/outputs/bundle/release/app-release.aab`. Enrol in Play App Signing
  and add its SHA-1 to the Android OAuth client. Store listing needs a privacy policy URL and the Data safety form
  (location, photos, e-mail address, account id).
- **iOS / App Store**: on a Mac with Xcode, open `ios/App/App.xcodeproj`, set the Team and bundle id under *Signing &
  Capabilities*, replace the Google URL scheme in `Info.plist`, raise the version, *Product → Archive*, upload with
  Organizer. App Store Connect needs the privacy details (location, photos, contact info, identifiers) and a demo
  account for review.
- Debug against a local backend: the app must reach the API over the network — use the computer's LAN address or a
  dev tunnel with HTTPS for `ONWARD_API_BASE` (Android emulator: `http://10.0.2.2:8000` works only in debug builds
  with cleartext allowed).

## Still to do

- Port the remaining Node modules to FastAPI (timetables, live data, trains, flights, transfers, weather, e-mail
  codes); until then FastAPI forwards them and Node must run next to it.
- Deleting an account (still on Node) removes the user's photo rows through the foreign key, but not the files in
  ADLS; port account deletion to FastAPI or add a storage lifecycle/cleanup job before launch.
- Real-device testing of camera, Google sign-in and back-button flows on Android and iOS.
