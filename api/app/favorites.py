"""Favourites arrive from the client, so only known fields of known shapes are kept (port of src/favorites.js)."""
from __future__ import annotations

import json
import math
import re
from typing import Any

MAX_FAVORITES = 50
MAX_TEXT = 200
MAX_SNAPSHOT = 24000
VIEWS = {"ztm", "pks", "kolej", "podroz"}
IATA = re.compile(r"^[A-Z]{3}$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
AIRLINE = re.compile(r"^[A-Z0-9]{2,12}$")
KEY = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,23}$")
TID = re.compile(r"^[a-z0-9]{6,24}$")


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def text(value: Any) -> str:
    return value.strip()[:MAX_TEXT] if _is_str(value) else ""


def _match(pattern: re.Pattern, value: Any) -> bool:
    return _is_str(value) and bool(pattern.match(value))


def flight_of(value: Any) -> dict | None:
    if not isinstance(value, dict) or not _match(IATA, value.get("from")) or not _match(IATA, value.get("to")) or not _match(DAY, value.get("day")):
        return None
    flight = {"from": value["from"], "to": value["to"], "day": value["day"],
              "back": value["back"] if _match(DAY, value.get("back")) else "",
              "airline": value["airline"] if _match(AIRLINE, value.get("airline")) else ""}
    price = value.get("price")
    if _num(price) and 0 < price < 100000:
        flight["price"] = int(math.floor(price + 0.5))
    return flight


def plain(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value[:300]
    if depth >= 5:
        return None
    if isinstance(value, list):
        return [plain(v, depth + 1) for v in value[:20]]
    if isinstance(value, dict):
        return {k: plain(v, depth + 1) for k, v in list(value.items())[:40] if KEY.match(str(k))}
    return None


def snapshot_of(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    clean = plain(value)
    return clean if len(json.dumps(clean, ensure_ascii=False, separators=(",", ":"))) <= MAX_SNAPSHOT else None


def normalize_favorites(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[dict] = []
    for item in value:
        if not isinstance(item, dict) or item.get("view") not in VIEWS:
            continue
        kind, fav = item.get("type"), None
        if kind == "stop" and text(item.get("name")):
            fav = {"type": "stop", "view": item["view"], "name": text(item["name"])}
        if kind == "line" and text(item.get("id")) and text(item.get("name")):
            fav = {"type": "line", "view": item["view"], "id": text(item["id"]), "name": text(item["name"])}
        if kind == "route" and text(item.get("from")) and text(item.get("to")):
            fav = {"type": "route", "view": item["view"], "from": text(item["from"]), "to": text(item["to"])}
        if kind == "trip" and text(item.get("id")) and text(item.get("from")) and text(item.get("to")) and text(item.get("name")):
            fav = {"type": "trip", "view": "podroz", "id": text(item["id"]), "from": text(item["from"]), "to": text(item["to"]),
                   "name": text(item["name"]), "detail": text(item.get("detail"))}
            flight = flight_of(item.get("flight"))
            if flight:
                fav["flight"] = flight
            plan = item.get("plan")
            if isinstance(plan, dict) and text(plan.get("out")):
                fav["plan"] = {"out": text(plan.get("out")), "ret": text(plan.get("ret")), "access": text(plan.get("access")), "xfer": text(plan.get("xfer"))}
            if item.get("status") in ("booked", "planned"):
                fav["status"] = item["status"]
            if _match(TID, item.get("tid") or ""):
                fav["tid"] = item["tid"]
            trip = snapshot_of(item.get("trip"))
            if trip is not None:
                fav["trip"] = trip
        if not fav:
            continue
        key = json.dumps(fav, ensure_ascii=False, sort_keys=False)
        if key in seen:
            continue
        seen.add(key)
        out.append(fav)
        if len(out) == MAX_FAVORITES:
            break
    return out


def trip_ids(favorites: list[dict]) -> set[str]:
    """Saved trips of this user, for checking that a photo is attached to the user's own trip."""
    return {f["tid"] for f in favorites if f.get("type") == "trip" and f.get("tid")}
