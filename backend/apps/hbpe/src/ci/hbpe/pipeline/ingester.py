"""
Token-stream ingester — keeps this process's inference cache coherent (T4.3).

``hbpe.token_stream`` is HBPE's tokenised input. It is written by the nightly
pipeline, the bootstrap run and ``scripts/run_pipeline.py`` — none of which run
inside this process. When one of them re-serialises a day, this process's
InferenceEngine output cache for that day is stale. This ingester polls
``token_stream.serialized_at`` and evicts the affected ``(user, date)`` entries.

It is invalidation only. It never writes to ``token_stream``, so it can never
observe its own writes.

Why there is no LISTEN/NOTIFY
-----------------------------
An earlier revision opened a Postgres ``LISTEN`` on ``ci_events``,
``ci_browser_activity`` and ``ci_communications``, described as a real-time path
with this poll as a fallback. That was backwards: the poll was the only path
that ever ran. Nothing publishes to those channels — ``pg_notify`` appears
nowhere in this repository, and the entire migration history contains two
``CREATE TRIGGER`` statements, neither of them a notify. Two of the three
channels also name tables the tokeniser never reads: it reads ``ci.events``,
completed tasks and ``ci.summaries``, never ``ci.browser_activity`` or
``ci.communications``.

Per the [2026-08-07] decision in ``docs/architecture/hypertable-audit.md``
("no notify triggers, ever"), the repository stays trigger-free by design and
HBPE invalidation will be driven through the application event system
(EventService → PGBoss) when that wiring lands. The dormant LISTEN was retired
with that decision rather than left implying a capability that never existed.

Why there is no re-serialisation
--------------------------------
An earlier revision also re-ran ``TokenSerializer.serialize_day()`` for today
after invalidating. That was a self-feeding loop: ``serialize_day`` is a
DELETE-then-INSERT and ``token_stream.serialized_at`` defaults to ``NOW()``, so
the rows it wrote satisfied the very predicate the next poll used
(``serialized_at > last_check``). The flush re-triggered detection, which
re-serialised, which re-triggered — once per poll interval, forever, with no new
source data.

It was also redundant by construction: the poll fires *because* ``token_stream``
already changed, so a producer had just written the rows being recomputed.
Re-tokenising new source data intra-day is a real gap, but it belongs on the
producer side (a cron fan-out alongside ``hbpeNightly``, or the API calling
``POST /invalidate``), not in the consumer that watches the output table.

Implements T4.3 (CI-Server-32t).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta

log = logging.getLogger(__name__)

DEBOUNCE_SEC = 5.0
POLL_SEC = 30.0

# Grouped by (user, date) so one row carries the newest write for that day,
# which is what advances the watermark.
_POLL_SQL = """
    SELECT user_id::text        AS user_id,
           date::text           AS date,
           MAX(serialized_at)   AS last_serialized
    FROM hbpe.token_stream
    WHERE serialized_at > %s
    GROUP BY user_id, date
"""


def _as_utc(ts: datetime) -> datetime:
    """Treat a naive timestamp as UTC so watermark comparisons never raise."""
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


class EventIngester:
    """
    Polls ``hbpe.token_stream`` and evicts stale days from the inference cache.

    Usage (from FastAPI lifespan):
        ingester = EventIngester(engine_registry)
        await ingester.start()
        ...
        await ingester.stop()
    """

    def __init__(self, engine_registry: dict[str, InferenceEngine]) -> None:  # noqa: F821
        self._registry = engine_registry  # user_id → InferenceEngine
        self._task: asyncio.Task | None = None
        # Pending invalidations: user_id → {date_str}
        self._pending: dict[str, set[str]] = {}
        self._debounce_tasks: dict[str, asyncio.Task] = {}

    async def start(self) -> None:
        self._task = asyncio.create_task(self._polling_loop(), name="hbpe-ingester")
        log.info("EventIngester started — polling token_stream every %ss", POLL_SEC)

    async def stop(self) -> None:
        for task in list(self._debounce_tasks.values()):
            if not task.done():
                task.cancel()
        self._debounce_tasks.clear()

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("EventIngester stopped")

    async def _polling_loop(self, interval: float = POLL_SEC) -> None:
        """
        Poll for token_stream rows newer than the watermark and invalidate.

        The watermark only ever advances to a ``serialized_at`` this loop has
        actually seen. Using the host clock instead (the previous
        ``datetime.utcnow()``) had two defects: it is naive, so Postgres
        reinterpreted it in the session time zone when comparing against a
        TIMESTAMPTZ column, and it was stamped after the query returned, so a
        producer committing in between was skipped for good.

        Errors are logged and the loop continues; the connection pool recycles
        dead connections so a DB blip self-heals.
        """
        from ci.hbpe.database import get_conn

        watermark: datetime = datetime.now(UTC) - timedelta(hours=1)
        while True:
            await asyncio.sleep(interval)
            try:
                # `since` is bound as a default so the closure captures this
                # iteration's value rather than the loop variable.
                def _query(since=watermark):
                    import psycopg2.extras

                    with get_conn() as conn:
                        with conn.cursor(
                            cursor_factory=psycopg2.extras.RealDictCursor
                        ) as cur:
                            cur.execute(_POLL_SQL, (since,))
                            return cur.fetchall()

                rows = await asyncio.get_running_loop().run_in_executor(None, _query)
                for row in rows:
                    self._dispatch(str(row["user_id"]), str(row["date"]))
                    seen = row["last_serialized"]
                    if seen is not None and _as_utc(seen) > watermark:
                        watermark = _as_utc(seen)
            except Exception:
                log.exception("Token-stream poll failed")

    def _dispatch(self, user_id: str, date_str: str) -> None:
        """Schedule a debounced invalidation for (user_id, date)."""
        if user_id not in self._pending:
            self._pending[user_id] = set()
        self._pending[user_id].add(date_str)

        # Cancel any existing debounce timer for this user
        existing = self._debounce_tasks.get(user_id)
        if existing and not existing.done():
            existing.cancel()

        self._debounce_tasks[user_id] = asyncio.create_task(
            self._flush_after_debounce(user_id),
            name=f"debounce-{user_id[:8]}",
        )

    async def _flush_after_debounce(self, user_id: str) -> None:
        """Wait DEBOUNCE_SEC, then invalidate all pending dates for this user."""
        await asyncio.sleep(DEBOUNCE_SEC)
        dates = self._pending.pop(user_id, set())
        engine = self._registry.get(user_id)
        if engine is None:
            log.debug("No engine for user %s — skip invalidation", user_id[:8])
            return
        for date_str in dates:
            try:
                d = date.fromisoformat(date_str)
            except ValueError:
                log.warning("Bad date from token_stream poll: %s", date_str)
                continue
            engine.invalidate(d)
            log.info("Cache invalidated: user=%s date=%s", user_id[:8], d)
