"""
The declared sleep window, written into the token stream.

Everything runs against injected fakes — no Postgres. The behaviour pinned here
is what makes the fill safe to leave on: observations always win, a day with no
tokens is never invented, a missing or broken prior leaves the day exactly as it
was, and the local->UTC conversion follows the user's zone through DST.
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg2.extras
import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.tokenizer import serializer as ser  # noqa: E402
from ci.hbpe.tokenizer import sleep_fill as sf  # noqa: E402
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES  # noqa: E402

USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"
CLUSTER = "4d2a23f0-427d-4304-b6c8-8b22d411b695"
RHYTHM = {"sleep_time": "02:00", "wake_time": "09:00"}  # the user's real answer
SUMMER = "2026-07-01"
WINTER = "2026-01-15"


def _l0(bucket: int, token: str = "WORK") -> dict:
    return {
        "level": "L0",
        "token_id": token,
        "soft_prob_vector": [1.0],
        "bucket_idx": bucket,
    }


def _prior(tz: str | None = "America/New_York", cluster: str | None = CLUSTER):
    return sf.SleepPrior(rhythm=RHYTHM, tz=tz, cluster_id=cluster)


# ── the pure fill ─────────────────────────────────────────────────────────────


def test_fills_every_asleep_bucket_that_is_empty():
    added = sf.sleep_fill_records([], {10, 11, 12}, CLUSTER)
    l0 = [r for r in added if r["level"] == "L0"]
    assert [r["bucket_idx"] for r in l0] == [10, 11, 12]
    assert {r["token_id"] for r in l0} == {"SLEEP"}


def test_an_event_in_the_window_beats_the_prior():
    """A night spent working must still read WORK."""
    added = sf.sleep_fill_records([_l0(11, "WORK")], {10, 11, 12}, CLUSTER)
    assert 11 not in {r["bucket_idx"] for r in added}


def test_a_record_at_any_level_blocks_the_fill():
    """A summary token can arrive without an L0; the bucket is still taken."""
    l1_only = {
        "level": "L1",
        "token_id": "x",
        "soft_prob_vector": [1.0],
        "bucket_idx": 11,
    }
    assert 11 not in {
        r["bucket_idx"] for r in sf.sleep_fill_records([l1_only], {11}, CLUSTER)
    }


def test_each_filled_bucket_pairs_an_l1_token_with_the_cluster():
    """The weekly climate is built from L1 tokens; an L0-only fill would train
    the models and still leave the week view empty."""
    added = sf.sleep_fill_records([], {10}, CLUSTER)
    assert [(r["level"], r["token_id"]) for r in added] == [
        ("L0", "SLEEP"),
        ("L1", CLUSTER),
    ]


def test_no_cluster_means_l0_only_rather_than_a_dangling_l1():
    added = sf.sleep_fill_records([], {10, 11}, None)
    assert {r["level"] for r in added} == {"L0"}


def test_out_of_range_buckets_are_ignored():
    assert sf.sleep_fill_records([], {-1, 96, 200}, CLUSTER) == []


def test_a_declared_window_is_not_recorded_as_certain():
    vec = sf.soft_vector()
    assert len(vec) == len(L0_CLASSES)
    assert vec[L0_CLASSES.index("SLEEP")] == sf.SLEEP_FILL_CONFIDENCE < 1.0
    assert sum(vec) == pytest.approx(1.0)


# ── local time to UTC buckets, per day ────────────────────────────────────────


def _l0_buckets(added):
    return sorted(r["bucket_idx"] for r in added if r["level"] == "L0")


def test_new_york_summer_window_lands_on_utc_06_to_13():
    got = _l0_buckets(sf.fill_for_day([], _prior(), SUMMER))
    assert (got[0], got[-1], len(got)) == (24, 51, 28)  # 06:00 -> 13:00 UTC


def test_the_window_shifts_an_hour_in_winter():
    got = _l0_buckets(sf.fill_for_day([], _prior(), WINTER))
    assert (got[0], got[-1], len(got)) == (28, 55, 28)  # 07:00 -> 14:00 UTC


def test_no_timezone_applies_the_clock_as_written():
    got = _l0_buckets(sf.fill_for_day([], _prior(tz=None), SUMMER))
    assert (got[0], got[-1]) == (8, 35)


# ── the prior cache ───────────────────────────────────────────────────────────


def test_a_failed_load_degrades_to_no_prior_and_is_not_cached(monkeypatch):
    calls = {"n": 0}

    def boom(_uid):
        calls["n"] += 1
        raise RuntimeError("db blip")

    monkeypatch.setattr(sf, "load_sleep_prior", boom)
    cache = sf.PriorCache()
    assert cache.get(USER) is None
    assert cache.get(USER) is None
    assert calls["n"] == 2  # retried, not remembered


def test_a_loaded_prior_is_reused_within_its_lifetime(monkeypatch):
    calls = {"n": 0}

    def load(_uid):
        calls["n"] += 1
        return _prior()

    monkeypatch.setattr(sf, "load_sleep_prior", load)
    cache = sf.PriorCache()
    assert cache.get(USER) is cache.get(USER)
    assert calls["n"] == 1


def test_a_user_with_no_declared_window_is_cached_as_none(monkeypatch):
    calls = {"n": 0}

    def load(_uid):
        calls["n"] += 1
        return None

    monkeypatch.setattr(sf, "load_sleep_prior", load)
    cache = sf.PriorCache()
    cache.get(USER)
    cache.get(USER)
    assert calls["n"] == 1


# ── through serialize_day ─────────────────────────────────────────────────────


class _Cur:
    rowcount = 0

    def execute(self, *_a, **_k):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    def cursor(self, **_kw):
        return _Cur()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def written(monkeypatch):
    """Run serialize_day against a stubbed read and capture the rows inserted."""
    inserted: list = []
    monkeypatch.setattr(ser, "get_conn", lambda: _Conn())
    monkeypatch.setattr(
        psycopg2.extras,
        "execute_batch",
        lambda cur, sql, rows, **_kw: inserted.extend(rows),
    )

    def run(day_rows, prior, *, date=SUMMER):
        monkeypatch.setattr(
            ser, "_fetch_tokens_for_day", lambda *_a: (list(day_rows), True)
        )
        monkeypatch.setattr(ser.PriorCache, "get", lambda self, uid: prior)
        inserted.clear()
        ser.TokenSerializer().serialize_day(USER, date)
        # (user, date, seq, bucket, level, token, soft_prob)
        return [(r[3], r[4], r[5]) for r in inserted]

    return run


def test_serialize_day_adds_sleep_to_a_day_that_has_tokens(written):
    rows = written([_l0(60, "WORK")], _prior())
    sleep_buckets = {b for b, lvl, tok in rows if lvl == "L0" and tok == "SLEEP"}
    assert sleep_buckets == set(range(24, 52))
    assert (60, "L0", "WORK") in rows  # the real event is untouched


def test_serialize_day_keeps_sod_first_eod_last_and_buckets_ordered(written):
    rows = written([_l0(60)], _prior())
    assert rows[0][1] == "SOD" and rows[-1][1] == "EOD"
    body = [b for b, lvl, _ in rows if lvl not in ("SOD", "EOD")]
    assert body == sorted(body)


def test_serialize_day_never_invents_a_day_with_no_tokens(written):
    assert written([], _prior()) == []


def test_serialize_day_without_a_prior_writes_the_day_as_it_was(written):
    rows = written([_l0(60)], None)
    assert not any(tok == "SLEEP" for _, _, tok in rows)


def test_a_fill_failure_still_writes_the_day(written, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bad rhythm")

    monkeypatch.setattr(ser, "fill_for_day", boom)
    rows = written([_l0(60)], _prior())
    assert (60, "L0", "WORK") in rows
    assert not any(tok == "SLEEP" for _, _, tok in rows)


def test_an_event_inside_the_window_survives_serialization(written):
    rows = written([_l0(30, "WORK")], _prior())
    at_30 = [(lvl, tok) for b, lvl, tok in rows if b == 30]
    assert at_30 == [("L0", "WORK")]
