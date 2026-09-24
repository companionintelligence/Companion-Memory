"""The inbound bearer every HBPE route requires, and the UUID gate on ids that become paths."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from ci.hbpe.auth import install_sidecar_auth, require_uuid
from ci.hbpe.config import settings


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


def test_health_is_open_for_the_docker_healthcheck(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    assert TestClient(_app()).get("/health").status_code == 200


def test_every_other_route_requires_the_shared_bearer(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    assert client.get("/functions").status_code == 401
    assert (
        client.get("/functions", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    assert (
        client.get("/functions", headers={"Authorization": "Basic s3cret"}).status_code
        == 401
    )
    assert (
        client.get("/functions", headers={"Authorization": "Bearer s3cret"}).status_code
        == 200
    )


def test_unconfigured_secret_fails_closed(monkeypatch):
    # No secret means no work accepted — not "accept everything".
    monkeypatch.setattr(settings, "sidecar_auth_secret", "")
    client = TestClient(_app())
    assert client.get("/functions").status_code == 503
    assert (
        client.get(
            "/functions", headers={"Authorization": "Bearer anything"}
        ).status_code
        == 503
    )
    assert client.get("/health").status_code == 200


def test_the_real_app_is_covered(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    from ci.hbpe.api import app

    client = TestClient(app)
    assert client.get("/functions").status_code == 401
    assert (
        client.post(
            "/functions/run", json={"function": "nightly", "args": {}}
        ).status_code
        == 401
    )
    assert (
        client.get("/functions", headers={"Authorization": "Bearer s3cret"}).status_code
        == 200
    )


def test_require_uuid():
    good = "3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11"
    assert require_uuid(good) == good
    for bad in ("../../etc", "test", "", f"{good}/.."):
        with pytest.raises(HTTPException) as exc:
            require_uuid(bad)
        assert exc.value.status_code == 400


def test_checkpoint_dir_refuses_non_uuid(tmp_path, monkeypatch):
    from ci.hbpe.model.checkpoints import user_ckpt_dir

    monkeypatch.setattr(settings, "models_dir", str(tmp_path))
    with pytest.raises(ValueError):
        user_ckpt_dir("../escape", create=True)
    assert list(tmp_path.iterdir()) == []
    assert user_ckpt_dir("3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11").parent.name == "users"
