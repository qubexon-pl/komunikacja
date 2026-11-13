"""Who is calling: the session from the web cookie or from a native app's bearer token, plus CSRF and rate limits."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .security import SESSION_COOKIE, token_hash, valid_token

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class Caller:
    token: str | None
    via: str  # "bearer", "cookie" or "none"


def caller_of(request: Request) -> Caller:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return Caller(auth[7:].strip(), "bearer")
    cookie = request.cookies.get(SESSION_COOKIE)
    return Caller(cookie, "cookie") if cookie else Caller(None, "none")


def require_same_origin(request: Request) -> None:
    """Cookie sessions must come from the app's own pages; bearer tokens are never sent by a browser on its own."""
    if caller_of(request).via == "bearer":
        return
    settings = request.app.state.settings
    if request.headers.get("origin") != settings.app_origin:
        raise HTTPException(403, "Nie udało się zweryfikować źródła żądania.")


def current_user(request: Request) -> dict | None:
    caller = caller_of(request)
    if not valid_token(caller.token):
        return None
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached or None
    user = request.app.state.repo.user_by_session(token_hash(caller.token))
    request.state.user = user or {}
    return user


def require_user(request: Request) -> dict:
    user = current_user(request)
    if not user:
        raise HTTPException(401, "Zaloguj się, aby kontynuować.")
    if request.method not in SAFE_METHODS:
        require_same_origin(request)
    return user


class RateLimit:
    """At most `limit` attempts per client address in `window` seconds (sign-in attempts, uploads)."""

    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self.hits: dict[str, tuple[float, int]] = {}
        self.lock = threading.Lock()

    def take(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            if len(self.hits) > 10000:
                self.hits.clear()
            start, count = self.hits.get(key, (now, 0))
            if now - start >= self.window:
                start, count = now, 0
            self.hits[key] = (start, count + 1)
            return count + 1 <= self.limit


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
