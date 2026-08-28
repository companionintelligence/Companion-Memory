"""Container contract for forage on the HBPE sidecar."""

from fastapi.testclient import TestClient

from ci.hbpe.forage.api import app, store

UID = {"user_id": "test"}


def setup_function() -> None:
    store.trials.clear()


def test_get_starts_sam_saturday():
    client = TestClient(app)
    started = client.get("/forage", params=UID)
    assert started.status_code == 200
    body = started.json()
    assert body["question"] == "where is Sam on Saturday"
    assert {row["id"] for row in body["branches"]} == {"beach", "office", "errands"}
    assert body["attention"][0]["id"] == "calendar_saturday"


def test_sample_pin_and_permutations():
    client = TestClient(app)
    client.get("/forage", params=UID)

    first = client.post("/forage/sample", params=UID)
    assert first.status_code == 200
    assert first.json()["reads"][0]["item_id"] == "calendar_saturday"
    assert first.json()["pick"] == "beach"

    pin = client.post("/forage/pin/beach", params=UID)
    assert pin.status_code == 200
    assert pin.json()["pin"] == "beach"
    labels = {row["label"] for row in pin.json()["permutations"]}
    assert "jerry" in labels
    assert pin.json()["interests"]["jerry"] == ["surf", "tacos"]

    client.post("/forage/sample", params=UID)
    client.post("/forage/sample", params=UID)
    again = client.get("/forage", params=UID)
    assert len(again.json()["reads"]) == 3


def test_missing_user_is_401():
    client = TestClient(app)
    assert client.get("/forage").status_code == 401


def test_unknown_branch_is_404():
    client = TestClient(app)
    client.get("/forage", params=UID)
    assert client.post("/forage/pin/moon", params=UID).status_code == 404


def test_ask_resets_the_trial():
    client = TestClient(app)
    client.post("/forage/sample", params=UID)
    reset = client.post("/forage/ask", params=UID)
    assert reset.status_code == 200
    assert reset.json()["reads"] == []
    assert reset.json()["pin"] is None
