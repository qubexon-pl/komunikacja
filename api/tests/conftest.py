import os
import sys
from pathlib import Path

os.environ["ONWARD_TESTING"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import load_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.repo import Conflict  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.storage import LocalStorage  # noqa: E402

ORIGIN = "https://app.example"
U1 = "11111111-1111-4111-8111-111111111111"


class MemoryRepo:
    """In-memory stand-in for SqlRepository with the same behaviour the routes rely on."""

    def __init__(self):
        self.users = {U1: {"id": U1, "email": "ania@example.com", "displayName": "Ania", "isAdmin": False}}
        self.passwords = {"ania@example.com": (U1, hash_password("correct horse battery"))}
        self.sessions, self.states, self.google, self.favs, self.prefs, self.photos_ = {}, {}, {}, {}, {}, {}
        self.shares, self.locs, self.clock, self.grants = [], {}, None, set()

    def user_by_session(self, h): return self.users.get(self.sessions.get(h))
    def create_session(self, uid, h, ttl): self.sessions[h] = uid
    def delete_session(self, h): self.sessions.pop(h, None)

    def local_login(self, email):
        found = self.passwords.get(email)
        return (self.users[found[0]], found[1]) if found else None

    def save_oauth_state(self, h, verifier, return_to, ttl): self.states[h] = {"codeVerifier": verifier, "returnTo": return_to}
    def consume_oauth_state(self, h): return self.states.pop(h, None)

    def google_user(self, sub, email, name, is_admin):
        if sub in self.google:
            return self.users[self.google[sub]]
        if any(u["email"] == email for u in self.users.values()):
            raise Conflict()
        import uuid
        uid = str(uuid.uuid4())
        self.users[uid] = {"id": uid, "email": email, "displayName": name, "isAdmin": is_admin}
        self.google[sub] = uid
        return self.users[uid]

    def favorites(self, uid): return self.favs.get(uid, [])
    def save_favorites(self, uid, f): self.favs[uid] = f
    def preferences(self, uid): return self.prefs.get(uid, {})
    def save_preferences(self, uid, p): self.prefs[uid] = p
    def create_photo(self, p): self.photos_[p["id"]] = {**p, "received": 0, "status": "uploading", "sha256": None, "createdAt": None}

    def photo(self, uid, pid):
        p = self.photos_.get(pid)
        return dict(p) if p and p["userId"] == uid else None

    def photo_progress(self, pid, n): self.photos_[pid]["received"] = n
    def photo_ready(self, pid, sha): self.photos_[pid].update(status="ready", sha256=sha)
    def photos(self, uid, tid): return [dict(p) for p in self.photos_.values() if p["userId"] == uid and p["tripId"] == tid]

    # shared trips and locations
    def user_by_id(self, uid): return self.users.get(uid)
    def people_search(self, uid, q, limit=6):
        contacts = {m for (o, t, m) in self.shares if o == uid} | {o for (o, t, m) in self.shares if m == uid}
        out = []
        for u in self.users.values():
            if u["id"] == uid:
                continue
            c = u["id"] in contacts
            if (c and (u["displayName"].lower().startswith(q) or u["email"].startswith(q))) or (len(q) >= 3 and u["email"].startswith(q)):
                out.append({"id": u["id"], "email": u["email"], "name": u["displayName"], "contact": c})
        return sorted(out, key=lambda x: (not x["contact"], x["name"]))[:limit]

    def user_by_email(self, email): return next((u for u in self.users.values() if u["email"] == email), None)

    def trip_members(self, owner, tid):
        return [{"id": m, "email": self.users[m]["email"], "name": self.users[m]["displayName"]} for (o, t, m) in self.shares if o == owner and t == tid]

    def add_member(self, owner, tid, member):
        if (owner, tid, member) not in self.shares:
            self.shares.append((owner, tid, member))

    def remove_member(self, owner, tid, member):
        self.shares = [x for x in self.shares if x != (owner, tid, member)]
        self.locs.pop((owner, tid, member), None)
        self.grants = {g for g in self.grants if not (g[0] == owner and g[1] == tid and member in (g[2], g[3]))}

    def location_grants(self, owner, tid):
        return [(u, v) for (o, t, u, v) in sorted(self.grants) if o == owner and t == tid]

    def set_location_grant(self, owner, tid, uid, viewer, enabled):
        (self.grants.add if enabled else self.grants.discard)((owner, tid, uid, viewer))

    def clear_location_grants(self, owner, tid, uid):
        self.grants = {g for g in self.grants if not (g[0] == owner and g[1] == tid and g[2] == uid)}

    def is_member(self, owner, tid, uid): return (owner, tid, uid) in self.shares
    def shared_with(self, member): return [{"ownerId": o, "tid": t, "ownerName": self.users[o]["displayName"]} for (o, t, m) in self.shares if m == member]

    def my_shares(self, owner):
        out = {}
        for (o, t, m) in self.shares:
            if o == owner:
                out.setdefault(t, []).append(self.users[m]["displayName"])
        return out

    def location_sharing(self, owner, tid, uid, until):
        if until:
            self.locs[(owner, tid, uid)] = {**self.locs.get((owner, tid, uid), {"lat": None, "lon": None, "accuracy": None, "at": None}), "until": until}
        else:
            self.locs.pop((owner, tid, uid), None)

    def save_location(self, owner, tid, uid, lat, lon, acc):
        from datetime import datetime, timezone
        loc = self.locs.get((owner, tid, uid))
        if not loc:
            return False
        loc.update(lat=lat, lon=lon, accuracy=acc, at=self.clock or datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z")
        return True

    def locations(self, owner, tid):
        return [{"userId": u, "name": self.users[u]["displayName"], "until": v["until"].isoformat() + "Z", "lat": v["lat"], "lon": v["lon"],
                 "accuracy": v["accuracy"], "at": v["at"]} for (o, t, u), v in self.locs.items() if o == owner and t == tid]

    def delete_photo(self, uid, pid):
        p = self.photo(uid, pid)
        if p:
            del self.photos_[pid]
        return p


@pytest.fixture
def node_calls():
    return []


@pytest.fixture
def client(tmp_path, node_calls):
    def node(request: httpx.Request) -> httpx.Response:
        node_calls.append(request)
        if request.url.path == "/api/auth/verify-email":
            return httpx.Response(201, json={"user": {"id": "n1"}}, headers={"set-cookie": "rzbus_session=" + "A" * 43 + "; Path=/; HttpOnly"})
        if request.url.path == "/api/auth/config":
            return httpx.Response(200, json={"googleEnabled": False, "emailEnabled": True})
        return httpx.Response(200, json={"from": "node", "path": request.url.path}, headers={"x-upstream": "node"})

    settings = load_settings({"APP_BASE_URL": ORIGIN, "GOOGLE_CLIENT_ID": "web-client", "GOOGLE_CLIENT_SECRET": "s",
                              "GOOGLE_NATIVE_CLIENT_IDS": "ios-client,android-client", "ADMIN_EMAILS": "boss@example.com"})
    repo = MemoryRepo()

    def verify(token, audiences):
        claims = {"good": {"sub": "g-123", "email": "nowy@example.com", "email_verified": True, "name": "Nowy", "aud": "ios-client"},
                  "taken": {"sub": "g-999", "email": "ania@example.com", "email_verified": True, "aud": "web-client"},
                  "unverified": {"sub": "g-5", "email": "x@example.com", "email_verified": False, "aud": "web-client"}}.get(token)
        if not claims or claims["aud"] not in audiences:
            raise ValueError("bad token")
        return claims

    app = create_app(settings, repo=repo, storage=LocalStorage(str(tmp_path)), verify_google_token=verify, upstream=httpx.MockTransport(node))
    with TestClient(app, base_url=ORIGIN) as c:
        c.repo = repo
        yield c
