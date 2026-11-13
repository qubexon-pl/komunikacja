"""Session tokens and password hashes, byte-for-byte compatible with the Node server (src/auth.js).

A session token is 32 random bytes in base64url (43 characters); only its SHA-256 is stored (dbo.AuthSession).
The same token works as the web cookie `rzbus_session` and as a native app's `Authorization: Bearer` token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

SESSION_COOKIE = "rzbus_session"
OAUTH_COOKIE = "rzbus_oauth_state"
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
SCRYPT_N, SCRYPT_R, SCRYPT_P = 16384, 8, 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
DUMMY_HASH = "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$" + "A" * 86


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_token() -> str:
    return b64url(secrets.token_bytes(32))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def valid_token(token: str | None) -> bool:
    return isinstance(token, str) and bool(TOKEN_PATTERN.match(token))


def hash_password(password: str) -> str:
    if not isinstance(password, str) or not 12 <= len(password) <= 256:
        raise ValueError("Hasło musi mieć od 12 do 256 znaków.")
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=SCRYPT_MAXMEM, dklen=64)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64url(salt)}${b64url(key)}"


def verify_password(password: str, encoded: str) -> bool:
    if not isinstance(password, str) or not isinstance(encoded, str):
        return False
    parts = encoded.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, expected = b64url_decode(parts[4]), b64url_decode(parts[5])
    except (ValueError, TypeError):
        return False
    if (n, r, p) != (SCRYPT_N, SCRYPT_R, SCRYPT_P) or len(salt) != 16 or len(expected) != 64:
        return False
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=len(expected))
    return hmac.compare_digest(actual, expected)


def normalize_email(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Podaj prawidłowy adres e-mail.")
    email = value.strip().lower()
    if len(email) > 320 or not EMAIL_PATTERN.match(email):
        raise ValueError("Podaj prawidłowy adres e-mail.")
    return email


def safe_return_to(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    if any(ord(ch) < 0x20 for ch in value):
        return "/"
    return value


def pkce_pair() -> tuple[str, str]:
    verifier = new_token()
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge
