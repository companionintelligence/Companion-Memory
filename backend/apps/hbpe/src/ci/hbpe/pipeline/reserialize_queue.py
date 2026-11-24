"""
hbpe.reserialize_days — days HBPE has to re-serialize outside its nightly budget.

The nightly serialize step rewrites only the days ``bootstrap.token_source_days``
selects: the newest ``SERIALIZE_WINDOW_DAYS + 1`` days that hold an event or an
hourly summary, plus source-less days that still hold token rows. Every other
day keeps the hbpe.token_stream rows that the last run to select it wrote. On a
running appliance that is most of the table: a day leaves the content budget as
newer days-with-data arrive, and it is not purged, because it still has a
source. pipeline.recurrence reads 180 days of the table, pipeline.seasonal 800,
and HMT training every row. The ingester rewrites today and nothing else. So
before this queue, a change to an older day (a soft-delete, a cancellation, an
edit) reached none of them.

This module is the queue that closes that gap. Both ends follow these rules:

* The producer is ``ingester.EventIngester``. A ``ci_events`` notification for
  a day before today is upserted here, keyed ``(user_id, date)``. A repeat bumps
  ``queued_at`` and never adds a row.
* The consumer is ``bootstrap.serialize_token_stream``, once per run, after its
  own pass over the day list. ``drain`` re-serializes the queued days that pass
  did not visit and that still hold token rows: newest first, at most ``cap``
  of them. A queued day the pass did visit, or one with no token rows, needs no
  visit, and its row is simply consumed.

A row is consumed only in the version the run read. The run snapshots the queue
BEFORE its pass, and ``_consume`` deletes a row only while ``queued_at`` still
equals the snapshot's value, so a notification that lands mid-run survives to
the next run. The snapshot also orders the reads. Every change behind a
snapshotted row committed before the snapshot: the API notifies after its
commit, and the ingester enqueues after the notification. Every serialize_day
in the run reads its sources after the snapshot. So whichever of the pass or
the drain settles a row has already seen the change behind it.

The queue converges. Rows come only from notifications, which are real changes,
and from the migration's one-time seed. Re-serializing a day never queues it
again: serialize_day notifies nobody, and the ingester's safety poll, which does
see the rewrite, only invalidates the cache. So the queue drains to empty
whenever fewer than ``cap`` new days are queued per night.

The table is created by an API migration, but HBPE ships as its own image and
can run before that migration has. Every function here therefore treats a
missing table as "no queue": the ingester drops the request, as it did before
the queue existed, and the nightly skips the drain.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import date, datetime
from typing import Protocol

log = logging.getLogger(__name__)

# What a notification is queued for. The migration's seed writes its own.
REASON_EVENT_CHANGED = "event_changed"

# A repeat notification bumps queued_at rather than leaving the row alone. That
# bump is what lets _consume tell a row the drain settled from one re-queued
# while the drain was running: DO NOTHING here would let the drain delete a
# change it never read.
_ENQUEUE_SQL = """
    INSERT INTO hbpe.reserialize_days (user_id, date, reason)
    SELECT %s::uuid, d, %s
    FROM unnest(%s::date[]) AS d
    ON CONFLICT (user_id, date) DO UPDATE
        SET queued_at = EXCLUDED.queued_at,
            reason    = EXCLUDED.reason
"""

_SNAPSHOT_SQL = """
    SELECT date, queued_at
    FROM hbpe.reserialize_days
    WHERE user_id = %s::uuid
"""

_HELD_DAYS_SQL = """
    SELECT DISTINCT ts.date
    FROM hbpe.token_stream ts
    WHERE ts.user_id = %s::uuid
      AND ts.date = ANY(%s::date[])
"""

# Matched on queued_at as well as the key: a row re-queued after the snapshot
# carries a newer queued_at and is left for the next run.
_CONSUME_SQL = """
    DELETE FROM hbpe.reserialize_days q
    USING unnest(%s::date[], %s::timestamptz[]) AS done(date, queued_at)
    WHERE q.user_id = %s::uuid
      AND q.date = done.date
      AND q.queued_at = done.queued_at
"""

_absent_logged = False


def _note_absent(caller: str) -> None:
    """Say once per process that the queue table is missing, then go quiet."""
    global _absent_logged
    level = logging.DEBUG if _absent_logged else logging.WARNING
    _absent_logged = True
    log.log(
        level,
        "hbpe.reserialize_days does not exist yet (%s): the API migration that "
        "creates it has not run, so days outside the serialize budget are not "
        "re-serialized until it does",
        caller,
    )


def enqueue(
    user_id: str, days: Iterable[date], reason: str = REASON_EVENT_CHANGED
) -> bool:
    """
    Queue ``days`` for the next nightly drain. False when the table is missing.

    Any other failure raises: the caller decides whether a lost request is
    worth more than a log line.
    """
    import psycopg2.errors

    from ci.hbpe.database import get_conn

    wanted = sorted(set(days))
    if not wanted:
        return True
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_ENQUEUE_SQL, (user_id, reason, wanted))
    except psycopg2.errors.UndefinedTable:
        _note_absent("enqueue")
        return False
    return True


def snapshot(user_id: str) -> dict[date, datetime] | None:
    """
    This user's queued days, each with the ``queued_at`` it was read at, or None
    when the table is missing. Read BEFORE the night's serialize pass; the
    module docstring says why the order matters.
    """
    import psycopg2.errors

    from ci.hbpe.database import get_conn

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_SNAPSHOT_SQL, (user_id,))
                rows = cur.fetchall()
    except psycopg2.errors.UndefinedTable:
        _note_absent("drain")
        return None
    return {date.fromisoformat(str(day)): queued_at for day, queued_at in rows}


def _held_days(user_id: str, days: list[date]) -> set[date]:
    """The subset of ``days`` that hold at least one hbpe.token_stream row."""
    if not days:
        return set()
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_HELD_DAYS_SQL, (user_id, days))
            return {date.fromisoformat(str(row[0])) for row in cur.fetchall()}


def _consume(user_id: str, settled: dict[date, datetime]) -> int:
    """Delete the settled rows that still carry the queued_at the run read."""
    if not settled:
        return 0
    from ci.hbpe.database import get_conn

    days = sorted(settled)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_CONSUME_SQL, (days, [settled[d] for d in days], user_id))
            return int(cur.rowcount)


class DaySerializer(Protocol):
    """The slice of tokenizer.serializer.TokenSerializer the drain uses."""

    def serialize_day(
        self, user_id: str, date: str, *, require_complete: bool = False
    ) -> int: ...


def drain(
    user_id: str,
    queued: dict[date, datetime],
    *,
    visited: set[date],
    today: date,
    cap: int,
    serializer: DaySerializer,
) -> dict[str, str | int]:
    """
    Re-serialize the queued days the night's pass did not reach, then consume
    every row this run settled.

    ``queued`` is the snapshot taken before the pass, and ``visited`` the days
    the pass rewrote. Each queued day lands in exactly one outcome:

      * visited by the pass: settled. The pass read its sources after the
        snapshot, so it saw the change.
      * no token rows, which includes every day after ``today``: settled. There
        is nothing stale to correct. Writing the day would serialize it for the
        first time, outside the budget, and only the day list decides that.
      * token rows, within ``cap``: re-serialized, and consumed once the rewrite
        has landed.
      * token rows, beyond ``cap``: deferred, still queued.

    Newest first, like the purge tier: recurrence reads the last 180 days of
    hbpe.token_stream and seasonal 800, so the stale days nearest the live
    window are the ones a forecast reads.

    A rewrite that raises, or whose read came back incomplete, stays queued for
    the next run. serialize_day is told to require a complete read: a day the
    drain rewrites is not rewritten again tomorrow, so a partial read written
    now would last until the day changed again.
    """
    serialized = rows = failed = 0
    if not queued:
        return _stats(0, serialized, rows, 0, 0, failed)

    unvisited = [d for d in queued if d not in visited and d <= today]
    work = sorted(_held_days(user_id, unvisited), reverse=True)
    batch = work[: max(cap, 0)]
    deferred = len(work) - len(batch)

    held = set(work)
    done = {d: queued_at for d, queued_at in queued.items() if d not in held}
    settled = len(done)

    for d in batch:
        try:
            n = serializer.serialize_day(user_id, d.isoformat(), require_complete=True)
        except Exception:
            log.exception(
                "Re-serialize of queued day failed for user=%s date=%s; left queued",
                user_id[:8],
                d,
            )
            failed += 1
            continue
        # serialize_day returns 0 both for a day that emptied out (its rows are
        # deleted) and for a read it refused to act on (its rows are kept). Only
        # the second leaves rows behind.
        if n == 0 and _held_days(user_id, [d]):
            failed += 1
            continue
        done[d] = queued[d]
        serialized += 1
        rows += n

    _consume(user_id, done)
    if batch or deferred:
        log.info(
            "Re-serialize queue for user=%s: %d rewritten, %d failed, %d deferred, "
            "%d settled without a visit",
            user_id[:8],
            serialized,
            failed,
            deferred,
            settled,
        )
    return _stats(len(queued), serialized, rows, settled, deferred, failed)


def _stats(
    queued: int, serialized: int, rows: int, settled: int, deferred: int, failed: int
) -> dict[str, str | int]:
    """What the nightly result reports for the drain."""
    return {
        "status": "ok",
        "queued": queued,
        "serialized": serialized,
        "rows": rows,
        "settled": settled,
        "deferred": deferred,
        "failed": failed,
    }
