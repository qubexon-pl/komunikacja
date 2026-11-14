from datetime import date, timedelta

NATIVE = {"Origin": "capacitor://localhost"}


def bearer(token):
    return {"Authorization": f"Bearer {token}", **NATIVE}


def login(client, email="ania@example.com", password="correct horse battery"):
    return client.post("/api/auth/login", json={"email": email, "password": password}, headers={**NATIVE, "X-Auth-Mode": "token"}).json()


def owner_with_trip(client, days_ahead=3):
    owner = client.post("/api/auth/google/native", json={"idToken": "good"}, headers=NATIVE).json()  # user "Nowy"
    day = (date.today() + timedelta(days=days_ahead)).isoformat()
    back = (date.today() + timedelta(days=days_ahead + 2)).isoformat()
    trip = {"type": "trip", "view": "podroz", "id": "f:1", "from": "Rzeszów", "to": "Sztokholm", "name": "Lot", "tid": "trip0001", "status": "booked",
            "flight": {"from": "KRK", "to": "ARN", "day": day, "back": back, "airline": "RYANAIR"}}
    client.put("/api/favorites", json={"favorites": [trip]}, headers=bearer(owner["token"]))
    return owner


def test_a_trip_is_shared_with_a_registered_friend_who_sees_it_read_only_and_can_leave(client):
    owner = owner_with_trip(client)
    friend = login(client)
    t, oid = owner["token"], owner["user"]["id"]
    assert client.post("/api/trips/trip0001/members", json={"email": "nobody@example.com"}, headers=bearer(t)).status_code == 404
    assert client.post("/api/trips/trip0001/members", json={"email": owner["user"]["email"]}, headers=bearer(t)).status_code == 400
    assert client.post("/api/trips/other/members", json={"email": "ania@example.com"}, headers=bearer(t)).status_code == 404
    added = client.post("/api/trips/trip0001/members", json={"email": "Ania@example.com"}, headers=bearer(t))
    assert added.status_code == 201 and added.json()["member"]["name"] == "Ania"
    shared = client.get("/api/trips/shared", headers=bearer(friend["token"])).json()["trips"]
    assert [(x["ownerName"], x["trip"]["tid"], x["trip"]["to"]) for x in shared] == [("Nowy", "trip0001", "Sztokholm")]
    assert client.get("/api/trips/mine/shares", headers=bearer(t)).json() == {"shares": {"trip0001": ["Ania"]}}
    people = client.get(f"/api/trips/{oid}/trip0001/members", headers=bearer(friend["token"])).json()
    assert people["role"] == "member" and [p["name"] for p in people["members"]] == ["Nowy", "Ania"]
    assert all("email" not in p for p in people["members"])  # members do not see each other's e-mail
    assert "email" in client.get(f"/api/trips/{oid}/trip0001/members", headers=bearer(t)).json()["members"][1]
    # a member cannot remove someone else, but can leave
    assert client.delete(f"/api/trips/{oid}/trip0001/members/{oid}", headers=bearer(friend["token"])).status_code == 403
    assert client.delete(f"/api/trips/{oid}/trip0001/members/{friend['user']['id']}", headers=bearer(friend["token"])).json() == {"removed": True}
    assert client.get("/api/trips/shared", headers=bearer(friend["token"])).json()["trips"] == []
    assert client.get(f"/api/trips/{oid}/trip0001/members", headers=bearer(friend["token"])).status_code == 404


def test_location_is_visible_only_after_that_person_switches_it_on_and_disappears_when_switched_off(client):
    owner = owner_with_trip(client)
    friend = login(client)
    oid, t, ft = owner["user"]["id"], owner["token"], friend["token"]
    client.post("/api/trips/trip0001/members", json={"email": "ania@example.com"}, headers=bearer(t))
    url = f"/api/trips/{oid}/trip0001"
    # without her consent nothing about Ania's position exists, and it cannot be sent
    assert client.put(f"{url}/location", json={"lat": 50.04, "lon": 21.99}, headers=bearer(ft)).status_code == 409
    assert client.get(f"{url}/locations", headers=bearer(t)).json()["locations"] == []
    on = client.put(f"{url}/location-sharing", json={"enabled": True}, headers=bearer(ft)).json()
    assert on["sharing"] is True and on["until"]
    assert client.put(f"{url}/location", json={"lat": 50.04, "lon": 21.99, "accuracy": 12}, headers=bearer(ft)).json() == {"saved": True}
    seen = client.get(f"{url}/locations", headers=bearer(t)).json()["locations"]
    assert [(x["name"], x["lat"], x["lon"], x["me"]) for x in seen] == [("Ania", 50.04, 21.99, False)]
    assert [p["sharingLocation"] for p in client.get(f"{url}/members", headers=bearer(t)).json()["members"]] == [False, True]
    assert client.put(f"{url}/location", json={"lat": 999, "lon": 0}, headers=bearer(ft)).status_code == 400
    client.put(f"{url}/location-sharing", json={"enabled": False}, headers=bearer(ft))
    assert client.get(f"{url}/locations", headers=bearer(t)).json()["locations"] == []
    # people outside the trip see nothing
    stranger = client.post("/api/auth/login", json={"email": "ania@example.com", "password": "correct horse battery"}, headers={**NATIVE, "X-Auth-Mode": "token"})
    client.delete(f"{url}/members/{friend['user']['id']}", headers=bearer(t))
    assert client.get(f"{url}/locations", headers=bearer(stranger.json()["token"])).status_code == 404


def test_an_old_position_is_not_shown_as_current_and_a_finished_trip_cannot_start_sharing(client):
    owner = owner_with_trip(client)
    oid, t = owner["user"]["id"], owner["token"]
    url = f"/api/trips/{oid}/trip0001"
    login(client)
    client.post("/api/trips/trip0001/members", json={"email": "ania@example.com"}, headers=bearer(t))  # someone to show it to
    client.put(f"{url}/location-sharing", json={"enabled": True}, headers=bearer(t))
    client.repo.clock = "2020-01-01T10:00:00Z"
    client.put(f"{url}/location", json={"lat": 50.0, "lon": 22.0}, headers=bearer(t))
    old = client.get(f"{url}/locations", headers=bearer(t)).json()["locations"][0]
    assert old["lat"] is None and old["at"] == "2020-01-01T10:00:00Z"
    past = owner_with_trip(client, days_ahead=-10)
    r = client.put(f"/api/trips/{past['user']['id']}/trip0001/location-sharing", json={"enabled": True}, headers=bearer(past["token"]))
    assert r.status_code == 400


def test_a_missing_table_is_reported_plainly_instead_of_a_bare_500(client):
    import pyodbc

    owner = owner_with_trip(client)
    def broken(member_id):
        raise pyodbc.ProgrammingError("42S02", "[42S02] Invalid object name 'dbo.TripShare'. (208)")
    client.repo.shared_with = broken
    r = client.get("/api/trips/shared", headers=bearer(owner["token"]))
    assert r.status_code == 503 and "migrac" in r.json()["error"]


def test_suggestions_show_known_people_in_full_and_others_only_by_email_start_masked(client):
    owner = owner_with_trip(client)
    t = owner["token"]
    assert client.get("/api/trips/people?q=an", headers=bearer(t)).json() == {"people": []}  # 2 letters of a stranger: nothing
    found = client.get("/api/trips/people?q=ani", headers=bearer(t)).json()["people"]
    assert [(p["name"], p["email"], p["contact"]) for p in found] == [("Ania", "a***@example.com", False)]
    added = client.post("/api/trips/trip0001/members", json={"userId": found[0]["id"]}, headers=bearer(t))
    assert added.status_code == 201 and added.json()["member"]["name"] == "Ania"
    # now a known person: found by name, e-mail shown in full
    known = client.get("/api/trips/people?q=a", headers=bearer(t)).json()["people"]
    assert [(p["name"], p["email"], p["contact"]) for p in known] == [("Ania", "ania@example.com", True)]
    assert client.post("/api/trips/trip0001/members", json={"userId": "not-a-uuid"}, headers=bearer(t)).status_code in (400, 404)


def test_location_is_shown_only_to_the_people_its_owner_chose(client):
    owner = owner_with_trip(client)
    t, oid = owner["token"], owner["user"]["id"]
    ania = login(client)
    url = f"/api/trips/{oid}/trip0001"
    # added "with my location": Ania sees the owner's position
    added = client.post("/api/trips/trip0001/members", json={"email": "ania@example.com", "withLocation": True}, headers=bearer(t)).json()
    assert added["member"]["seesMyLocation"] is True
    client.put(f"{url}/location", json={"lat": 50.0, "lon": 22.0}, headers=bearer(t))
    assert [x["name"] for x in client.get(f"{url}/locations", headers=bearer(ania["token"])).json()["locations"]] == ["Nowy"]
    people = client.get(f"{url}/members", headers=bearer(ania["token"])).json()["members"]
    assert [(p["name"], p["sharesWithMe"], p["seesMyLocation"]) for p in people] == [("Nowy", True, False), ("Ania", False, False)]
    # Ania has not chosen anyone: nobody sees her, and she can show it to the owner only herself
    assert all(x["userId"] != ania["user"]["id"] for x in client.get(f"{url}/locations", headers=bearer(t)).json()["locations"])
    r = client.put(f"{url}/location-sharing", json={"viewerId": oid, "enabled": True}, headers=bearer(ania["token"])).json()
    assert r["sharing"] is True and r["viewers"] == [oid]
    # the owner hides their location from Ania again; sending stops when nobody is left
    off = client.put(f"{url}/location-sharing", json={"viewerId": ania["user"]["id"], "enabled": False}, headers=bearer(t)).json()
    assert off == {"sharing": False, "viewers": [], "until": None}
    assert [x["name"] for x in client.get(f"{url}/locations", headers=bearer(ania["token"])).json()["locations"]] == ["Ania"]
    # a person outside the trip cannot be chosen
    assert client.put(f"{url}/location-sharing", json={"viewerId": "00000000-0000-0000-0000-000000000009", "enabled": True}, headers=bearer(t)).status_code == 404
