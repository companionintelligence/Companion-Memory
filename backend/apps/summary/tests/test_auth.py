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
    monkeypatch.setenv("PARSER_AUTH_SECRET", "parser-s3cret")
    from ci.summary.parser import app

    client = TestClient(app)
    assert client.post("/parse").status_code == 401
    assert client.get("/health").status_code == 200


def test_the_parser_takes_only_its_own_bearer(monkeypatch):
    # The summary service's bearer opens nothing on the parser once the parser has its own.
    monkeypatch.setenv("PARSER_AUTH_SECRET", "parser-s3cret")
    monkeypatch.setenv("SIDECAR_AUTH_SECRET", "summary-s3cret")
    from ci.summary.parser import app

    client = TestClient(app)
    summary_bearer = {"Authorization": "Bearer summary-s3cret"}
    parser_bearer = {"Authorization": "Bearer parser-s3cret"}
    assert client.post("/parse", headers=summary_bearer).status_code == 401
    # Past the bearer check: refused for the missing upload, not for the bearer.
    assert client.post("/parse", headers=parser_bearer).status_code not in (401, 503)


def test_the_summary_service_does_not_take_the_parser_bearer(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "summary-s3cret")
    monkeypatch.setenv("PARSER_AUTH_SECRET", "parser-s3cret")
    client = TestClient(_app())
    assert (
        client.get(
            "/functions", headers={"Authorization": "Bearer parser-s3cret"}
        ).status_code
        == 401
    )
