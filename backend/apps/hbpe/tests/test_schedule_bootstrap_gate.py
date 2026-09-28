"""
Regression tests for the per-user bootstrap gate in ci.hbpe.functions.

Plan §3 risk #5: the cold-start gate used to check a single global
{models_dir}/hmt directory, so once *any* user had a checkpoint, no new user
ever bootstrapped. These tests pin the corrected per-user behaviour:

  * model_exists(user_id) reflects only that user's checkpoint dir
  * ensure_bootstrap() runs the full bootstrap for cold users while
    skipping warm ones

Bootstraps are recorded through a monkeypatched ``bootstrap`` so no torch /
llama.cpp code ever runs; artifact files are only created on disk (never
loaded).
"""

from __future__ import annotations

import pytest

from ci.hbpe import functions
from ci.hbpe.model.checkpoints import (
    HMT_INT8_ONNX,
    model_exists,
    user_ckpt_dir,
    write_architecture_stamp,
)

WARM_USER = (
    "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"  # a UUID: user ids name checkpoint dirs
)
COLD_USER = "0f1e2d3c-4b5a-4968-8776-655443322110"


def _make_checkpoint(user_id: str, *, stamp: bool = True) -> None:
    """Materialise one servable artifact in the user's per-user ckpt dir."""
    d = user_ckpt_dir(user_id, create=True)
    (d / HMT_INT8_ONNX).write_bytes(b"\x00")
    if stamp:
        write_architecture_stamp(user_id)


@pytest.fixture(autouse=True)
def _isolated_models_dir(tmp_path, monkeypatch):
    """Point settings.models_dir at a scratch dir so tests never see real ckpts."""
    from ci.hbpe.config import settings

    monkeypatch.setattr(settings, "models_dir", str(tmp_path), raising=False)
    yield


@pytest.fixture()
def bootstrapped_users(monkeypatch):
    """Replace the real bootstrap pipeline with a recorder."""
    started: list[str] = []

    async def _fake_bootstrap(user_id: str, **_):
        started.append(user_id)
        return {"user_id": user_id, "workflow": "bootstrap", "steps": {}}

    monkeypatch.setattr(functions, "bootstrap", _fake_bootstrap)
    return started


def test_checkpoint_exists_is_per_user():
    _make_checkpoint(WARM_USER)

    assert model_exists(WARM_USER) is True
    # The critical regression: a warm user must NOT make a cold user look warm.
    assert model_exists(COLD_USER) is False


@pytest.mark.asyncio
async def test_ensure_bootstrap_only_starts_cold_users(bootstrapped_users):
    # One warm user (has a checkpoint) and one cold user (does not).
    _make_checkpoint(WARM_USER)

    warm = await functions.ensure_bootstrap(WARM_USER)
    cold = await functions.ensure_bootstrap(COLD_USER)

    # Cold user bootstraps; warm user is left alone.
    assert warm == {
        "skipped": True,
        "reason": "checkpoint_exists",
        "user_id": WARM_USER,
    }
    assert cold["workflow"] == "bootstrap"
    assert bootstrapped_users == [COLD_USER]


@pytest.mark.asyncio
async def test_ensure_bootstrap_starts_all_when_all_cold(bootstrapped_users):
    await functions.ensure_bootstrap(WARM_USER)
    await functions.ensure_bootstrap(COLD_USER)

    assert sorted(bootstrapped_users) == sorted([WARM_USER, COLD_USER])


@pytest.mark.asyncio
async def test_ensure_bootstrap_noop_when_all_warm(bootstrapped_users):
    _make_checkpoint(WARM_USER)
    _make_checkpoint(COLD_USER)

    await functions.ensure_bootstrap(WARM_USER)
    await functions.ensure_bootstrap(COLD_USER)

    assert bootstrapped_users == []


@pytest.mark.asyncio
async def test_ensure_bootstrap_retrains_on_architecture_mismatch(
    bootstrapped_users, monkeypatch
):
    """A leftover 64-d checkpoint (no architecture stamp) must not skip retrain."""
    _make_checkpoint(WARM_USER, stamp=False)
    ran_nightly: list[str] = []

    async def _fake_nightly(user_id: str, **_):
        ran_nightly.append(user_id)
        return {"user_id": user_id, "workflow": "nightly", "steps": {}}

    monkeypatch.setattr(functions, "nightly", _fake_nightly)

    result = await functions.ensure_bootstrap(WARM_USER)

    assert result["workflow"] == "nightly"
    assert ran_nightly == [WARM_USER]
    assert bootstrapped_users == []


@pytest.mark.asyncio
async def test_ensure_bootstrap_skips_while_pipeline_running(bootstrapped_users):
    functions.CURRENT_STEPS[COLD_USER] = "NIGHTLY:train"
    try:
        result = await functions.ensure_bootstrap(COLD_USER)
    finally:
        functions.CURRENT_STEPS.pop(COLD_USER, None)

    assert result == {
        "skipped": True,
        "reason": "pipeline_running",
        "user_id": COLD_USER,
    }
    assert bootstrapped_users == []
