"""The shared bearer middleware (ci.sidecar.auth), against a bare app."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from ci.sidecar.auth import install_sidecar_auth, require_user_id, require_uuid

UUID = "9b2b0a7e-4d7d-4a3b-9c1e-2f6f0b5b6c3d"


def _app(secret: str) -> TestClient:
    app = FastAPI()
    install_sidecar_auth(app, secret=lambda: secret)

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/work")
    async def work(user_id: str | None = None) -> dict[str, str | None]:
        return {"user_id": user_id}

    return TestClient(app)


def test_health_is_open_and_everything_else_needs_the_bearer():
    client = _app("s3cret")

    assert client.get("/health").status_code == 200
    assert client.get("/work").status_code == 401
    assert (
        client.get("/work", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    assert (
        client.get("/work", headers={"Authorization": "bearer s3cret"}).status_code
        == 200
    )


def test_unconfigured_secret_fails_closed():
    client = _app("")

    assert client.get("/work", headers={"Authorization": "Bearer "}).status_code == 503


def test_the_secret_is_read_per_request():
    current = {"value": "first"}
    app = FastAPI()
    install_sidecar_auth(app, secret=lambda: current["value"])

    @app.get("/work")
    async def work() -> dict[str, bool]:
        return {"ok": True}

    client = TestClient(app)
    assert (
        client.get("/work", headers={"Authorization": "Bearer first"}).status_code
        == 200
    )
    current["value"] = "second"
    assert (
        client.get("/work", headers={"Authorization": "Bearer first"}).status_code
        == 401
    )
    assert (
        client.get("/work", headers={"Authorization": "Bearer second"}).status_code
        == 200
    )


@pytest.mark.parametrize(
    ("query", "status"),
    [
        ("", 200),
        (f"?user_id={UUID}", 200),
        ("?user_id=not-a-uuid", 400),
        (f"?user_id={UUID}&user_id={UUID}", 400),
    ],
)
def test_user_id_is_held_to_one_uuid_on_every_route(query: str, status: int):
    client = _app("s3cret")

    response = client.get(f"/work{query}", headers={"Authorization": "Bearer s3cret"})

    assert response.status_code == status


def test_the_bearer_is_still_checked_before_the_user_id():
    client = _app("s3cret")

    assert client.get("/work?user_id=not-a-uuid").status_code == 401


def test_require_uuid_and_require_user_id():
    assert require_uuid(UUID.upper()) == UUID
    with pytest.raises(HTTPException) as bad:
        require_uuid("../etc")
    assert bad.value.status_code == 400

    assert require_user_id(UUID) == UUID
    with pytest.raises(HTTPException) as absent:
        require_user_id(None)
    assert absent.value.status_code == 401
