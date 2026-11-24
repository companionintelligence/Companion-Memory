"""
Unit tests for the re-serialize queue (ci.hbpe.pipeline.reserialize_queue) and
for how bootstrap.serialize_token_stream drains it.

Context: hbpe.token_stream is written only by TokenSerializer.serialize_day, and
the nightly writes only the days bootstrap.token_source_days lists: the content
budget plus the purge tier. A day older than the budget that still has a source
is in neither. Before the queue, a change to such a day (a soft-delete, a
cancellation, an edit) never reached the token stream that recurrence, seasonal
and HMT training read, because the ingester re-serialized today alone.

These tests pin the queue's contract:

  * what the drain does with each queued day (settle it, rewrite it, defer it),
    its cap and its order, and that only a rewrite that landed consumes a row;
  * that a row queued again while a run is in flight survives that run, which is
    what the snapshot taken BEFORE the pass and the queued_at match buy;
  * that a repeat enqueue bumps queued_at, which the match depends on;
  * deploy skew: with the table missing, nothing is lost but the queue itself.

Everything runs against a fake connection that interprets the queue's SQL. The
ON CONFLICT action and the consume predicate are read off the statement, not
assumed, so a production query that stops doing either goes red here. The fake
serializer follows serialize_day's contract, including the incomplete read.
No Postgres.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path

import psycopg2.errors
import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import database as db  # noqa: E402
from ci.hbpe.pipeline import bootstrap as bs  # noqa: E402
from ci.hbpe.pipeline import reserialize_queue as rq  # noqa: E402

UTC = dt.UTC
USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"
TODAY = dt.date(2026, 10, 1)
# Older than any 91-day budget ending at TODAY, so only the queue can reach it.
FROZEN = dt.date(2026, 3, 2)


def _days_back(end: dt.date, n: int) -> list[dt.date]:
    return [end - dt.timedelta(days=i) for i in range(n)]


# ── Fakes ──────────────────────────────────────────────────────────────────────


class _QueueDb:
    """
    In-memory hbpe.reserialize_days, plus the set of days that hold
    hbpe.token_stream rows per user.

    Each statement is recognised by its table and verb and then INTERPRETED:
    the enqueue's conflict action and the consume's ``queued_at`` match are read
    off the SQL. An unrecognised statement fails the test, so a new query
    against these tables cannot slip past the fake unmodelled.
    """

    def __init__(self, *, token_days=(), exists: bool = True) -> None:
        self.rows: dict[tuple[str, dt.date], dict] = {}
        self.token_days: dict[str, set[dt.date]] = {USER: set(token_days)}
        self.exists = exists
        self.log: list[str] = []
        self.fail_held = False
        self._tick = 0

    def queued(self, user: str = USER) -> list[dt.date]:
        return sorted(d for (u, d) in self.rows if u == user)

    def stamp(self, day: dt.date, user: str = USER):
        return self.rows[(user, day)]["queued_at"]

    def _now(self) -> dt.datetime:
        # Strictly increasing, like now() across separate transactions.
        self._tick += 1
        return dt.datetime(2026, 10, 1, 2, 0, tzinfo=UTC) + dt.timedelta(
            microseconds=self._tick
        )

    def execute(self, sql: str, params) -> tuple[list, int]:
        flat = " ".join(sql.split())
        if not self.exists and "hbpe.reserialize_days" in flat:
            raise psycopg2.errors.UndefinedTable(
                'relation "hbpe.reserialize_days" does not exist'
            )

        if flat.startswith("INSERT INTO hbpe.reserialize_days"):
            self.log.append("enqueue")
            user, reason, days = params
            for day in days:
                key = (user, day)
                if key not in self.rows:
                    self.rows[key] = {"reason": reason, "queued_at": self._now()}
                elif "DO UPDATE" in flat:
                    if "queued_at = EXCLUDED.queued_at" in flat:
                        self.rows[key]["queued_at"] = self._now()
                    if "reason = EXCLUDED.reason" in flat:
                        self.rows[key]["reason"] = reason
                elif "DO NOTHING" not in flat:
                    raise psycopg2.errors.UniqueViolation("duplicate key")
            return [], len(days)

        if flat.startswith("SELECT date, queued_at FROM hbpe.reserialize_days"):
            self.log.append("snapshot")
            (user,) = params
            rows = [(d, r["queued_at"]) for (u, d), r in self.rows.items() if u == user]
            return rows, len(rows)

        if "FROM hbpe.token_stream" in flat and "= ANY(" in flat:
            self.log.append("held")
            if self.fail_held:
                raise RuntimeError("token_stream unreadable")
            user, days = params
            held = sorted(set(days) & self.token_days.get(user, set()))
            return [(d,) for d in held], len(held)

        if flat.startswith("DELETE FROM hbpe.reserialize_days"):
            self.log.append("consume")
            days, stamps, user = params
            guarded = "q.queued_at = done.queued_at" in flat
            gone = 0
            for day, stamp in zip(days, stamps, strict=True):
                row = self.rows.get((user, day))
                if row is not None and (not guarded or row["queued_at"] == stamp):
                    del self.rows[(user, day)]
                    gone += 1
            return [], gone

        raise AssertionError(f"_QueueDb does not model this statement: {flat[:120]}")


class _Cursor:
    def __init__(self, db_: _QueueDb) -> None:
        self._db = db_
        self._rows: list = []
        self.rowcount = -1

    def execute(self, sql, params=None):
        self._rows, self.rowcount = self._db.execute(sql, tuple(params or ()))

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, db_: _QueueDb) -> None:
        self._db = db_

    def cursor(self, **_kw):
        return _Cursor(self._db)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Serializer:
    """
    serialize_day's contract, against ``_QueueDb.token_days``:

      * a complete read rewrites the day — its rows if it yields any, none if
        it yields nothing (the DELETE runs either way);
      * an incomplete read that found nothing keeps the stored rows;
      * an incomplete read that found something writes it anyway, unless
        ``require_complete``, which keeps the stored rows instead.

    ``partial`` records every day a partial read was written to: the outcome
    ``require_complete`` exists to prevent on a day nothing rewrites again.
    """

    def __init__(
        self,
        db_: _QueueDb,
        *,
        yields: dict[dt.date, int] | None = None,
        incomplete=(),
        raises=(),
        on_call=None,
    ) -> None:
        self._db = db_
        self._yields = yields or {}
        self._incomplete = set(incomplete)
        self._raises = set(raises)
        self._on_call = on_call
        self.calls: list[tuple[dt.date, bool]] = []
        self.partial: list[dt.date] = []

    def serialize_day(self, user_id, date_str, *, require_complete=False):
        day = dt.date.fromisoformat(str(date_str))
        self.calls.append((day, require_complete))
        self._db.log.append(f"serialize:{day.isoformat()}")
        if self._on_call is not None:
            self._on_call(day)
        if day in self._raises:
            raise RuntimeError("serializer blew up")
        n = self._yields.get(day, 7)
        held = self._db.token_days.setdefault(user_id, set())
        if day in self._incomplete:
            if require_complete or n == 0:
                return 0
            self.partial.append(day)
        if n:
            held.add(day)
        else:
            held.discard(day)
        return n


@pytest.fixture
def qdb(monkeypatch) -> _QueueDb:
    """A queue database every reserialize_queue call goes to."""
    queue_db = _QueueDb()
    monkeypatch.setattr(db, "get_conn", lambda: _Conn(queue_db))
    return queue_db


def _drain(qdb_: _QueueDb, serializer, *, visited=(), cap=bs.RESERIALIZE_DAY_CAP):
    """One drain the way serialize_token_stream runs it: snapshot, then drain."""
    snapshot = rq.snapshot(USER)
    assert snapshot is not None
    return rq.drain(
        USER,
        snapshot,
        visited=set(visited),
        today=TODAY,
        cap=cap,
        serializer=serializer,
    )


# ── What the drain does with a queued day ─────────────────────────────────────


def test_a_frozen_day_on_the_queue_is_rewritten_and_consumed(qdb):
    """
    THE FIX. FROZEN is older than the budget and still has a source, so neither
    the content tiers nor the purge tier will visit it again. A notification
    named it; the drain rewrites it once and the row is gone.
    """
    qdb.token_days[USER] = {FROZEN}
    rq.enqueue(USER, [FROZEN])
    serializer = _Serializer(qdb)

    stats = _drain(qdb, serializer)

    assert serializer.calls == [(FROZEN, True)]
    assert qdb.queued() == []
    assert stats["serialized"] == 1
    assert stats["rows"] == 7


def test_a_queued_day_the_pass_visited_is_consumed_without_a_second_visit(qdb):
    """
    Most queued days are inside the budget, and the pass just rewrote them.
    The pass read their sources after the snapshot, so the change is in what it
    wrote: rewriting them again would double the night's work for nothing.
    """
    content = _days_back(TODAY, 91)
    qdb.token_days[USER] = set(content)
    rq.enqueue(USER, content[:30])
    serializer = _Serializer(qdb)

    stats = _drain(qdb, serializer, visited=content)

    assert serializer.calls == []
    assert qdb.queued() == []
    assert stats["settled"] == 30


def test_a_queued_day_with_no_token_rows_is_consumed_without_a_visit(qdb):
    """
    The drain corrects stale rows; it does not extend the token stream. A day
    that was never serialized (an import into 2019, say) has nothing stale on
    it, and writing it would serialize a day outside the budget for the first
    time, which only bootstrap.token_source_days decides.
    """
    never = dt.date(2019, 5, 4)
    rq.enqueue(USER, [never])
    serializer = _Serializer(qdb)

    _drain(qdb, serializer)

    assert serializer.calls == []
    assert qdb.queued() == []
    assert never not in qdb.token_days[USER]


def test_a_queued_day_after_today_is_never_written(qdb):
    """
    The day list clamps at today because a serialized future day is work no
    reader ever reaches; the drain must not reopen that through the queue.
    """
    future = TODAY + dt.timedelta(days=3)
    qdb.token_days[USER] = {future}
    rq.enqueue(USER, [future])
    serializer = _Serializer(qdb)

    _drain(qdb, serializer)

    assert serializer.calls == []
    assert qdb.queued() == []


def test_a_day_that_empties_out_is_rewritten_to_nothing_and_consumed(qdb):
    """
    serialize_day returns 0 for a day that now yields nothing; its DELETE has
    still run. That zero is a landed rewrite, unlike the refused read below,
    and the row has to go.
    """
    qdb.token_days[USER] = {FROZEN}
    rq.enqueue(USER, [FROZEN])
    serializer = _Serializer(qdb, yields={FROZEN: 0})

    stats = _drain(qdb, serializer)

    assert FROZEN not in qdb.token_days[USER]
    assert qdb.queued() == []
    assert stats["serialized"] == 1
    assert stats["failed"] == 0


# ── Only a landed rewrite consumes a row ──────────────────────────────────────


def test_a_rewrite_that_raises_stays_queued_and_the_rest_carry_on(qdb):
    older = FROZEN - dt.timedelta(days=10)
    qdb.token_days[USER] = {FROZEN, older}
    rq.enqueue(USER, [FROZEN, older])
    serializer = _Serializer(qdb, raises={FROZEN})

    stats = _drain(qdb, serializer)

    assert [day for day, _ in serializer.calls] == [FROZEN, older]
    assert qdb.queued() == [FROZEN]
    assert stats["failed"] == 1
    assert stats["serialized"] == 1


def test_an_incomplete_read_stays_queued_and_is_never_written_partially(qdb):
    """
    A day the nightly rewrites every night can afford serialize_day's default
    (write a partial read; tomorrow fixes it). A day the drain rewrites cannot:
    nothing rewrites it again until it changes, so the summary tokens a failed
    summary read dropped would be gone for good. The drain asks for a complete
    read, keeps the stored rows when it is refused, and retries next night.
    """
    qdb.token_days[USER] = {FROZEN}
    rq.enqueue(USER, [FROZEN])
    serializer = _Serializer(qdb, incomplete={FROZEN})

    stats = _drain(qdb, serializer)

    assert serializer.partial == []
    assert FROZEN in qdb.token_days[USER]
    assert qdb.queued() == [FROZEN]
    assert stats["failed"] == 1


# ── Cap, order, convergence ───────────────────────────────────────────────────


def test_the_drain_rewrites_newest_first_and_defers_past_its_cap(qdb):
    """
    Newest first, like the purge tier: recurrence reads the last 180 days of
    hbpe.token_stream, so the stale days nearest the live window are the ones
    a forecast reads. The rest wait, still queued.
    """
    frozen = _days_back(FROZEN, 5)
    qdb.token_days[USER] = set(frozen)
    rq.enqueue(USER, frozen)
    serializer = _Serializer(qdb)

    stats = _drain(qdb, serializer, cap=2)

    assert [day for day, _ in serializer.calls] == frozen[:2]
    assert qdb.queued() == sorted(frozen[2:])
    assert stats["deferred"] == 3


def test_a_backlog_converges_one_cap_a_night_and_each_day_is_rewritten_once(qdb):
    """
    Rewriting a day never queues it again, so a backlog shrinks by the cap
    every night and then stays empty: no day is visited twice, and a night
    with nothing queued costs nothing.
    """
    frozen = _days_back(FROZEN, 7)
    qdb.token_days[USER] = set(frozen)
    rq.enqueue(USER, frozen)
    serializer = _Serializer(qdb)

    nights = 0
    while qdb.queued():
        _drain(qdb, serializer, cap=3)
        nights += 1
        assert nights <= 3

    assert nights == 3
    assert sorted(day for day, _ in serializer.calls) == sorted(frozen)
    _drain(qdb, serializer, cap=3)
    assert len(serializer.calls) == len(frozen)


def test_the_drain_cap_is_a_budget_of_its_own_the_size_of_the_content_budget():
    """
    On top of the content budget and the purge tier, not carved out of either:
    a burst of edits to old days must not evict real days for the night, and a
    bulk edit must not make one night unbounded.
    """
    assert bs.RESERIALIZE_DAY_CAP == bs.SERIALIZE_WINDOW_DAYS + 1


# ── A row queued again mid-run survives the run ───────────────────────────────


def test_a_day_queued_again_during_its_rewrite_survives_for_the_next_night(qdb):
    """
    A notification can land while the drain is rewriting the very day it names.
    The rewrite read its sources before that change, so consuming the row would
    lose it. The repeat enqueue bumps queued_at, and the drain consumes a row
    only while queued_at is still the value it read.
    """
    qdb.token_days[USER] = {FROZEN}
    rq.enqueue(USER, [FROZEN])
    read_at = qdb.stamp(FROZEN)

    def notified_mid_rewrite(day):
        rq.enqueue(USER, [day])

    _drain(qdb, _Serializer(qdb, on_call=notified_mid_rewrite))

    assert qdb.queued() == [FROZEN]
    assert qdb.stamp(FROZEN) > read_at


def test_a_repeat_enqueue_bumps_queued_at_and_keeps_one_row(qdb):
    """
    The consume guard above is only as good as this: a conflict that left the
    row alone (ON CONFLICT DO NOTHING) would keep the old queued_at, and the
    drain would delete a change it never read.
    """
    rq.enqueue(USER, [FROZEN], reason="did_not_happen")
    first = qdb.stamp(FROZEN)

    rq.enqueue(USER, [FROZEN])

    assert qdb.queued() == [FROZEN]
    assert qdb.stamp(FROZEN) > first
    assert qdb.rows[(USER, FROZEN)]["reason"] == rq.REASON_EVENT_CHANGED


# ── Deploy skew: the table may not exist yet ──────────────────────────────────


def test_a_missing_table_is_no_queue_not_an_error(monkeypatch):
    """
    HBPE ships as its own image and can run before the API migration that
    creates the table. Enqueue reports it and drops the request; the snapshot
    reports "no queue". Nothing raises.
    """
    absent = _QueueDb(exists=False)
    monkeypatch.setattr(db, "get_conn", lambda: _Conn(absent))

    assert rq.enqueue(USER, [FROZEN]) is False
    assert rq.snapshot(USER) is None


# ── Wiring: serialize_token_stream ────────────────────────────────────────────


def _serialize(monkeypatch, qdb_: _QueueDb, serializer, *, content, purge=()):
    """
    Run serialize_token_stream with the day list pinned, against ``qdb_``.

    The day list's own policy is pinned in test_label_drain.py against a fake
    that interprets that query; here it is a fixed answer, so what is under
    test is the order of the steps and the queue's part in them.
    """
    import ci.hbpe.pipeline.token_rollup as tr
    import ci.hbpe.tokenizer.serializer as ser

    def _day_list(user_id, window_days, today):
        qdb_.log.append("day_list")
        return sorted(content), sorted(purge)

    def _rollups(_uid):
        qdb_.log.append("rollup")
        return {"days": 0}

    monkeypatch.setattr(bs, "_utc_today", lambda: TODAY)
    monkeypatch.setattr(bs, "_token_source_rows", _day_list)
    monkeypatch.setattr(bs, "event_date_bounds", lambda _uid: None)
    monkeypatch.setattr(ser, "TokenSerializer", lambda: serializer)
    monkeypatch.setattr(tr, "rebuild_token_rollups", _rollups)
    return asyncio.run(bs.serialize_token_stream(USER))


def test_the_queue_is_read_before_the_day_list_and_drained_before_the_rollups(
    monkeypatch, qdb
):
    """
    Snapshot, then the pass, then the drain, then the rollups. The rollups have
    to see what the drain rewrote; the snapshot's position is the subject of
    the next test.
    """
    content = _days_back(TODAY, 3)
    qdb.token_days[USER] = {*content, FROZEN}
    rq.enqueue(USER, [FROZEN])
    qdb.log.clear()
    serializer = _Serializer(qdb)

    result = _serialize(monkeypatch, qdb, serializer, content=content)

    assert qdb.log == [
        "snapshot",
        "day_list",
        *(f"serialize:{d.isoformat()}" for d in sorted(content)),
        "held",
        f"serialize:{FROZEN.isoformat()}",
        "consume",
        "rollup",
    ]
    assert result["rows"] == 3 * 7  # the budget's rows, not the queue's
    assert result["reserialize_queue"] == {
        "status": "ok",
        "queued": 1,
        "serialized": 1,
        "rows": 7,
        "settled": 0,
        "deferred": 0,
        "failed": 0,
    }
    assert qdb.queued() == []


def test_a_day_queued_after_the_pass_rewrote_it_is_kept_for_the_next_night(
    monkeypatch, qdb
):
    """
    Why the snapshot comes BEFORE the pass. The pass rewrites a content day,
    and only then does a notification for that day arrive. The pass's read
    predates the change. Snapshotted after the pass, the new row would count
    as visited and be consumed, and the change would be lost on the night the
    day ages out of the budget. Snapshotted before, the row is simply not in
    this run's snapshot.
    """
    content = _days_back(TODAY, 3)
    edited = content[1]
    qdb.token_days[USER] = set(content)
    rewritten = set()

    def notified_after_the_pass_read_it(day):
        if day == edited and day not in rewritten:
            rewritten.add(day)
            rq.enqueue(USER, [day])

    serializer = _Serializer(qdb, on_call=notified_after_the_pass_read_it)

    _serialize(monkeypatch, qdb, serializer, content=content)

    assert qdb.queued() == [edited]


def test_a_queued_day_the_pass_visits_is_rewritten_once(monkeypatch, qdb):
    content = _days_back(TODAY, 3)
    qdb.token_days[USER] = set(content)
    rq.enqueue(USER, content)
    serializer = _Serializer(qdb)

    result = _serialize(monkeypatch, qdb, serializer, content=content)

    assert sorted(day for day, _ in serializer.calls) == sorted(content)
    assert result["reserialize_queue"]["settled"] == 3
    assert qdb.queued() == []


def test_serialize_runs_unchanged_while_the_table_is_missing(monkeypatch):
    """Deploy skew must cost the queue and nothing else."""
    absent = _QueueDb(exists=False)
    monkeypatch.setattr(db, "get_conn", lambda: _Conn(absent))
    content = _days_back(TODAY, 3)
    serializer = _Serializer(absent)

    result = _serialize(monkeypatch, absent, serializer, content=content)

    assert [day for day, _ in serializer.calls] == sorted(content)
    assert result["rows"] == 3 * 7
    assert result["reserialize_queue"] == {"status": "unavailable"}


def test_a_failing_drain_never_fails_the_serialize_step(monkeypatch, qdb):
    """
    The pass has already published the budget by the time the drain runs. A
    raise here would mark serialize as failed, and bootstrap aborts a cold
    start on that, over work that is purely additive. The rows stay queued.
    """
    content = _days_back(TODAY, 3)
    qdb.token_days[USER] = {*content, FROZEN}
    rq.enqueue(USER, [FROZEN])
    qdb.fail_held = True

    result = _serialize(monkeypatch, qdb, _Serializer(qdb), content=content)

    assert result["rows"] == 3 * 7
    assert result["reserialize_queue"]["status"] == "error"
    assert qdb.queued() == [FROZEN]


def test_an_emptied_corpus_still_consumes_its_queue(monkeypatch, qdb):
    """
    With no day to serialize there is no token row at or before today (the
    purge tier would have listed it), so every queued row is settled. Leaving
    them would park dead rows for a user whose corpus emptied, forever.
    """
    rq.enqueue(USER, [FROZEN, FROZEN - dt.timedelta(days=1)])
    serializer = _Serializer(qdb)

    result = _serialize(monkeypatch, qdb, serializer, content=[])

    assert result["rows"] == 0
    assert result["reason"] == "no_events"
    assert serializer.calls == []
    assert qdb.queued() == []
