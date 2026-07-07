"""
Unit tests for the multi-day forecast egress (CI-Engineering#61).

Covers build_histogram's horizon_start handling — day-window selection,
today..today+7 validation, back-compat response shape when the param is
omitted, and that every served day flows through the _log_prediction path
(ADR HBPE-0009 scoreability) — without needing a live Postgres or ONNX model.
The InferenceEngine is mocked; time is frozen so the midnight-UTC rollover
cannot flake the boundary assertions.
"""
from __future__ import annotations

import datetime
import sys
import types
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import ci.pipeline.histogram_api as ha  # noqa: E402


FROZEN_NOW = datetime.datetime(2026, 7, 7, 12, 34, 56)
TODAY = FROZEN_NOW.date()


class _FrozenDateTime(datetime.datetime):
    @classmethod
    def utcnow(cls):
        return cls(*FROZEN_NOW.timetuple()[:6])


def _freeze_time(monkeypatch):
    """Replace the module's `datetime` with a shim whose utcnow() is fixed."""
    fake_module = types.SimpleNamespace(
        datetime=_FrozenDateTime,
        date=datetime.date,
        time=datetime.time,
        timedelta=datetime.timedelta,
    )
    monkeypatch.setattr(ha, "datetime", fake_module)


class _FakeEngine:
    """Minimal predict() stand-in: 48 buckets stamped with the requested window."""

    def __init__(self):
        self.calls: list[datetime.datetime] = []

    def predict(self, horizon_start=None):
        self.calls.append(horizon_start)
        return [
            {
                "bucket_index": i,
                "start_time": (horizon_start + datetime.timedelta(minutes=30 * i)).isoformat() + "Z",
                "l0_probs": {"idle": 1.0},
                "l1_probs": {},
                "l2_probs": None,
                "q10": 0.1,
                "q50": 0.5,
                "q90": 0.9,
            }
            for i in range(48)
        ]


@pytest.fixture()
def env(monkeypatch):
    """Frozen clock + mocked engine + recorded (not executed) prediction log."""
    _freeze_time(monkeypatch)
    logged: list[tuple] = []
    monkeypatch.setattr(
        ha, "_log_prediction",
        lambda user_id, predicted_at, horizon_start, buckets: logged.append(
            (user_id, predicted_at, horizon_start, len(buckets))
        ),
    )
    return _FakeEngine(), logged


# ── Back-compat: omitted horizon_start ─────────────────────────────────────────

def test_default_window_is_tomorrow_and_shape_unchanged(env):
    engine, logged = env

    result = ha.build_histogram(engine, user_id="user-1", system_status="READY")

    expected_start = datetime.datetime.combine(TODAY + datetime.timedelta(days=1), datetime.time.min)
    assert engine.calls == [expected_start]
    # Response shape must stay byte-identical for legacy clients: exactly the
    # four pre-multi-day keys, and no horizon_start echo.
    assert list(result.keys()) == ["horizon", "generated_at", "system_status", "buckets"]
    assert result["horizon"] == "24h"
    assert len(result["buckets"]) == 48
    # Default serve still logs for scoreability.
    assert logged == [("user-1", FROZEN_NOW, expected_start, 48)]


# ── Day-window selection ───────────────────────────────────────────────────────

def test_explicit_day_selects_that_window_and_echoes_it(env):
    engine, logged = env
    day = TODAY + datetime.timedelta(days=3)

    result = ha.build_histogram(engine, user_id="user-1", system_status="READY", horizon_start=day)

    expected_start = datetime.datetime.combine(day, datetime.time.min)
    assert engine.calls == [expected_start]
    assert result["horizon_start"] == day.isoformat()
    assert result["buckets"][0]["start_time"].startswith(day.isoformat())
    assert logged == [("user-1", FROZEN_NOW, expected_start, 48)]


def test_each_range_day_logs_independently(env):
    engine, logged = env
    days = [TODAY + datetime.timedelta(days=i) for i in range(3)]

    for day in days:
        ha.build_histogram(engine, user_id="user-1", system_status="READY", horizon_start=day)

    assert [entry[2].date() for entry in logged] == days
    assert all(entry[3] == 48 for entry in logged)


# ── Validation: today <= horizon_start <= today + 7 ───────────────────────────

@pytest.mark.parametrize("offset", [0, 1, 7])
def test_boundary_days_are_accepted(env, offset):
    engine, _ = env
    day = TODAY + datetime.timedelta(days=offset)

    result = ha.build_histogram(engine, user_id="user-1", system_status="READY", horizon_start=day)

    assert result["horizon_start"] == day.isoformat()


@pytest.mark.parametrize("offset", [-1, -30, 8, 365])
def test_out_of_range_days_are_rejected(env, offset):
    engine, logged = env
    day = TODAY + datetime.timedelta(days=offset)

    with pytest.raises(ValueError, match="out of range"):
        ha.build_histogram(engine, user_id="user-1", system_status="READY", horizon_start=day)

    # Nothing was predicted or logged for a rejected request.
    assert engine.calls == []
    assert logged == []


def test_unsupported_horizon_still_rejected(env):
    engine, _ = env

    with pytest.raises(ValueError, match="Unsupported horizon"):
        ha.build_histogram(engine, horizon="7d", user_id="user-1", system_status="READY")
