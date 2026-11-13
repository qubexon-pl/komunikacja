"""Sign-in: e-mail + password, Google on the web (OIDC code flow with PKCE) and Google in the native apps (ID token).

Every route ends in an app session (dbo.AuthSession) for the app's own user id; Google only proves who the person is.
Web clients get the session as an HttpOnly cookie; native clients get the token in the body and keep it in the
device's secure storage. Registration, password reset and account deletion (e-mail codes) still run on Node.
"""
from __future__ import annotations

from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from .deps import RateLimit, caller_of, client_ip, current_user, require_same_origin
from .repo import Conflict
from .security import (DUMMY_HASH, OAUTH_COOKIE, SESSION_COOKIE, new_token, normalize_email, pkce_pair, safe_return_to, token_hash,
                       valid_token, verify_password)

router = APIRouter(prefix="/api/auth")
OAUTH_TTL = 10 * 60


def _public(user: dict, settings) -> dict:
    return {**user, "canAdminister": bool(user.get("isAdmin") or user.get("email", "").lower() in settings.admin_emails)}


def _wants_token(request: Request) -> bool:
    return request.headers.get("x-auth-mode") == "token" or caller_of(request).via == "bearer"


def _session(request: Request, response: Response, user: dict) -> dict:
    settings, repo = request.app.state.settings, request.app.state.repo
    token = new_token()
    repo.create_session(user["id"], token_hash(token), settings.session_ttl_seconds)
    body = {"user": _public(user, settings)}
    if _wants_token(request):
        body.update(token=token, expiresIn=settings.session_ttl_seconds)
    else:
        response.set_cookie(SESSION_COOKIE, token, max_age=settings.session_ttl_seconds, path="/", httponly=True, samesite="lax",
                            secure=settings.secure_cookies)
    return body


def _limit(request: Request) -> None:
    if not request.app.state.auth_attempts.take(client_ip(request)):
        raise HTTPException(429, "Zbyt wiele prób. Spróbuj ponownie za 15 minut.")


@router.get("/me")
def me(request: Request):
    user = current_user(request)
    return {"user": _public(user, request.app.state.settings) if user else None}


@router.post("/login")
async def login(request: Request, response: Response):
    if not _wants_token(request):
        require_same_origin(request)
    _limit(request)
    body = await request.json()
    try:
        email = normalize_email(body.get("email"))
    except ValueError:
        raise HTTPException(401, "Nieprawidłowy adres e-mail lub hasło.")
    password = body.get("password")
    if not isinstance(password, str) or len(password) > 256:
        raise HTTPException(401, "Nieprawidłowy adres e-mail lub hasło.")
    found = request.app.state.repo.local_login(email)
    ok = verify_password(password, found[1] if found else DUMMY_HASH)  # same work for unknown e-mails
    if not ok or not found:
        raise HTTPException(401, "Nieprawidłowy adres e-mail lub hasło.")
    return _session(request, response, found[0])


@router.post("/logout")
def logout(request: Request, response: Response):
    caller = caller_of(request)
    if caller.via == "cookie":
        require_same_origin(request)
    if valid_token(caller.token):
        request.app.state.repo.delete_session(token_hash(caller.token))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"signedOut": True}


def _google_user(request: Request, claims: dict) -> dict:
    settings = request.app.state.settings
    if claims.get("email_verified") not in (True, "true") or not claims.get("sub") or not claims.get("email"):
        raise HTTPException(401, "Użyj konta Google ze zweryfikowanym adresem e-mail.")
    email = normalize_email(claims["email"])
    name = (str(claims.get("name") or "").strip()[:100]) or email
    try:
        return request.app.state.repo.google_user(str(claims["sub"])[:255], email, name, email in settings.admin_emails)
    except Conflict:
        raise HTTPException(409, "Konto z tym adresem e-mail już istnieje. Zaloguj się metodą użytą przy jego tworzeniu.")


@router.post("/google/native")
async def google_native(request: Request, response: Response):
    """Android/iOS: the Google SDK on the phone signs the person in and hands us an ID token; we check its signature,
    issuer, audience and expiry against Google's keys, then open an app session."""
    _limit(request)
    settings = request.app.state.settings
    if not settings.google_audiences:
        raise HTTPException(503, "Logowanie przez Google nie jest skonfigurowane.")
    body = await request.json()
    id_token = body.get("idToken")
    if not isinstance(id_token, str) or len(id_token) > 8192:
        raise HTTPException(400, "Brak tokenu Google.")
    try:
        claims = request.app.state.verify_google_token(id_token, settings.google_audiences)
    except Exception:
        raise HTTPException(401, "Nie udało się potwierdzić logowania przez Google.")
    return _session_token(request, _google_user(request, claims))


def _session_token(request: Request, user: dict) -> dict:
    settings, repo = request.app.state.settings, request.app.state.repo
    token = new_token()
    repo.create_session(user["id"], token_hash(token), settings.session_ttl_seconds)
    return {"user": _public(user, settings), "token": token, "expiresIn": settings.session_ttl_seconds}


@router.get("/google")
def google_start(request: Request, returnTo: str = "/"):
    settings = request.app.state.settings
    if not settings.google_web_enabled:
        return JSONResponse({"error": "Logowanie przez Google nie jest skonfigurowane."}, 503)
    state = new_token()
    verifier, challenge = pkce_pair()
    request.app.state.repo.save_oauth_state(token_hash(state), verifier, safe_return_to(returnTo), OAUTH_TTL)
    query = urlencode({"client_id": settings.google_client_id, "redirect_uri": f"{settings.app_base_url}/api/auth/google/callback",
                       "response_type": "code", "scope": "openid email profile", "state": state,
                       "code_challenge": challenge, "code_challenge_method": "S256"})
    response = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{query}", 302)
    response.set_cookie(OAUTH_COOKIE, state, max_age=OAUTH_TTL, path="/api/auth/google", httponly=True, samesite="lax",
                        secure=settings.secure_cookies)
    return response


@router.get("/google/callback")
async def google_callback(request: Request):
    settings, repo = request.app.state.settings, request.app.state.repo

    def fail(reason: str = "google_signin_failed"):
        r = RedirectResponse(f"/login?error={reason}", 302)
        r.delete_cookie(OAUTH_COOKIE, path="/api/auth/google")
        return r

    q = request.query_params
    state = q.get("state") or ""
    if "error" in q or not state or state != request.cookies.get(OAUTH_COOKIE):
        return fail()
    saved = repo.consume_oauth_state(token_hash(state))
    if not saved or not q.get("code"):
        return fail()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            tokens = await client.post("https://oauth2.googleapis.com/token", data={
                "client_id": settings.google_client_id, "client_secret": settings.google_client_secret, "code": q["code"],
                "code_verifier": saved["codeVerifier"], "redirect_uri": f"{settings.app_base_url}/api/auth/google/callback",
                "grant_type": "authorization_code"})
            tokens.raise_for_status()
            id_token = tokens.json().get("id_token")
        claims = request.app.state.verify_google_token(id_token, (settings.google_client_id,))
        user = _google_user(request, claims)
    except HTTPException as error:
        return fail("google_account_exists" if error.status_code == 409 else "google_signin_failed")
    except Exception:
        return fail()
    token = new_token()
    repo.create_session(user["id"], token_hash(token), settings.session_ttl_seconds)
    response = RedirectResponse(safe_return_to(saved["returnTo"]), 302)
    response.set_cookie(SESSION_COOKIE, token, max_age=settings.session_ttl_seconds, path="/", httponly=True, samesite="lax",
                        secure=settings.secure_cookies)
    response.delete_cookie(OAUTH_COOKIE, path="/api/auth/google")
    return response


def verify_google_id_token(id_token: str, audiences: tuple[str, ...]) -> dict:
    """Signature (Google's published keys), expiry and issuer are checked by google-auth; the audience must be one of ours."""
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    claims = google_id_token.verify_oauth2_token(id_token, google_requests.Request(), audience=None)
    if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("issuer")
    if claims.get("aud") not in audiences:
        raise ValueError("audience")
    return claims
