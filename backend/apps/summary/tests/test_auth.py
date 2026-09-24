"""The inbound bearer every Summary and Parser route requires."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ci.summary.auth import install_sidecar_auth
from ci.summary.config import settings


def _app() -> FastAPI:
    app = FastAPI()
    install_sidecar_auth(app)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/functions")
    def functions() -> dict:
        return {"functions": []}

    return app


def test_health_is_open_and_everything_else_needs_the_bearer(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    assert client.get("/health").status_code == 200
    assert client.get("/functions").status_code == 401
    assert (
        client.get("/functions", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    assert (
        client.get("/functions", headers={"Authorization": "Bearer s3cret"}).status_code
        == 200
    )


def test_unconfigured_secret_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "")
    client = TestClient(_app())
    assert client.get("/functions").status_code == 503
    assert client.get("/health").status_code == 200


def test_the_parser_app_is_covered(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    from ci.summary.parser import app

    client = TestClient(app)
    assert client.post("/parse").status_code == 401
    assert client.get("/health").status_code == 200
