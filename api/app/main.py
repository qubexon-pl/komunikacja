"""ON/WARD API front: FastAPI serves sign-in, the user's own data and photos directly from Azure SQL / ADLS, and passes
every other request (pages, timetables, live buses, trains, flights, weather…) to the Node server until each of those
modules is moved here. Web, Android and iOS all call these same endpoints.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000   (from the api/ folder; Node on NODE_UPSTREAM)
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from . import routes_auth, routes_trips, routes_user
from .config import Settings, load_settings
from .deps import RateLimit, caller_of
from .security import SESSION_COOKIE, valid_token

HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
              "host", "content-length"}


def create_app(settings: Settings | None = None, repo=None, storage=None, verify_google_token=None, upstream: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.http = httpx.AsyncClient(base_url=settings.node_upstream, transport=upstream, timeout=httpx.Timeout(120, connect=10),
                                           follow_redirects=False)
        yield
        await app.state.http.aclose()

    app = FastAPI(title="ON/WARD API", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.state.settings = settings
    if repo is None:
        from .db import Database
        from .repo import SqlRepository

        repo = SqlRepository(Database(settings))
    if storage is None:
        from .storage import create_storage

        storage = create_storage(settings)
    app.state.repo, app.state.storage = repo, storage
    app.state.verify_google_token = verify_google_token or routes_auth.verify_google_id_token
    app.state.auth_attempts = RateLimit(limit=10, window=15 * 60)  # sign-in attempts per address
    app.state.upload_chunks = RateLimit(limit=600, window=60 * 60)  # photo chunks per user
    app.state.trip_invites = RateLimit(limit=30, window=60 * 60)  # adding people also tells whether an e-mail has an account
    app.state.people_search = RateLimit(limit=120, window=60)  # suggestions while typing a name or e-mail
    app.state.trip_positions = RateLimit(limit=120, window=60 * 60)  # one position every 30 s on average

    # Native apps load the pages from the device and call the API cross-origin with a bearer token (no cookies).
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.native_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "Upload-Offset", "X-Auth-Mode", "If-None-Match"],
                       expose_headers=["ETag"], max_age=600)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if settings.secure_cookies:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):  # same shape as the Node server: {"error": "..."}
        body = exc.detail if isinstance(exc.detail, dict) else {"error": exc.detail}
        return JSONResponse(body, exc.status_code, headers=getattr(exc, "headers", None))

    try:
        import pyodbc

        @app.exception_handler(pyodbc.ProgrammingError)
        async def missing_table(request: Request, exc: Exception):
            # A table this version needs is not created yet (e.g. TripShare before `npm run db:migrate`): say so plainly.
            if "Invalid object name" in str(exc) or "Invalid column name" in str(exc):
                return JSONResponse({"error": "Udostępnianie nie jest jeszcze włączone na serwerze (brak tabel lub kolumn w bazie – uruchom migrację: npm run db:migrate)."}, 503)
            return JSONResponse({"error": "Błąd bazy danych."}, 500)
    except ImportError:  # pragma: no cover
        pass

    @app.exception_handler(RequestValidationError)
    async def bad_request(request: Request, exc: RequestValidationError):
        return JSONResponse({"error": "Nieprawidłowe zapytanie."}, 400)

    @app.get("/api/health")
    async def health(request: Request):
        db = node = "unknown"
        try:
            db = "connected" if getattr(request.app.state.repo, "db", None) is None or request.app.state.repo.db.ping() else "error"
        except Exception:
            db = "error"
        try:
            node = "up" if (await request.app.state.http.get("/api/health", timeout=5)).status_code < 500 else "error"
        except Exception:
            node = "down"
        ok = db == "connected"
        return JSONResponse({"status": "ok" if ok else "degraded", "database": db, "node": node}, 200 if ok else 503)

    @app.get("/api/auth/config")
    async def auth_config(request: Request):
        base = {}
        try:
            r = await request.app.state.http.get("/api/auth/config", timeout=5)
            if r.status_code == 200:
                base = r.json()
        except Exception:
            pass
        return {**base, "googleEnabled": settings.google_web_enabled, "googleNativeEnabled": bool(settings.google_audiences),
                "googleClientId": settings.google_client_id or None}

    app.include_router(routes_auth.router)
    app.include_router(routes_user.router)
    app.include_router(routes_trips.router)

    @app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"], include_in_schema=False)
    async def to_node(request: Request, path: str):
        """Everything not handled above goes to the Node server, unchanged except for who the caller is."""
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "authorization"}
        caller = caller_of(request)
        if caller.via == "bearer" and valid_token(caller.token):
            # Node reads the session from its cookie and checks Origin on changes; the bearer token stands in for both.
            headers["cookie"] = f"{SESSION_COOKIE}={caller.token}"
            if request.method not in ("GET", "HEAD"):
                headers["origin"] = settings.app_origin
        forwarded = request.client.host if request.client else ""
        headers["x-forwarded-for"] = forwarded
        headers["x-forwarded-proto"] = request.url.scheme
        upstream_request = request.app.state.http.build_request(request.method, request.url.path, params=request.url.query,
                                                                 headers=headers, content=request.stream())
        try:
            response = await request.app.state.http.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return JSONResponse({"error": "Serwer danych jest chwilowo niedostępny."}, 502)
        out_headers = [(k, v) for k, v in response.headers.multi_items() if k.lower() not in HOP_BY_HOP]
        if request.url.path.startswith("/api/auth/") and request.headers.get("x-auth-mode") == "token":
            # Sign-in steps still on Node (registration, e-mail codes) answer with a session cookie; an app cannot keep
            # a cross-site cookie, so the session moves into the JSON body and the cookie is dropped.
            await response.aread()
            await response.aclose()
            token = next((c.split(";", 1)[0].split("=", 1)[1] for k, c in out_headers
                          if k.lower() == "set-cookie" and c.startswith(f"{SESSION_COOKIE}=")), "")
            headers = [(k, v) for k, v in out_headers if k.lower() not in ("set-cookie", "content-encoding", "content-type")]
            try:
                payload = response.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and valid_token(token):
                payload["token"] = token
            return JSONResponse(payload, response.status_code, headers=dict(headers)) if payload is not None else \
                Response(response.content, response.status_code, headers=dict(headers), media_type=response.headers.get("content-type"))

        async def body():
            if response.is_stream_consumed:  # already read (e.g. a test transport): send what was read
                yield response.content
            else:  # stream through without decoding, so Content-Encoding stays valid
                async for chunk in response.aiter_raw():
                    yield chunk

        result = StreamingResponse(body(), status_code=response.status_code, background=BackgroundTask(response.aclose))
        result.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out_headers]
        return result

    return app


def _default_app() -> FastAPI:
    return create_app()


app = None
try:  # importing for tests must not need Azure settings
    import os

    if not os.environ.get("ONWARD_TESTING"):
        app = _default_app()
except RuntimeError as error:  # pragma: no cover - shown when uvicorn starts without configuration
    raise SystemExit(f"ON/WARD API: {error}")
