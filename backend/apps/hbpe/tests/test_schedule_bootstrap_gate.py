"""
Regression tests for the per-user bootstrap gate in ci.pipeline.schedule.

Plan §3 risk #5: the cold-start gate used to check a single global
{models_dir}/hmt directory, so once *any* user had a checkpoint, no new user
ever bootstrapped. These tests pin the corrected per-user behaviour:

  * _checkpoint_exists(user_id) reflects only that user's checkpoint dir
  * ensure_bootstrap_if_cold() starts a bootstrap for cold users while
    skipping warm ones, in the same sweep

The tests avoid a live Temporal server by driving ensure_bootstrap_if_cold with
a fake client that records start_workflow calls, and avoid touching torch by
only creating artifact files on disk (never loading them).
"""
from __future__ import annotations

import pytest

from ci.model.checkpoints import HMT_INT8_ONNX, user_ckpt_dir
from ci.pipeline import schedule


WARM_USER = "11111111-warm-0000-0000-000000000000"
COLD_USER = "22222222-cold-0000-0000-000000000000"


def _make_checkpoint(user_id: str) -> None:
    """Materialise one servable artifact in the user's per-user ckpt dir."""
    d = user_ckpt_dir(user_id, create=True)
    (d / HMT_INT8_ONNX).write_bytes(b"\x00")


@pytest.fixture(autouse=True)
def _isolated_models_dir(tmp_path, monkeypatch):
    """Point settings.models_dir at a scratch dir so tests never see real ckpts."""
    from ci.config import settings

    monkeypatch.setattr(settings, "models_dir", str(tmp_path), raising=False)
    yield


def test_checkpoint_exists_is_per_user():
    _make_checkpoint(WARM_USER)

    assert schedule._checkpoint_exists(WARM_USER) is True
    # The critical regression: a warm user must NOT make a cold user look warm.
    assert schedule._checkpoint_exists(COLD_USER) is False


class _FakeClient:
    """Minimal Temporal client stand-in recording start_workflow(user_id) calls."""

    def __init__(self):
        self.started_users: list[str] = []

    async def start_workflow(self, _run, user_id, *, id, task_queue):  # noqa: A002
        self.started_users.append(user_id)


@pytest.mark.asyncio
async def test_ensure_bootstrap_only_starts_cold_users(monkeypatch):
    # One warm user (has a checkpoint) and one cold user (does not).
    _make_checkpoint(WARM_USER)
    monkeypatch.setattr(schedule, "_fetch_user_ids", lambda: [WARM_USER, COLD_USER])

    client = _FakeClient()
    await schedule.ensure_bootstrap_if_cold(client)

    # Cold user bootstraps; warm user is left alone. Before the fix, the warm
    # user's checkpoint short-circuited the whole function and neither ran.
    assert client.started_users == [COLD_USER]


@pytest.mark.asyncio
async def test_ensure_bootstrap_starts_all_when_all_cold(monkeypatch):
    monkeypatch.setattr(schedule, "_fetch_user_ids", lambda: [WARM_USER, COLD_USER])

    client = _FakeClient()
    await schedule.ensure_bootstrap_if_cold(client)

    assert sorted(client.started_users) == sorted([WARM_USER, COLD_USER])


@pytest.mark.asyncio
async def test_ensure_bootstrap_noop_when_all_warm(monkeypatch):
    _make_checkpoint(WARM_USER)
    _make_checkpoint(COLD_USER)
    monkeypatch.setattr(schedule, "_fetch_user_ids", lambda: [WARM_USER, COLD_USER])

    client = _FakeClient()
    await schedule.ensure_bootstrap_if_cold(client)

    assert client.started_users == []
