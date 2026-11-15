"""Shared trips and participants' live location.

A trip is a saved trip (favourite with a `tid`) of its owner. The owner invites other registered users; an invitation
stays pending until the person accepts (with or without showing their location to the organiser) or declines it. Only
people who accepted see the trip, read-only, and can leave it. Location is strictly opt-in per person and per trip: each participant
switches it on for themselves on their own device, it ends automatically (at most a day after the trip), and switching
it off forgets the last position. Nobody can switch it on for somebody else, and only the trip's participants see it.
"""
from __future__ import annotations

import math
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from .deps import require_user
from .favorites import trip_ids
from .security import normalize_email

router = APIRouter(prefix="/api/trips")
MAX_MEMBERS = 20
FRESH_HOURS = 6  # older positions are not shown: they would mislead about where somebody is now


def _uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise HTTPException(404, "Nie znaleziono tej podróży.")


def _trip(request: Request, owner_id: str, tid: str) -> dict:
    """The owner's saved trip, or 404."""
    if not isinstance(tid, str) or len(tid) > 24:
        raise HTTPException(404, "Nie znaleziono tej podróży.")
    for f in request.app.state.repo.favorites(owner_id):
        if f.get("type") == "trip" and f.get("tid") == tid:
            return f
    raise HTTPException(404, "Nie znaleziono tej podróży.")


def _role(request: Request, user: dict, owner_id: str, tid: str) -> str:
    owner_id = _uuid(owner_id)
    if user["id"] == owner_id:
        if tid not in trip_ids(request.app.state.repo.favorites(owner_id)):
            raise HTTPException(404, "Nie znaleziono tej podróży.")
        return "owner"
    if request.app.state.repo.is_member(owner_id, tid, user["id"]):
        return "member"
    raise HTTPException(404, "Nie znaleziono tej podróży.")


def _trip_end(trip: dict) -> datetime:
    """The last day of the trip (return day, else departure day), end of that day plus one day, in UTC."""
    t = trip.get("trip") or {}
    day = (t.get("ret") or {}).get("arrDay") or (t.get("ret") or {}).get("day") or (trip.get("flight") or {}).get("back") \
        or (t.get("out") or {}).get("day") or (trip.get("flight") or {}).get("day")
    try:
        return datetime.fromisoformat(day) + timedelta(days=2)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)


@router.get("/shared")
def shared_with_me(request: Request, user: dict = Depends(require_user)):
    """Trips other people shared with me, as their current saved version."""
    out = []
    for share in request.app.state.repo.shared_with(user["id"]):
        try:
            trip = _trip(request, share["ownerId"], share["tid"])
        except HTTPException:
            continue  # the owner removed the trip
        out.append({"ownerId": share["ownerId"], "ownerName": share["ownerName"], "trip": trip})
    return {"trips": out}


def _mask(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}"


@router.get("/people")
def people(request: Request, q: str = "", user: dict = Depends(require_user)):
    """Suggestions while typing whom to share a trip with. People I already share trips with are shown in full;
    other accounts only when their e-mail starts with what was typed (3+ characters), with the e-mail masked."""
    q = q.strip().lower()[:80]
    if not q:
        return {"people": []}
    if not request.app.state.people_search.take(user["id"]):
        raise HTTPException(429, "Zbyt wiele wyszukiwań. Spróbuj ponownie za chwilę.")
    out = []
    for p in request.app.state.repo.people_search(user["id"], q):
        out.append({"id": p["id"], "name": p["name"], "email": p["email"] if p["contact"] else _mask(p["email"]), "contact": p["contact"]})
    return {"people": out}


@router.get("/inbox")
def inbox(request: Request, user: dict = Depends(require_user)):
    """Notifications about sharing: invitations waiting for my answer, and recent answers to the invitations I sent."""
    repo = request.app.state.repo
    invites = []
    for inv in repo.invites(user["id"]):
        try:
            trip = _trip(request, inv["ownerId"], inv["tid"])
        except HTTPException:
            continue  # the owner removed the trip
        invites.append({**inv, "title": trip.get("title") or "", "from": trip.get("from") or "", "to": trip.get("to") or "",
                        "day": (trip.get("flight") or {}).get("day") or ((trip.get("trip") or {}).get("out") or {}).get("day") or ""})
    titles = {f.get("tid"): f.get("title") or f"{f.get('from') or ''} → {f.get('to') or ''}" for f in repo.favorites(user["id"]) if f.get("type") == "trip"}
    responses = [{**r, "title": titles[r["tid"]]} for r in repo.responses(user["id"]) if r["tid"] in titles]
    return {"invites": invites, "responses": responses}


@router.post("/{owner_id}/{tid}/respond")
async def respond(request: Request, owner_id: str, tid: str, user: dict = Depends(require_user)):
    """Accept or decline an invitation. Accepting "with my location" shows MY location to the organiser only."""
    owner_id = _uuid(owner_id)
    body = await request.json()
    body = body if isinstance(body, dict) else {}
    accept, with_location = body.get("accept") is True, body.get("withLocation") is True
    done = request.app.state.repo.respond_invite(owner_id, tid, user["id"], accept, with_location)
    if done is None:
        raise HTTPException(404, "Nie ma takiego zaproszenia.")
    out = {"status": "accepted" if accept else "declined", "withLocation": accept and with_location, "sharing": None}
    if accept:
        try:
            if done["offersLocation"]:
                _grant(request, owner_id, tid, owner_id, user["id"], True)  # the organiser chose this when inviting
            if with_location:
                out["sharing"] = _grant(request, owner_id, tid, user["id"], owner_id, True)
        except HTTPException:
            pass  # the trip has ended: accepted, but no location any more
    return out


@router.get("/mine/shares")
def my_shares(request: Request, user: dict = Depends(require_user)):
    """Who each of my trips is shared with (names), for the "shared" mark on my trips."""
    return {"shares": request.app.state.repo.my_shares(user["id"])}


@router.get("/{owner_id}/{tid}/members")
def members(request: Request, owner_id: str, tid: str, user: dict = Depends(require_user)):
    role = _role(request, user, owner_id, tid)
    owner_id = _uuid(owner_id)
    repo = request.app.state.repo
    grants = set(repo.location_grants(owner_id, tid))
    owner = repo.user_by_id(owner_id)
    # the organiser sees every invitation with its answer; members see only the people who accepted
    people = [{"id": owner_id, "name": (owner or {}).get("displayName") or "", "role": "owner", "status": "accepted"}] + \
             [{"id": m["id"], "name": m["name"], "role": "member", "status": m["status"],
               **({"email": m["email"], "offersLocation": m["offersLocation"], "acceptedWithLocation": m["withLocation"],
                   "respondedAt": m["respondedAt"]} if role == "owner" else {})}
              for m in repo.trip_members(owner_id, tid) if role == "owner" or m["status"] == "accepted"]
    me = user["id"]
    for p in people:
        p["me"] = p["id"] == me
        # each person decides who sees their location: I see whether I show mine to them and whether they show theirs to me
        p["seesMyLocation"] = not p["me"] and (me, p["id"]) in grants
        p["sharesWithMe"] = not p["me"] and (p["id"], me) in grants
        p["sharingLocation"] = any(u == me for u, _ in grants) if p["me"] else p["sharesWithMe"]
    return {"role": role, "members": people}


@router.post("/{tid}/members", status_code=201)
async def add_member(request: Request, tid: str, user: dict = Depends(require_user)):
    repo = request.app.state.repo
    _trip(request, user["id"], tid)
    if not request.app.state.trip_invites.take(user["id"]):
        raise HTTPException(429, "Dodano już wiele osób. Spróbuj ponownie za godzinę.")
    body = await request.json()
    body = body if isinstance(body, dict) else {}
    if body.get("userId"):
        # a person picked from the suggestions
        friend = repo.user_by_id(_uuid(str(body["userId"])))
    else:
        try:
            email = normalize_email(body.get("email"))
        except ValueError as error:
            raise HTTPException(400, str(error))
        friend = repo.user_by_email(email)
    if not friend:
        raise HTTPException(404, "Nie ma konta z tym adresem e-mail. Poproś tę osobę, aby założyła konto w aplikacji.")
    if friend["id"] == user["id"]:
        raise HTTPException(400, "To Twoja podróż.")
    current = [m for m in repo.trip_members(user["id"], tid) if m["status"] != "declined" and m["id"] != friend["id"]]
    if len(current) >= MAX_MEMBERS:
        raise HTTPException(400, f"Podróż można udostępnić najwyżej {MAX_MEMBERS} osobom.")
    # "share with my location": the owner will show THEIR OWN location to this person once they accept (nobody else's)
    with_location = body.get("withLocation") is True
    status = repo.add_member(user["id"], tid, friend["id"], with_location)
    if status == "accepted" and with_location:
        _grant(request, user["id"], tid, user["id"], friend["id"], True)
    return {"member": {"id": friend["id"], "name": friend["displayName"], "email": friend["email"], "role": "member", "status": status,
                       "offersLocation": with_location, "seesMyLocation": status == "accepted" and with_location}}


@router.delete("/{owner_id}/{tid}/members/{member_id}")
def remove_member(request: Request, owner_id: str, tid: str, member_id: str, user: dict = Depends(require_user)):
    role = _role(request, user, owner_id, tid)
    member_id = _uuid(member_id)
    if role != "owner" and member_id != user["id"]:
        raise HTTPException(403, "Możesz usunąć z podróży tylko siebie.")
    request.app.state.repo.remove_member(_uuid(owner_id), tid, member_id)
    return {"removed": True}


def _participants(request: Request, owner_id: str, tid: str) -> list[str]:
    return [owner_id] + [m["id"] for m in request.app.state.repo.trip_members(owner_id, tid) if m["status"] == "accepted"]


def _grant(request: Request, owner_id: str, tid: str, user_id: str, viewer_id: str | None, enabled: bool) -> dict:
    """Change who sees MY (user_id) location: one person (viewer_id) or everyone on the trip (viewer_id=None).
    Sending positions is on while at least one person may see them; with nobody left the last position is forgotten."""
    repo = request.app.state.repo
    until = _trip_end(_trip(request, owner_id, tid))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if enabled and until <= now:
        raise HTTPException(400, "Ta podróż już się skończyła.")
    others = [p for p in _participants(request, owner_id, tid) if p != user_id]
    if viewer_id is None:
        if enabled:
            for p in others:
                repo.set_location_grant(owner_id, tid, user_id, p, True)
        else:
            repo.clear_location_grants(owner_id, tid, user_id)
    else:
        if viewer_id not in others:
            raise HTTPException(404, "Tej osoby nie ma w podróży.")
        repo.set_location_grant(owner_id, tid, user_id, viewer_id, enabled)
    viewers = [v for u, v in repo.location_grants(owner_id, tid) if u == user_id]
    sharing_until = min(until, now + timedelta(days=30)) if viewers else None
    repo.location_sharing(owner_id, tid, user_id, sharing_until)
    return {"sharing": bool(viewers), "viewers": viewers, "until": (sharing_until.isoformat() + "Z") if sharing_until else None}


@router.put("/{owner_id}/{tid}/location-sharing")
async def location_sharing(request: Request, owner_id: str, tid: str, user: dict = Depends(require_user)):
    """Show or hide MY location for this trip (only ever for the caller): to one participant ({viewerId, enabled})
    or to everyone on the trip ({enabled})."""
    _role(request, user, owner_id, tid)
    owner_id = _uuid(owner_id)
    body = await request.json()
    body = body if isinstance(body, dict) else {}
    viewer = _uuid(str(body["viewerId"])) if body.get("viewerId") else None
    return _grant(request, owner_id, tid, user["id"], viewer, body.get("enabled") is True)


@router.put("/{owner_id}/{tid}/location")
async def save_location(request: Request, owner_id: str, tid: str, user: dict = Depends(require_user)):
    _role(request, user, owner_id, tid)
    if not request.app.state.trip_positions.take(user["id"]):
        raise HTTPException(429, "Za często. Lokalizacja wysyłana jest co minutę.")
    body = await request.json()
    try:
        lat, lon = float(body.get("lat")), float(body.get("lon"))
    except (TypeError, ValueError, AttributeError):
        raise HTTPException(400, "Nieprawidłowe położenie.")
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "Nieprawidłowe położenie.")
    accuracy = body.get("accuracy")
    accuracy = int(min(max(float(accuracy), 0), 100000)) if isinstance(accuracy, (int, float)) and math.isfinite(accuracy) else None
    if not request.app.state.repo.save_location(_uuid(owner_id), tid, user["id"], round(lat, 6), round(lon, 6), accuracy):
        raise HTTPException(409, "Udostępnianie lokalizacji jest wyłączone.")
    return {"saved": True}


@router.get("/{owner_id}/{tid}/locations")
def locations(request: Request, owner_id: str, tid: str, user: dict = Depends(require_user)):
    _role(request, user, owner_id, tid)
    owner_id = _uuid(owner_id)
    limit = datetime.now(timezone.utc) - timedelta(hours=FRESH_HOURS)
    allowed = {u for u, v in request.app.state.repo.location_grants(owner_id, tid) if v == user["id"]} | {user["id"]}
    out = []
    for x in request.app.state.repo.locations(owner_id, tid):
        if x["userId"] not in allowed:
            continue  # this person has not chosen to show their location to me
        fresh = x["at"] and datetime.fromisoformat(x["at"].replace("Z", "+00:00")) >= limit
        out.append({**x, **({} if fresh else {"lat": None, "lon": None, "accuracy": None}), "me": x["userId"] == user["id"]})
    return {"locations": out}
