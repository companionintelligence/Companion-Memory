"""
Unit tests for the Phase 5a actuals backfill (ci.pipeline.actuals_backfill).

These test the coverage arithmetic, the return-dict contract, and that the
backfill issues the UPDATE then the coverage SELECT with the user_id/lookback
parameters — without needing a live Postgres. A DB-backed integration test that
asserts the join against seeded token_stream rows is a follow-up (see PR body).
"""
from __future__ import annotations

import contextlib
import sys
import types
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class _FakeCursor:
    """Records executed SQL and replays canned results for fetchone()."""

    def __init__(self, update_rowcount: int, coverage_row: tuple):
        self._update_rowcount = update_rowcount
        self._coverage_row = coverage_row
        self.rowcount = 0
        self.executed: list[tuple[str, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, params=None):
        self.executed.append((sql, params))
        # The first statement is the UPDATE; the second is the coverage SELECT.
        if "UPDATE hbpe.prediction_log" in sql:
            self.rowcount = self._update_rowcount
        else:
            self.rowcount = -1

    def fetchone(self):
        return self._coverage_row


class _FakeConn:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


def _install_fake_db(monkeypatch, cursor: _FakeCursor):
    """Stub ci.database.get_conn (imported by the module) with a fake conn."""
    import ci.pipeline.actuals_backfill as ab

    @contextlib.contextmanager
    def fake_get_conn():
        yield _FakeConn(cursor)

    monkeypatch.setattr(ab, "get_conn", fake_get_conn)
    return ab


def test_coverage_full(monkeypatch):
    cur = _FakeCursor(update_rowcount=12, coverage_row=(40, 40))
    ab = _install_fake_db(monkeypatch, cur)

    out = ab.backfill_prediction_actuals("user-1")

    assert out["updated"] == 12
    assert out["elapsed"] == 40
    assert out["filled"] == 40
    assert out["coverage"] == 1.0
    assert out["user_id"] == "user-1"


def test_coverage_partial(monkeypatch):
    cur = _FakeCursor(update_rowcount=3, coverage_row=(48, 36))
    ab = _install_fake_db(monkeypatch, cur)

    out = ab.backfill_prediction_actuals("user-2")

    assert out["elapsed"] == 48
    assert out["filled"] == 36
    assert out["coverage"] == 0.75


def test_no_elapsed_buckets_is_zero_not_error(monkeypatch):
    cur = _FakeCursor(update_rowcount=0, coverage_row=(0, 0))
    ab = _install_fake_db(monkeypatch, cur)

    out = ab.backfill_prediction_actuals("user-3")

    assert out["elapsed"] == 0
    assert out["filled"] == 0
    assert out["coverage"] == 0.0  # no division-by-zero
    assert out["updated"] == 0


def test_lookback_and_user_id_are_bound(monkeypatch):
    cur = _FakeCursor(update_rowcount=1, coverage_row=(2, 2))
    ab = _install_fake_db(monkeypatch, cur)

    ab.backfill_prediction_actuals("user-4", lookback_days=7)

    # Both statements ran, both with the same bound params.
    assert len(cur.executed) == 2
    update_sql, update_params = cur.executed[0]
    cov_sql, cov_params = cur.executed[1]
    assert "UPDATE hbpe.prediction_log" in update_sql
    assert update_params == {"user_id": "user-4", "lookback": 7}
    assert cov_params == {"user_id": "user-4", "lookback": 7}


def test_null_coverage_counts_coerced(monkeypatch):
    # Some drivers can hand back None for an empty COUNT under odd conditions;
    # the function must coerce rather than crash.
    cur = _FakeCursor(update_rowcount=0, coverage_row=(None, None))
    ab = _install_fake_db(monkeypatch, cur)

    out = ab.backfill_prediction_actuals("user-5")

    assert out["elapsed"] == 0
    assert out["coverage"] == 0.0
