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
    def create_session(self, user_id: str, session_hash: str, ttl: int) -> None: ...
    def delete_session(self, session_hash: str) -> None: ...
    def local_login(self, email: str) -> tuple[dict, str] | None: ...
    def save_oauth_state(self, state_hash: str, verifier: str, return_to: str, ttl: int) -> None: ...
    def consume_oauth_state(self, state_hash: str) -> dict | None: ...
    def google_user(self, subject: str, email: str, name: str, is_admin: bool) -> dict: ...
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
    def __init__(self, db: Database):
        self.db = db

    def user_by_session(self, session_hash: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute(
                """SELECT u.user_id, u.email, u.display_name, u.is_admin FROM dbo.AuthSession s
                   INNER JOIN dbo.AppUser u ON u.user_id = s.user_id
                   WHERE s.session_hash = ? AND s.expires_at > SYSUTCDATETIME();""", session_hash).fetchone()
            return _user(row) if row else None

    def create_session(self, user_id: str, session_hash: str, ttl: int) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """DELETE FROM dbo.AuthSession WHERE expires_at < SYSUTCDATETIME();
                   INSERT INTO dbo.AuthSession (session_hash, user_id, expires_at) VALUES (?, ?, ?);""",
                session_hash, user_id, _utc(ttl))

    def delete_session(self, session_hash: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute("DELETE FROM dbo.AuthSession WHERE session_hash = ?;", session_hash)

    def local_login(self, email: str) -> tuple[dict, str] | None:
        with self.db.connection() as c:
            row = c.cursor().execute(
                """SELECT u.user_id, u.email, u.display_name, u.is_admin, c.password_hash FROM dbo.AppUser u
                   INNER JOIN dbo.LocalCredential c ON c.user_id = u.user_id WHERE u.email = ?;""", email).fetchone()
            return (_user(row), row.password_hash) if row else None

    def save_oauth_state(self, state_hash: str, verifier: str, return_to: str, ttl: int) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """DELETE FROM dbo.OAuthState WHERE expires_at < SYSUTCDATETIME();
                   INSERT INTO dbo.OAuthState (state_hash, provider, code_verifier, return_to, expires_at) VALUES (?, N'google', ?, ?, ?);""",
                state_hash, verifier, return_to, _utc(ttl))

    def consume_oauth_state(self, state_hash: str) -> dict | None:
        with self.db.connection() as c:
            row = c.cursor().execute(
                """DELETE FROM dbo.OAuthState OUTPUT deleted.code_verifier, deleted.return_to
                   WHERE state_hash = ? AND expires_at > SYSUTCDATETIME();""", state_hash).fetchone()
            return {"codeVerifier": row.code_verifier, "returnTo": row.return_to} if row else None

    def google_user(self, subject: str, email: str, name: str, is_admin: bool) -> dict:
        """The app user linked to this Google account; a new one on first sign-in. App user ids stay independent of Google."""
        find = """SELECT u.user_id, u.email, u.display_name, u.is_admin FROM dbo.ExternalIdentity i
                  INNER JOIN dbo.AppUser u ON u.user_id = i.user_id WHERE i.provider = N'google' AND i.provider_subject = ?;"""
        with self.db.connection() as c:
            row = c.cursor().execute(find, subject).fetchone()
            if row:
                return _user(row)
        try:
            with self.db.connection() as c:
                cur = c.cursor()
                if cur.execute("SELECT 1 FROM dbo.AppUser WITH (UPDLOCK, HOLDLOCK) WHERE email = ?;", email).fetchone():
                    raise Conflict()
                user_id = str(uuid.uuid4())
                cur.execute("INSERT INTO dbo.AppUser (user_id, email, display_name, is_admin) VALUES (?, ?, ?, ?);",
                            user_id, email, name, 1 if is_admin else 0)
                cur.execute("INSERT INTO dbo.ExternalIdentity (provider, provider_subject, user_id) VALUES (N'google', ?, ?);", subject, user_id)
                return {"id": user_id, "email": email, "displayName": name, "isAdmin": is_admin}
        except Conflict:
            raise
        except Exception as error:  # two first sign-ins at once: the other one created the link
            if "2601" in str(error) or "2627" in str(error):
                with self.db.connection() as c:
                    row = c.cursor().execute(find, subject).fetchone()
                    if row:
                        return _user(row)
                raise Conflict() from error
            raise

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
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT u.user_id, u.email, u.display_name FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.member_user_id
                   WHERE s.owner_user_id = ? AND s.trip_id = ? ORDER BY s.created_at;""", owner_id, trip_id).fetchall()
            return [{"id": str(r.user_id).lower(), "email": r.email, "name": r.display_name} for r in rows]

    def add_member(self, owner_id: str, trip_id: str, member_id: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """IF NOT EXISTS (SELECT 1 FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?)
                   INSERT INTO dbo.TripShare (owner_user_id, trip_id, member_user_id) VALUES (?, ?, ?);""",
                owner_id, trip_id, member_id, owner_id, trip_id, member_id)

    def remove_member(self, owner_id: str, trip_id: str, member_id: str) -> None:
        with self.db.connection() as c:
            c.cursor().execute(
                """DELETE FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?;
                   DELETE FROM dbo.TripLocation WHERE owner_user_id = ? AND trip_id = ? AND user_id = ?;""",
                owner_id, trip_id, member_id, owner_id, trip_id, member_id)

    def is_member(self, owner_id: str, trip_id: str, user_id: str) -> bool:
        with self.db.connection() as c:
            return c.cursor().execute("SELECT 1 FROM dbo.TripShare WHERE owner_user_id = ? AND trip_id = ? AND member_user_id = ?;",
                                      owner_id, trip_id, user_id).fetchone() is not None

    def shared_with(self, member_id: str) -> list[dict]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.owner_user_id, s.trip_id, u.display_name FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.owner_user_id
                   WHERE s.member_user_id = ? ORDER BY s.created_at;""", member_id).fetchall()
            return [{"ownerId": str(r.owner_user_id).lower(), "tid": r.trip_id, "ownerName": r.display_name} for r in rows]

    def my_shares(self, owner_id: str) -> dict[str, list[str]]:
        with self.db.connection() as c:
            rows = c.cursor().execute(
                """SELECT s.trip_id, u.display_name FROM dbo.TripShare s INNER JOIN dbo.AppUser u ON u.user_id = s.member_user_id
                   WHERE s.owner_user_id = ? ORDER BY s.created_at;""", owner_id).fetchall()
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
