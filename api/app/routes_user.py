"""The signed-in user's own data: favourites (incl. saved trips), preferences and trip photos.

Authorization is always server-side: every query is filtered by the session's user id, and a photo can only be
attached to a trip that is in that user's own saved trips.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from .deps import require_user
from .favorites import normalize_favorites

router = APIRouter(prefix="/api")
MAX_FAVORITES_BYTES = 512 * 1024
MAX_PREFERENCES_BYTES = 64 * 1024
TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif"}


async def _json(request: Request, limit: int):
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(413, "Za dużo danych.")
    try:
        return json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "Nieprawidłowe dane.")


@router.get("/favorites")
def get_favorites(request: Request, user: dict = Depends(require_user)):
    return {"favorites": request.app.state.repo.favorites(user["id"])}


@router.put("/favorites")
async def put_favorites(request: Request, user: dict = Depends(require_user)):
    body = await _json(request, MAX_FAVORITES_BYTES)
    saved = normalize_favorites(body.get("favorites") if isinstance(body, dict) else None)
    request.app.state.repo.save_favorites(user["id"], saved)
    return {"favorites": saved}


@router.get("/preferences")
def get_preferences(request: Request, user: dict = Depends(require_user)):
    return {"preferences": request.app.state.repo.preferences(user["id"])}


@router.put("/preferences")
async def put_preferences(request: Request, user: dict = Depends(require_user)):
    body = await _json(request, MAX_PREFERENCES_BYTES)
    preferences = body.get("preferences", {}) if isinstance(body, dict) else None
    if not isinstance(preferences, dict):
        raise HTTPException(400, "Nieprawidłowe ustawienia.")
    request.app.state.repo.save_preferences(user["id"], preferences)
    return {"saved": True}


# ---------- photos ----------

def _public_photo(photo: dict) -> dict:
    return {k: photo[k] for k in ("id", "tripId", "contentType", "size", "received", "status", "caption", "takenAt", "createdAt")}


def _signature_ok(content_type: str, head: bytes) -> bool:
    """The first bytes must really be the declared image type, so nothing else can be stored as a photo."""
    if content_type == "image/jpeg":
        return head[:3] == b"\xff\xd8\xff"
    if content_type == "image/png":
        return head[:8] == b"\x89PNG\r\n\x1a\n"
    if content_type == "image/webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return head[4:8] == b"ftyp"  # HEIC/HEIF (ISO base media)


def _owned(request: Request, user: dict, photo_id: str) -> dict:
    try:
        photo_id = str(uuid.UUID(photo_id))
    except ValueError:
        raise HTTPException(404, "Nie znaleziono zdjęcia.")
    photo = request.app.state.repo.photo(user["id"], photo_id)
    if not photo:
        raise HTTPException(404, "Nie znaleziono zdjęcia.")
    return photo


def _slug(name: str) -> str:
    """A trip name as a folder name: Polish letters without accents, lower case, words joined with "-" (max 60)."""
    name = name.replace("ł", "l").replace("Ł", "L")
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:60].strip("-")


def trip_folder(trip: dict) -> str:
    """The trip's folder in photo storage: its name plus the trip id, so two trips with the same name never share a
    folder (e.g. "weekend-w-krakowie-k3x9a1b2c4d5"). The name is the traveller's own title, else "from-to"."""
    name = trip.get("title") or f"{trip.get('from', '')} {trip.get('to', '')}"
    slug = _slug(name)
    return f"{slug}-{trip['tid']}" if slug else trip["tid"]


@router.post("/photos", status_code=201)
async def start_photo(request: Request, user: dict = Depends(require_user)):
    settings, repo = request.app.state.settings, request.app.state.repo
    body = await _json(request, 8 * 1024)
    trip_id, content_type, size = body.get("tripId"), body.get("contentType"), body.get("size")
    trip = next((f for f in repo.favorites(user["id"]) if f.get("type") == "trip" and f.get("tid") == trip_id), None) if isinstance(trip_id, str) else None
    if not trip:
        raise HTTPException(404, {"error": "Nie znaleziono tej podróży.", "code": "trip-not-found"})
    if content_type not in TYPES:
        raise HTTPException(415, "Dozwolone są zdjęcia JPEG, PNG, WebP i HEIC.")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= settings.photo_max_bytes:
        raise HTTPException(413, f"Zdjęcie może mieć najwyżej {settings.photo_max_bytes // (1024 * 1024)} MB.")
    taken = body.get("takenAt")
    try:
        taken_at = datetime.fromisoformat(str(taken).replace("Z", "+00:00")).replace(tzinfo=None) if taken else None
    except ValueError:
        taken_at = None
    photo_id = str(uuid.uuid4())
    # trip-photos/<user>/<trip name>-<trip id>/<day>_<photo>.<ext>. A renamed trip keeps the folder its first photo
    # went to, so all photos of one trip stay together.
    earlier = [p for p in repo.photos(user["id"], trip_id) if p.get("path")]
    kept = earlier[0]["path"].split("/")[1] if earlier and earlier[0]["path"].count("/") >= 2 else ""
    folder = kept if kept and kept != trip_id else trip_folder(trip)  # photos from before names were used sat in "<trip id>"
    day = taken_at.strftime("%Y-%m-%d") + "_" if taken_at else ""
    photo = {"id": photo_id, "userId": user["id"], "tripId": trip_id, "path": f"{user['id']}/{folder}/{day}{photo_id}.{TYPES[content_type]}",
             "contentType": content_type, "size": size, "caption": str(body.get("caption") or "").strip()[:200], "takenAt": taken_at}
    request.app.state.storage.create(photo["path"])
    repo.create_photo(photo)
    return {"photo": _public_photo({**photo, "received": 0, "status": "uploading", "takenAt": taken, "createdAt": None}),
            "chunkSize": settings.photo_chunk_bytes}


@router.get("/photos")
def list_photos(request: Request, tripId: str, user: dict = Depends(require_user)):
    return {"photos": [_public_photo(p) for p in request.app.state.repo.photos(user["id"], tripId[:24])]}


@router.get("/photos/{photo_id}")
def photo_status(request: Request, photo_id: str, user: dict = Depends(require_user)):
    return {"photo": _public_photo(_owned(request, user, photo_id))}


@router.put("/photos/{photo_id}/content")
async def upload_chunk(request: Request, photo_id: str, user: dict = Depends(require_user)):
    """One chunk at the offset in Upload-Offset. A chunk at the wrong offset gets 409 with the offset to resume from."""
    settings, repo, storage = request.app.state.settings, request.app.state.repo, request.app.state.storage
    if not request.app.state.upload_chunks.take(user["id"]):
        raise HTTPException(429, "Zbyt wiele przesyłanych części. Spróbuj ponownie później.")
    photo = _owned(request, user, photo_id)
    if photo["status"] == "ready":
        return {"photo": _public_photo(photo)}
    declared = int(request.headers.get("content-length") or 0)
    if declared > settings.photo_chunk_bytes:
        raise HTTPException(413, "Za duża część pliku.")
    try:
        offset = int(request.headers.get("upload-offset", ""))
    except ValueError:
        raise HTTPException(400, "Brak nagłówka Upload-Offset.")
    if offset != photo["received"]:
        raise HTTPException(409, {"error": "Wznów od innego miejsca.", "received": photo["received"]})
    data = await request.body()
    if not data or len(data) > settings.photo_chunk_bytes or offset + len(data) > photo["size"]:
        raise HTTPException(400, "Nieprawidłowa część pliku.")
    if offset == 0 and not _signature_ok(photo["contentType"], data[:16]):
        raise HTTPException(415, "Plik nie jest zdjęciem zadeklarowanego typu.")
    storage.append(photo["path"], offset, data)
    received = offset + len(data)
    repo.photo_progress(photo["id"], received)
    if received == photo["size"]:
        storage.flush(photo["path"], received)
        digest = hashlib.sha256()
        for chunk in storage.read(photo["path"]):
            digest.update(chunk)
        repo.photo_ready(photo["id"], digest.hexdigest())
        photo = {**photo, "status": "ready"}
    return {"photo": _public_photo({**photo, "received": received})}


@router.get("/photos/{photo_id}/file")
def photo_file(request: Request, photo_id: str, user: dict = Depends(require_user)):
    photo = _owned(request, user, photo_id)
    if photo["status"] != "ready":
        raise HTTPException(409, "Zdjęcie nie zostało jeszcze przesłane.")
    return StreamingResponse(request.app.state.storage.read(photo["path"]), media_type=photo["contentType"], headers={
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline"})


@router.delete("/photos/{photo_id}")
def delete_photo(request: Request, photo_id: str, user: dict = Depends(require_user)):
    photo = _owned(request, user, photo_id)
    request.app.state.repo.delete_photo(user["id"], photo["id"])
    request.app.state.storage.delete(photo["path"])
    return {"deleted": True}
