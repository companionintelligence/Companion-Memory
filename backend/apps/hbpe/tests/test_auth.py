"""The inbound bearer every HBPE route requires, and the UUID gate on ids that become paths."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from ci.hbpe.auth import install_sidecar_auth, require_user_id, require_uuid
from ci.hbpe.config import settings

GOOD = "3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11"
OTHER = "9d1f4c2a-0b3e-4f5a-8c6d-7e8f9a0b1c2d"
BEARER = {"Authorization": "Bearer s3cret"}


def _app() -> FastAPI:
    app = FastAPI()
    install_sidecar_auth(app)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/functions")
    def functions() -> dict:
        return {"functions": []}

    @app.get("/scoped")
    def scoped(user_id: str | None = None) -> dict:
        return {"user_id": user_id}

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


# ── The user_id every route trusts ───────────────────────────────────────────
#
# The bearer proves a request came from a secret holder, not which user it may
# act for: routes read the user from ?user_id=. So the middleware holds that
# parameter to one shape everywhere. A repeated user_id is the one that matters
# most: Starlette answers with the LAST copy, which is how a URL built upstream
# by interpolation could carry two users and be read as the wrong one.


def test_a_repeated_user_id_is_refused_before_any_route_runs(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    response = client.get(
        "/scoped", params=[("user_id", GOOD), ("user_id", OTHER)], headers=BEARER
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "user_id must appear at most once"


def test_a_user_id_that_is_not_a_uuid_is_refused_on_every_route(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    for bad in ("../../etc", "test", f"{GOOD}#", ""):
        response = client.get("/scoped", params={"user_id": bad}, headers=BEARER)
        assert response.status_code == 400, bad


def test_one_uuid_or_none_passes_through(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    assert client.get("/scoped", params={"user_id": GOOD}, headers=BEARER).json() == {
        "user_id": GOOD
    }
    assert client.get("/scoped", headers=BEARER).json() == {"user_id": None}


def test_the_bearer_is_still_checked_first(monkeypatch):
    # An unauthenticated caller learns nothing about which ids are well-formed.
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(_app())
    response = client.get("/scoped", params=[("user_id", GOOD), ("user_id", OTHER)])
    assert response.status_code == 401


def test_require_user_id():
    with pytest.raises(HTTPException) as missing:
        require_user_id(None)
    assert missing.value.status_code == 401
    with pytest.raises(HTTPException) as bad:
        require_user_id("not-a-uuid")
    assert bad.value.status_code == 400
    assert require_user_id(GOOD.upper()) == GOOD


def test_the_real_app_refuses_a_second_user_id(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    from ci.hbpe.api import app

    client = TestClient(app)
    for path in (
        "/histogram",
        "/forecast",
        "/forecast/due",
        "/forecast/seasonal",
        "/forage",
    ):
        response = client.get(
            path, params=[("user_id", OTHER), ("user_id", GOOD)], headers=BEARER
        )
        assert response.status_code == 400, path


# ── Operator-only routes ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path", ["/trigger", "/invalidate/2026-10-06"], ids=["trigger", "invalidate"]
)
def test_operator_routes_are_absent_unless_switched_on(monkeypatch, path):
    # Both act on any user_id and the API never calls them, so the shared
    # bearer alone must not reach them.
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    monkeypatch.setattr(settings, "enable_admin_routes", False)
    from ci.hbpe.api import app
    from ci.hbpe.runner import runner

    # Should the gate ever open, this records the run instead of starting a
    # real pipeline inside the test process.
    submitted: list[object] = []
    monkeypatch.setattr(runner, "submit", submitted.append)

    response = TestClient(app).post(path, params={"user_id": GOOD}, headers=BEARER)
    assert response.status_code == 404
    assert submitted == []


def test_invalidate_answers_once_switched_on(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    monkeypatch.setattr(settings, "enable_admin_routes", True)
    from ci.hbpe.api import app

    response = TestClient(app).post(
        "/invalidate/2026-10-06", params={"user_id": GOOD}, headers=BEARER
    )
    assert response.status_code == 200
    assert response.json()["user_id"] == GOOD


def test_the_switch_reads_its_env_var(monkeypatch):
    from ci.hbpe.config import Settings

    monkeypatch.delenv("HBPE_ENABLE_ADMIN_ROUTES", raising=False)
    assert Settings().enable_admin_routes is False
    for on in ("1", "true", "YES", " on "):
        monkeypatch.setenv("HBPE_ENABLE_ADMIN_ROUTES", on)
        assert Settings().enable_admin_routes is True, on
    for off in ("0", "false", "no", ""):
        monkeypatch.setenv("HBPE_ENABLE_ADMIN_ROUTES", off)
        assert Settings().enable_admin_routes is False, off


def test_the_switch_ignores_the_unprefixed_name(monkeypatch):
    # pydantic-settings would also read a field from the env var named after
    # it. ENABLE_ADMIN_ROUTES, set for anything else in a shared env file,
    # must neither open these routes nor override the HBPE_ name.
    from ci.hbpe.config import Settings

    monkeypatch.delenv("HBPE_ENABLE_ADMIN_ROUTES", raising=False)
    monkeypatch.setenv("ENABLE_ADMIN_ROUTES", "1")
    assert Settings().enable_admin_routes is False

    monkeypatch.setenv("HBPE_ENABLE_ADMIN_ROUTES", "1")
    monkeypatch.setenv("ENABLE_ADMIN_ROUTES", "0")
    assert Settings().enable_admin_routes is True
