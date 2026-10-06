"""
Unit tests for TokenSerializer.serialize_day's write behaviour
(ci.hbpe.tokenizer.serializer).

Context: serialize_day is the sole writer of hbpe.token_stream, and since
#2482 the nightly runs it over the trailing serialize window every night
rather than only on bootstrap nights. It returned early on a day that yielded
no tokens, so it never issued its DELETE — a day whose last labeled event was
soft-deleted (ci.events.is_deleted, which get_token_events_for_day filters on)
or re-dated kept its stale rows, and recurrence.py plus HMT training went on
reading a day that no longer exists.

The fix cannot be a bare hoist of the DELETE above that guard, because two of
the three token sources are non-fatal: a completed-task or summary read that
fails comes back as [] and is indistinguishable from an empty day. These tests
pin both halves — the empty day is cleared, but only when the read that
declared it empty actually succeeded.

Everything runs against injected fakes: a recording connection that reports a
rowcount, stubbed data_client readers and a stubbed SummaryTokenizer. No
Postgres.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import ClassVar

import psycopg2.extras
import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import data_client as dc  # noqa: E402
from ci.hbpe.tokenizer import serializer as ser  # noqa: E402
from ci.hbpe.tokenizer import summary_tokenizer as st  # noqa: E402

USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"
DATE = "2026-08-15"


# ── Fakes ─────────────────────────────────────────────────────────────────────


class _RecordingCursor:
    """Records executed SQL and reports a caller-chosen DELETE rowcount."""

    def __init__(self, calls: list, delete_rowcount: int) -> None:
        self._calls = calls
        self.rowcount = delete_rowcount

    def execute(self, sql, params=None):
        self._calls.append((" ".join(str(sql).split()), list(params or [])))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _RecordingConn:
    def __init__(self, calls: list, delete_rowcount: int) -> None:
        self._calls = calls
        self._delete_rowcount = delete_rowcount

    def cursor(self, **_kw):
        return _RecordingCursor(self._calls, self._delete_rowcount)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeSummaryTokenizer:
    """
    Stand-in for SummaryTokenizer; either yields records or raises.

    State is class-level because serialize_day constructs the tokenizer itself
    (``SummaryTokenizer()``), so the test can only reach it through the class.
    """

    records: ClassVar[list[dict]] = []
    error: ClassVar[Exception | None] = None

    def get_tokens_for_day(self, _user_id, _date_str):
        if type(self).error is not None:
            raise type(self).error
        return list(type(self).records)


def _reader(source):
    """A stubbed data_client reader: raises if given an Exception, else returns it."""

    def _fn(*_args, **_kwargs):
        if isinstance(source, Exception):
            raise source
        return list(source or [])

    return _fn


def _event(start_min: float, l0_class: str = "WORK") -> dict:
    """One labeled event, in the shape get_token_events_for_day returns."""
    return {
        "l0_class": l0_class,
        "l1_cluster_id": None,
        "l1_sim": 1.0,
        "tier": "anchor",
        "start_min": start_min,
        "end_min": start_min + 30.0,
        "default_duration_min": 30,
        "priority": None,
        "l2_cluster_id": None,
        "l2_sim": None,
    }


@pytest.fixture(autouse=True)
def _no_declared_sleep(monkeypatch):
    """
    These tests are about which statements serialize_day issues, so keep the
    declared-sleep prior out of them. Without this the serializer would try to
    read the self-entity from whatever database the environment points at.
    tests/test_sleep_fill.py covers the fill itself.
    """
    monkeypatch.setattr(ser.PriorCache, "get", lambda self, user_id: None)


@pytest.fixture
def wired(monkeypatch):
    """
    Wire serialize_day to fakes and hand back the recorded SQL statements.

    Returns a setup callable: setup(events=..., tasks=..., summaries=...,
    delete_rowcount=...) where each source is either a list of records or an
    Exception to raise. The returned list accumulates (sql, params) tuples.
    """
    calls: list = []

    def _setup(
        *,
        events=None,
        tasks=None,
        summaries=None,
        delete_rowcount: int = 0,
    ) -> list:
        monkeypatch.setattr(dc, "get_token_events_for_day", _reader(events))
        monkeypatch.setattr(dc, "get_completed_tasks_for_day", _reader(tasks))
        _FakeSummaryTokenizer.records = (
            [] if isinstance(summaries, Exception) else list(summaries or [])
        )
        _FakeSummaryTokenizer.error = (
            summaries if isinstance(summaries, Exception) else None
        )
        monkeypatch.setattr(st, "SummaryTokenizer", _FakeSummaryTokenizer)

        monkeypatch.setattr(
            ser, "get_conn", lambda: _RecordingConn(calls, delete_rowcount)
        )
        # execute_batch would need a real cursor (it mogrifies); record the
        # insert as one opaque step instead — the assertions are about which
        # statements are issued, not about the INSERT's text.
        monkeypatch.setattr(
            psycopg2.extras,
            "execute_batch",
            lambda cur, sql, rows, **_kw: calls.append(("INSERT_BATCH", list(rows))),
        )
        return calls

    return _setup


def _deletes(calls: list) -> list:
    return [c for c in calls if c[0].startswith("DELETE FROM hbpe.token_stream")]


def _inserts(calls: list) -> list:
    return [c for c in calls if c[0] == "INSERT_BATCH"]


# ── The emptying direction ────────────────────────────────────────────────────


def test_day_that_yields_no_tokens_deletes_its_stale_rows(wired):
    """A day whose sources all read clean-and-empty must be cleared, not skipped."""
    calls = wired(events=[], tasks=[], summaries=[], delete_rowcount=42)

    assert ser.TokenSerializer().serialize_day(USER, DATE) == 0

    deletes = _deletes(calls)
    assert len(deletes) == 1, f"expected exactly one DELETE, got {calls}"
    assert deletes[0][1] == [USER, DATE]
    assert _inserts(calls) == [], "an empty day must not insert SOD/EOD"


def test_empty_day_after_a_failed_summary_read_keeps_its_rows(wired):
    """
    A swallowed summary-read failure looks exactly like an empty day.

    Deleting on it would let one DB blip wipe a good summary-only day, so
    serialize_day must issue no SQL at all and let the next clean run converge.
    """
    calls = wired(events=[], tasks=[], summaries=RuntimeError("summary read blew up"))

    assert ser.TokenSerializer().serialize_day(USER, DATE) == 0
    assert calls == [], f"an incomplete read must issue no SQL, got {calls}"


def test_empty_day_after_a_failed_task_read_keeps_its_rows(wired):
    """Same guard for the other non-fatal source: completed tasks."""
    calls = wired(events=[], tasks=RuntimeError("ci.tasks unreachable"), summaries=[])

    assert ser.TokenSerializer().serialize_day(USER, DATE) == 0
    assert calls == [], f"an incomplete read must issue no SQL, got {calls}"


def test_failed_event_read_aborts_the_day_without_touching_the_stream(wired):
    """
    get_token_events_for_day raises rather than returning [], and that has to
    stay true: it is the only source whose emptiness is trustworthy.
    """
    calls = wired(events=RuntimeError("events unreachable"), tasks=[], summaries=[])

    with pytest.raises(RuntimeError):
        ser.TokenSerializer().serialize_day(USER, DATE)
    assert calls == []


# ── The non-empty direction (unchanged behaviour) ─────────────────────────────


def test_day_with_tokens_still_deletes_then_reinserts(wired):
    """The rewrite path is unchanged: DELETE first, then the insert batch."""
    calls = wired(events=[_event(0.0), _event(600.0)], tasks=[], summaries=[])

    written = ser.TokenSerializer().serialize_day(USER, DATE)

    assert written > 2, "expected SOD + event tokens + EOD"
    assert [c[0] for c in calls][:1] == [
        "DELETE FROM hbpe.token_stream WHERE user_id = %s AND date = %s"
    ]
    inserts = _inserts(calls)
    assert len(inserts) == 1
    assert len(inserts[0][1]) == written
    # SOD leads and EOD trails, at seq_order 0 and written-1.
    assert inserts[0][1][0][4] == "SOD"
    assert inserts[0][1][-1][4] == "EOD"


def test_task_read_failure_stays_non_fatal_when_the_day_has_events(wired):
    """
    Moving the completed-task swallow out of data_client must not make a task
    read failure fatal — the day still serializes the events it did read.
    """
    calls = wired(
        events=[_event(0.0)], tasks=RuntimeError("ci.tasks unreachable"), summaries=[]
    )

    written = ser.TokenSerializer().serialize_day(USER, DATE)

    assert written > 2
    assert len(_deletes(calls)) == 1
    assert len(_inserts(calls)) == 1


def test_re_serializing_an_unchanged_day_writes_the_same_row_count(wired):
    """Idempotence in the unchanged direction, the property #2482 relies on."""
    wired(events=[_event(0.0), _event(600.0)], tasks=[], summaries=[])

    first = ser.TokenSerializer().serialize_day(USER, DATE)
    second = ser.TokenSerializer().serialize_day(USER, DATE)

    assert first == second and first > 2


# ── require_complete: a day rewritten once ────────────────────────────────────


@pytest.mark.parametrize(
    "failing",
    [
        {"tasks": RuntimeError("ci.tasks unreachable"), "summaries": []},
        {"tasks": [], "summaries": RuntimeError("summary read blew up")},
    ],
    ids=["task read failed", "summary read failed"],
)
def test_require_complete_keeps_the_stored_rows_on_any_incomplete_read(wired, failing):
    """
    The default writes a partial read when it found something: right for a day
    the nightly rewrites again tomorrow. reserialize_queue.drain rewrites a day
    outside the budget once, so it asks for a complete read instead. A refused
    read issues no SQL at all, which leaves the stored rows in place and the
    queue row for the next night.
    """
    calls = wired(events=[_event(0.0)], **failing)

    assert ser.TokenSerializer().serialize_day(USER, DATE, require_complete=True) == 0
    assert calls == [], f"a refused read must issue no SQL, got {calls}"

    # The same read without the flag is the unchanged default: written.
    assert ser.TokenSerializer().serialize_day(USER, DATE) > 2
    assert len(_inserts(calls)) == 1


def test_require_complete_changes_nothing_when_the_read_is_complete(wired):
    calls = wired(events=[_event(0.0), _event(600.0)], tasks=[], summaries=[])

    written = ser.TokenSerializer().serialize_day(USER, DATE, require_complete=True)

    assert written > 2
    assert len(_deletes(calls)) == 1
    assert len(_inserts(calls)) == 1
