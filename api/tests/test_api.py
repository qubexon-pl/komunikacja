import hashlib

from conftest import ORIGIN, U1, sign_in

WEB = {"Origin": ORIGIN}
NATIVE = {"Origin": "capacitor://localhost"}
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 5000


class _Signed:
    def __init__(self, data):
        self.status_code, self._data = 200, data

    def json(self):
        return self._data


def native_login(client, email="nowy@example.com"):
    return _Signed(sign_in(client, email))


def bearer(token):
    return {"Authorization": f"Bearer {token}", **NATIVE}


def test_sign_in_is_the_node_servers_and_a_podavo_session_is_accepted_here(client, node_calls):
    for path in ("/api/auth/login", "/api/auth/code", "/api/auth/google/native", "/api/auth/logout"):
        client.post(path, json={}, headers={**NATIVE, "X-Auth-Mode": "token"})
        assert node_calls[-1].url.path == path  # FastAPI has no sign-in of its own any more
    signed = sign_in(client, "ania@example.com")
    assert client.get("/api/favorites", headers=bearer(signed["token"])).status_code == 200
    assert client.get("/api/favorites", headers=bearer("x" * 43)).status_code == 401


def test_favorites_are_cleaned_and_private_to_the_user(client):
    token = native_login(client).json()["token"]
    assert client.get("/api/favorites").status_code == 401
    r = client.put("/api/favorites", json={"favorites": [{"type": "stop", "view": "ztm", "name": " Rejtana "}, {"type": "evil", "view": "x"}]},
                   headers=bearer(token))
    assert r.json() == {"favorites": [{"type": "stop", "view": "ztm", "name": "Rejtana"}]}
    assert client.get("/api/favorites", headers=bearer(token)).json()["favorites"][0]["name"] == "Rejtana"
    assert client.put("/api/preferences", json={"preferences": [1]}, headers=bearer(token)).status_code == 400
    assert client.put("/api/preferences", json={"preferences": {"exploreView": {"from": ["RZE"]}}}, headers=bearer(token)).json() == {"saved": True}


def test_cookie_sessions_need_the_app_origin_for_changes(client):
    client.cookies.set("rzbus_session", sign_in(client, "ania@example.com")["token"])
    assert client.put("/api/favorites", json={"favorites": []}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.put("/api/favorites", json={"favorites": []}, headers=WEB).status_code == 200


def _trip(client, token, tid="trip0001"):
    fav = [{"type": "trip", "view": "podroz", "id": "f:1", "from": "Rzeszów", "to": "Rzym", "name": "Lot", "tid": tid, "status": "booked"}]
    client.put("/api/favorites", json={"favorites": fav}, headers=bearer(token))


def test_photo_upload_resumes_after_an_interruption_and_is_private(client):
    token = native_login(client).json()["token"]
    _trip(client, token)
    assert client.post("/api/photos", json={"tripId": "someone-else", "contentType": "image/jpeg", "size": 10}, headers=bearer(token)).status_code == 404
    assert client.post("/api/photos", json={"tripId": "trip0001", "contentType": "image/gif", "size": 10}, headers=bearer(token)).status_code == 415
    start = client.post("/api/photos", json={"tripId": "trip0001", "contentType": "image/jpeg", "size": len(JPEG), "caption": "Koloseum"},
                        headers=bearer(token))
    assert start.status_code == 201
    pid = start.json()["photo"]["id"]
    put = lambda offset, data: client.put(f"/api/photos/{pid}/content", content=data,
                                          headers={**bearer(token), "Upload-Offset": str(offset), "Content-Type": "application/octet-stream"})
    assert put(0, JPEG[:2000]).json()["photo"]["received"] == 2000
    # the connection dropped; the app asks how far it got and continues from there
    assert client.get(f"/api/photos/{pid}", headers=bearer(token)).json()["photo"]["received"] == 2000
    stale = put(0, JPEG[:2000])
    assert stale.status_code == 409 and stale.json()["received"] == 2000
    done = put(2000, JPEG[2000:]).json()["photo"]
    assert done["status"] == "ready" and done["received"] == len(JPEG)
    assert client.repo.photos_[pid]["sha256"] == hashlib.sha256(JPEG).hexdigest()
    file = client.get(f"/api/photos/{pid}/file", headers=bearer(token))
    assert file.content == JPEG and file.headers["content-type"] == "image/jpeg" and "private" in file.headers["cache-control"]
    other = sign_in(client, "ania@example.com")["token"]
    assert client.get(f"/api/photos/{pid}/file", headers=bearer(other)).status_code == 404
    assert [p["id"] for p in client.get("/api/photos?tripId=trip0001", headers=bearer(token)).json()["photos"]] == [pid]
    assert client.delete(f"/api/photos/{pid}", headers=bearer(token)).json() == {"deleted": True}


def test_photos_are_stored_by_user_and_trip_id(client):
    token = native_login(client).json()["token"]
    _trip(client, token)
    pid = client.post("/api/photos", json={"tripId": "trip0001", "contentType": "image/jpeg", "size": 10}, headers=bearer(token)).json()["photo"]["id"]
    user_dir, trip_dir, name = client.repo.photos_[pid]["path"].split("/")
    assert user_dir and trip_dir == "trip0001" and name == f"{pid}.jpg"


def test_a_file_that_is_not_the_declared_image_type_is_refused(client):
    token = native_login(client).json()["token"]
    _trip(client, token)
    pid = client.post("/api/photos", json={"tripId": "trip0001", "contentType": "image/jpeg", "size": 20}, headers=bearer(token)).json()["photo"]["id"]
    r = client.put(f"/api/photos/{pid}/content", content=b"<script>alert(1)</s>", headers={**bearer(token), "Upload-Offset": "0"})
    assert r.status_code == 415


def test_other_endpoints_go_to_node_with_the_bearer_token_as_its_session_cookie(client, node_calls):
    token = native_login(client).json()["token"]
    r = client.get("/api/flights?from=RZE", headers=bearer(token))
    assert r.json() == {"from": "node", "path": "/api/flights"} and r.headers["x-upstream"] == "node"
    sent = node_calls[-1]
    assert sent.url.query == b"from=RZE" and sent.headers["cookie"] == f"rzbus_session={token}" and "authorization" not in sent.headers
    client.post("/api/flights/fare", json={}, headers=bearer(token))
    assert node_calls[-1].headers["origin"] == ORIGIN  # Node's same-origin check accepts the app's change
    page = client.get("/plan")
    assert page.json()["path"] == "/plan"


def test_auth_config_adds_native_google_and_cors_allows_only_the_app_origins(client):
    cfg = client.get("/api/auth/config").json()
    assert cfg["emailEnabled"] is True and cfg["googleNativeEnabled"] is True and cfg["googleClientId"] == "web-client"
    ok = client.options("/api/favorites", headers={"Origin": "capacitor://localhost", "Access-Control-Request-Method": "PUT",
                                                    "Access-Control-Request-Headers": "authorization"})
    assert ok.headers.get("access-control-allow-origin") == "capacitor://localhost"
    bad = client.options("/api/favorites", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
    assert "access-control-allow-origin" not in bad.headers


def test_node_sign_in_steps_give_apps_the_session_in_the_body_not_a_cookie(client):
    app = client.post("/api/auth/verify", json={"email": "a@b.pl", "code": "123456"}, headers={**NATIVE, "X-Auth-Mode": "token"})
    assert app.status_code == 201 and app.json() == {"user": {"id": "n1"}, "token": "A" * 43}
    assert "set-cookie" not in app.headers
    web = client.post("/api/auth/verify", json={}, headers=WEB)
    assert "rzbus_session=" in web.headers["set-cookie"] and "token" not in web.json()


def test_a_saved_trip_keeps_its_name_places_in_between_and_deep_steps_like_node():
    from app.favorites import normalize_favorites

    leg = {"kind": "flight", "snap": {"access": {"steps": [{"icon": "car", "text": "Jedź", "link": {"href": "https://maps.example/x", "label": "Mapy"}}]}}}
    [trip] = normalize_favorites([{"type": "trip", "view": "podroz", "id": "m:1", "from": "Rzeszów", "to": "Wrocław", "name": "Lot + pociąg",
                                   "title": "  Majówka nad morzem  ", "stops": ["Szczecin", "", "Gdańsk", 5], "trip": {"multi": True, "legs": [leg]}}])
    assert trip["title"] == "Majówka nad morzem"
    assert trip["stops"] == ["Szczecin", "Gdańsk"]
    assert trip["trip"]["legs"][0]["snap"]["access"]["steps"][0]["link"]["href"] == "https://maps.example/x"
