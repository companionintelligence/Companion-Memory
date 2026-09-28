"""Container contract for forage on the HBPE sidecar."""

import pytest
from fastapi.testclient import TestClient

from ci.hbpe.forage.api import app, store

# A real UUID: user_id names the trial file on disk, so anything else is refused.
UID = {"user_id": "3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11"}
AUTH = {"Authorization": "Bearer test-sidecar-secret"}


@pytest.fixture(autouse=True)
def _sidecar_secret(monkeypatch):
    from ci.hbpe.config import settings

    monkeypatch.setattr(settings, "sidecar_auth_secret", "test-sidecar-secret")


def setup_function() -> None:
    store.trials.clear()


def test_get_starts_sam_saturday():
    client = TestClient(app, headers=AUTH)
    started = client.get("/forage", params=UID)
    assert started.status_code == 200
    body = started.json()
    assert body["question"] == "where is Sam on Saturday"
    assert {row["id"] for row in body["branches"]} == {"beach", "office", "errands"}
    assert body["attention"][0]["id"] == "calendar_saturday"


def test_sample_pin_and_permutations():
    client = TestClient(app, headers=AUTH)
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
    client = TestClient(app, headers=AUTH)
    assert client.get("/forage").status_code == 401


def test_unknown_branch_is_404():
    client = TestClient(app, headers=AUTH)
    client.get("/forage", params=UID)
    assert client.post("/forage/pin/moon", params=UID).status_code == 404


def test_ask_resets_the_trial():
    client = TestClient(app, headers=AUTH)
    client.post("/forage/sample", params=UID)
    reset = client.post("/forage/ask", params=UID)
    assert reset.status_code == 200
    assert reset.json()["reads"] == []
    assert reset.json()["pin"] is None


def test_non_uuid_user_is_400_and_writes_nothing(tmp_path, monkeypatch):
    # user_id becomes the trial file's name; "../x" or a plain word must never reach disk.
    monkeypatch.setenv("FORAGE_DATA_DIR", str(tmp_path))
    client = TestClient(app, headers=AUTH)
    assert (
        client.get("/forage", params={"user_id": "../../etc/passwd"}).status_code == 400
    )
    assert client.get("/forage", params={"user_id": "test"}).status_code == 400
    assert list(tmp_path.iterdir()) == []


def test_forage_requires_the_bearer():
    assert TestClient(app).get("/forage", params=UID).status_code == 401
