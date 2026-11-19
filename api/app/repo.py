"""Data access for the endpoints FastAPI owns. Same tables as the Node server, so both can run side by side."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

from .db import Database


class Conflict(Exception):
    """An account with this e-mail already exists under another sign-in method."""


def _user(row: Any) -> dict:
    return {"id": str(row.user_id).lower(), "email": row.email, "displayName": row.display_name, "isAdmin": bool(row.is_admin)}


def _utc(seconds: int) -> datetime:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).replace(tzinfo=None)


class Repository(Protocol):  # what the routes need; tests provide an in-memory version
    def user_by_session(self, session_hash: str) -> dict | None: ...
    def favorites(self, user_id: str) -> list: ...
    def save_favorites(self, user_id: str, favorites: list) -> None: ...
    def preferences(self, user_id: str) -> dict: ...
    def save_preferences(self, user_id: str, preferences: dict) -> None: ...
    def create_photo(self, photo: dict) -> None: ...
    def photo(self, user_id: str, photo_id: str) -> dict | None: ...
    def photo_progress(self, photo_id: str, received: int) -> None: ...
    def photo_ready(self, photo_id: str, sha256: str) -> None: ...
    def photos(self, user_id: str, trip_id: str) -> list[dict]: ...
    def delete_photo(self, user_id: str, photo_id: str) -> dict | None: ...


PHOTO_COLUMNS = "photo_id, user_id, trip_id, storage_path, content_type, size_bytes, received_bytes, sha256, status, caption, taken_at, created_at"


def _photo(row: Any) -> dict:
    return {
        "id": str(row.photo_id).lower(), "userId": str(row.user_id).lower(), "tripId": row.trip_id, "path": row.storage_path,
        "contentType": row.content_type, "size": int(row.size_bytes), "received": int(row.received_bytes), "sha256": row.sha256,
        "status": row.status, "caption": row.caption or "", "takenAt": row.taken_at.isoformat() + "Z" if row.taken_at else None,
        "createdAt": row.created_at.isoformat() + "Z" if row.created_at else None,
    }


class SqlRepository:
    def __init__(self, db: Database, mdm: Database | None = None):
        self.db, self.mdm = db, mdm

    def user_by_session(self, session_hash: str) -> dict | None:
        """Sessions are the Podavo family's (podavo-mdm, made by the Node server's sign-in); the person is this app's
        member row with the account's GUID as user_id (Node keeps it current at every sign-in)."""
        try:
            key = bytes.fromhex(session_hash)
        except ValueError:
            return None
        with self.mdm.connection() as c:
            found = c.cursor().execute(
                """SELECT a.AccountGuid, a.Email, a.Name FROM mdm.Session s JOIN mdm.Account a ON a.AccountId = s.AccountId
                   WHERE s.TokenHash = ? AND s.AppCode = 'voyage' AND s.ExpiresAt > SYSUTCDATETIME();""", key).fetchone()
        if not found:
            return None
        with self.db.connection() as c:
            row = c.cursor().execute("SELECT user_id, email, display_name, is_admin FROM dbo.AppUser WHERE user_id = ?;", found.AccountGuid).fetchone()
        return _user(row) if row else {"id": str(found.AccountGuid).lower(), "email": found.Email, "displayName": found.Name, "isAdmin": False}

    def _json(self, table: str, column: str, user_id: str, default: Any) -> Any:
        with self.db.connection() as c:
            row = c.cursor().execute(f"SELECT {column} FROM dbo.{table} WHERE user_id = ?;", user_id).fetchone()
            return json.loads(row[0]) if row else default

    def _save_json(self, table: str, column: str, user_id: str, value: Any) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                f"""SET XACT_ABORT ON;
                    UPDATE dbo.{table} WITH (UPDLOCK, SERIALIZABLE) SET {column} = ?, updated_at = SYSUTCDATETIME() WHERE user_id = ?;
                    IF @@ROWCOUNT = 0 INSERT INTO dbo.{table} (user_id, {column}) VALUES (?, ?);""",
                json.dumps(value, ensure_ascii=False), user_id, user_id, json.dumps(value, ensure_ascii=False))

    def favorites(self, user_id: str) -> list:
        return self._json("UserFavorites", "favorites", user_id, [])

    def save_favorites(self, user_id: str, favorites: list) -> None:
        self._save_json("UserFavorites", "favorites", user_id, favorites)

    def preferences(self, user_id: str) -> dict:
        return self._json("UserPreference", "preferences", user_id, {})

    def save_preferences(self, user_id: str, preferences: dict) -> None:
        self._save_json("UserPreference", "preferences", user_id, preferences)

    def create_photo(self, photo: dict) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """INSERT INTO dbo.TripPhoto (photo_id, user_id, trip_id, storage_path, content_type, size_bytes, received_bytes, status, caption, taken_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 'uploading', ?, ?);""",
                photo["id"], photo["userId"], photo["tripId"], photo["path"], photo["contentType"], photo["size"], photo["caption"] or None,
                photo["takenAt"])

    def photo(self, user_id: str, photo_id: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute(f"SELECT {PHOTO_COLUMNS} FROM dbo.TripPhoto WHERE photo_id = ? AND user_id = ?;", photo_id, user_id).fetchone()
            return _photo(row) if row else None

    def photo_progress(self, photo_id: str, received: int) -> None:
        with self.db.connection() as c:
            c.cursor().execute("UPDATE dbo.TripPhoto SET received_bytes = ? WHERE photo_id = ?;", received, photo_id)

    def photo_ready(self, photo_id: str, sha256: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute("UPDATE dbo.TripPhoto SET status = 'ready', sha256 = ?, completed_at = SYSUTCDATETIME() WHERE photo_id = ?;", sha256, photo_id)

    def photos(self, user_id: str, trip_id: str) -> list[dict]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                f"SELECT {PHOTO_COLUMNS} FROM dbo.TripPhoto WHERE user_id = ? AND trip_id = ? ORDER BY COALESCE(taken_at, created_at);", user_id, trip_id).fetchall()
            return [_photo(r) for r in rows]

    def delete_photo(self, user_id: str, photo_id: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute(
                f"DELETE FROM dbo.TripPhoto OUTPUT {', '.join('deleted.' + x.strip() for x in PHOTO_COLUMNS.split(','))} WHERE photo_id = ? AND user_id = ?;",
                photo_id, user_id).fetchone()
            return _photo(row) if row else None

    # ---------- shared trips and participants' locations ----------

    def user_by_id(self, user_id: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute("SELECT user_id, email, display_name, is_admin FROM dbo.AppUser WHERE user_id = ?;", user_id).fetchone()
            return _user(row) if row else None

    def people_search(self, user_id: str, q: str, limit: int = 6) -> list[dict]:
        """People to share a trip with: those I already share trips with (by name or e-mail), and, from 3 characters,
        other accounts whose e-mail starts with what was typed. Nobody can list accounts by name alone."""
        like = q.replace("[", "[[]").replace("%", "[%]").replace("_", "[_]")
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """WITH contacts AS (
                       SELECT member_user_id AS uid FROM dbo.TripShare WHERE owner_user_id = ?
                       UNION SELECT owner_user_id FROM dbo.TripShare WHERE member_user_id = ?)
                   SELECT TOP (?) u.user_id, u.email, u.display_name, CASE WHEN c.uid IS NULL THEN 0 ELSE 1 END AS contact
                   FROM dbo.AppUser u LEFT JOIN contacts c ON c.uid = u.user_id
                   WHERE u.user_id <> ? AND (
                         (c.uid IS NOT NULL AND (u.display_name LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?))
                      OR (? >= 3 AND u.email LIKE ?))
                   ORDER BY contact DESC, u.display_name;""",
                user_id, user_id, limit, user_id, like + "%", "% " + like + "%", like + "%", len(q), like + "%").fetchall()
            return [{"id": str(r.user_id).lower(), "email": r.email, "name": r.display_name, "contact": bool(r.contact)} for r in rows]

    def user_by_email(self, email: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute("SELECT user_id, email, display_name, is_admin FROM dbo.AppUser WHERE email = ?;", email).fetchone()
            return _user(row) if row else None

    def trip_members(self, owner_id: str, trip_id: str) -> list[dict]:
        """Everyone the trip was shared with, with the state of the invitation (pending, accepted, declined)."""
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT u.user_id, u.email, u.display_name, s.status, s.owner_location, s.member_location, s.responded_at
                   FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.member_user_id
                   WHERE s.owner_user_id = ? AND s.trip_id = ? ORDER BY s.created_at;""", owner_id, trip_id).fetchall()
            return [{"id": str(r.user_id).lower(), "email": r.email, "name": r.display_name, "status": r.status,
                     "offersLocation": bool(r.owner_location), "withLocation": bool(r.member_location),
                     "respondedAt": r.responded_at.isoformat() + "Z" if r.responded_at else None} for r in rows]

    def add_member(self, owner_id: str, trip_id: str, member_id: str, offer_location: bool = False) -> str:
        """Invite a person (pending until they accept). A declined invitation can be sent again; an accepted one stays."""
        with self.db.connection() as c:
            row = c.cursor().execute(
                """SET NOCOUNT ON; SET XACT_ABORT ON;
                   UPDATE dbo.TripShare WITH (UPDLOCK, SERIALIZABLE)
                     SET owner_location = ?, status = CASE WHEN status = 'accepted' THEN status ELSE 'pending' END,
                         responded_at = CASE WHEN status = 'accepted' THEN responded_at END,
                         member_location = CASE WHEN status = 'accepted' THEN member_location ELSE 0 END
                     WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?;
                   IF @@ROWCOUNT = 0 INSERT INTO dbo.TripShare (owner_user_id, trip_id, member_user_id, status, owner_location) VALUES (?, ?, ?, 'pending', ?);
                   SELECT status FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?;""",
                1 if offer_location else 0, owner_id, trip_id, member_id, owner_id, trip_id, member_id, 1 if offer_location else 0,
                owner_id, trip_id, member_id).fetchone()
            return row.status if row else "pending"

    def invites(self, member_id: str) -> list[dict]:
        """Trips shared with me that I have not answered yet."""
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.owner_user_id, s.trip_id, s.owner_location, s.created_at, u.display_name FROM dbo.TripShare s
                   INNER JOIN dbo.AppUser u ON u.user_id = s.owner_user_id
                   WHERE s.member_user_id = ? AND s.status = 'pending' ORDER BY s.created_at DESC;""", member_id).fetchall()
            return [{"ownerId": str(r.owner_user_id).lower(), "tid": r.trip_id, "ownerName": r.display_name,
                     "offersLocation": bool(r.owner_location), "at": r.created_at.isoformat() + "Z"} for r in rows]

    def respond_invite(self, owner_id: str, trip_id: str, member_id: str, accept: bool, with_location: bool) -> dict | None:
        """Accept or decline a pending invitation; None when there is none. Says whether the owner offered their location."""
        with self.db.connection() as c:
            row = c.cursor().execute(
                """UPDATE dbo.TripShare SET status = ?, member_location = ?, responded_at = SYSUTCDATETIME()
                   OUTPUT inserted.owner_location
                   WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ? AND status = 'pending';""",
                "accepted" if accept else "declined", 1 if accept and with_location else 0, owner_id, trip_id, member_id).fetchone()
            return {"offersLocation": bool(row.owner_location)} if row else None

    def responses(self, owner_id: str, days: int = 14) -> list[dict]:
        """Recent answers to my invitations, for the organiser's notifications."""
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.trip_id, s.member_user_id, u.display_name, s.status, s.owner_location, s.member_location, s.responded_at
                   FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.member_user_id
                   WHERE s.owner_user_id = ? AND s.responded_at > DATEADD(day, -?, SYSUTCDATETIME()) ORDER BY s.responded_at DESC;""",
                owner_id, days).fetchall()
            return [{"tid": r.trip_id, "memberId": str(r.member_user_id).lower(), "memberName": r.display_name, "status": r.status,
                     "offersLocation": bool(r.owner_location), "withLocation": bool(r.member_location),
                     "at": r.responded_at.isoformat() + "Z"} for r in rows]

    def remove_member(self, owner_id: str, trip_id: str, member_id: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """DELETE FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?;
                   DELETE FROM dbo.TripLocation WHERE owner_user_id = ? AND trip_id = ? AND user_id = ?;
                   DELETE FROM dbo.TripLocationViewer WHERE owner_user_id = ? AND trip_id = ? AND (user_id = ? OR viewer_user_id = ?);""",
                owner_id, trip_id, member_id, owner_id, trip_id, member_id, owner_id, trip_id, member_id, member_id)

    def location_grants(self, owner_id: str, trip_id: str) -> list[tuple[str, str]]:
        """(person sharing, person allowed to see) pairs of this trip."""
        with self.db.connection() as c:
            rows = c.cursor().execute("SELECT user_id, viewer_user_id FROM dbo.TripLocationViewer WHERE owner_user_id = ? AND trip_id = ?;",
                                      owner_id, trip_id).fetchall()
            return [(str(r.user_id).lower(), str(r.viewer_user_id).lower()) for r in rows]

    def set_location_grant(self, owner_id: str, trip_id: str, user_id: str, viewer_id: str, enabled: bool) -> None:
        with self.db.connection() as c:
            if enabled:
                c.cursor().execute(
                    """IF NOT EXISTS (SELECT 1 FROM dbo.TripLocationViewer WHERE owner_user_id = ? AND trip_id = ? AND user_id = ? AND viewer_user_id = ?)
                       INSERT INTO dbo.TripLocationViewer (owner_user_id, trip_id, user_id, viewer_user_id) VALUES (?, ?, ?, ?);""",
                    owner_id, trip_id, user_id, viewer_id, owner_id, trip_id, user_id, viewer_id)
            else:
                c.cursor().execute("DELETE FROM dbo.TripLocationViewer WHERE owner_user_id = ? AND trip_id = ? AND user_id = ? AND viewer_user_id = ?;",
                                   owner_id, trip_id, user_id, viewer_id)

    def clear_location_grants(self, owner_id: str, trip_id: str, user_id: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute("DELETE FROM dbo.TripLocationViewer WHERE owner_user_id = ? AND trip_id = ? AND user_id = ?;", owner_id, trip_id, user_id)

    def is_member(self, owner_id: str, trip_id: str, user_id: str) -> bool:
        with self.db.connection() as c:
            return c.cursor().execute("SELECT 1 FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ? AND status = 'accepted';",
                                      owner_id, trip_id, user_id).fetchone() is not None

    def shared_with(self, member_id: str) -> list[dict]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.owner_user_id, s.trip_id, u.display_name FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.owner_user_id
                   WHERE s.member_user_id = ? AND s.status = 'accepted' ORDER BY s.created_at;""", member_id).fetchall()
            return [{"ownerId": str(r.owner_user_id).lower(), "tid": r.trip_id, "ownerName": r.display_name} for r in rows]

    def my_shares(self, owner_id: str) -> dict[str, list[str]]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.trip_id, u.display_name FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.member_user_id
                   WHERE s.owner_user_id = ? AND s.status <> 'declined' ORDER BY s.created_at;""", owner_id).fetchall()
            out: dict[str, list[str]] = {}
            for r in rows:
                out.setdefault(r.trip_id, []).append(r.display_name)
            return out

    def location_sharing(self, owner_id: str, trip_id: str, user_id: str, until) -> None:
        """until=None stops sharing and forgets the last position."""
        with self.db.connection() as c:
            c.cursor().execute(
                """SET XACT_ABORT ON;
                   UPDATE dbo.TripLocation WITH (UPDLOCK, SERIALIZABLE)
                     SET sharing = ?, until = ?, lat = CASE WHEN ? = 1 THEN lat END, lon = CASE WHEN ? = 1 THEN lon END,
                         accuracy_m = CASE WHEN ? = 1 THEN accuracy_m END, recorded_at = CASE WHEN ? = 1 THEN recorded_at END
                     WHERE owner_user_id = ? AND trip_id = ? AND user_id = ?;
                   IF @@ROWCOUNT = 0 INSERT INTO dbo.TripLocation (owner_user_id, trip_id, user_id, sharing, until) VALUES (?, ?, ?, ?, ?);""",
                *([1 if until else 0, until] + [1 if until else 0] * 4 + [owner_id, trip_id, user_id, owner_id, trip_id, user_id, 1 if until else 0, until]))

    def save_location(self, owner_id: str, trip_id: str, user_id: str, lat: float, lon: float, accuracy) -> bool:
        with self.db.connection() as c:
            cur = c.cursor().execute(
                """UPDATE dbo.TripLocation SET lat = ?, lon = ?, accuracy_m = ?, recorded_at = SYSUTCDATETIME()
                   WHERE owner_user_id = ? AND trip_id = ? AND user_id = ? AND sharing = 1 AND until > SYSUTCDATETIME();""",
                lat, lon, accuracy, owner_id, trip_id, user_id)
            return cur.rowcount > 0

    def locations(self, owner_id: str, trip_id: str) -> list[dict]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT l.user_id, u.display_name, l.sharing, l.until, l.lat, l.lon, l.accuracy_m, l.recorded_at
                   FROM dbo.TripLocation l INNER JOIN dbo.AppUser u ON u.user_id = l.user_id
                   WHERE l.owner_user_id = ? AND l.trip_id = ? AND l.sharing = 1 AND l.until > SYSUTCDATETIME();""", owner_id, trip_id).fetchall()
            iso = lambda d: d.isoformat() + "Z" if d else None  # noqa: E731
            return [{"userId": str(r.user_id).lower(), "name": r.display_name, "until": iso(r.until),
                     "lat": float(r.lat) if r.lat is not None else None, "lon": float(r.lon) if r.lon is not None else None,
                     "accuracy": r.accuracy_m, "at": iso(r.recorded_at)} for r in rows]
