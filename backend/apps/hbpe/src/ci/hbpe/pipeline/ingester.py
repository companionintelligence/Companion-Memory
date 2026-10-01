"""
Event stream ingester — async listener for new behavioral events (T4.3).

Listens to PostgreSQL LISTEN/NOTIFY channels for:
  • ci_events          — calendar/task events (API HbpeNotifyService)
  • ci_browser_activity — browser activity (API HbpeNotifyService)
  • ci_communications  — messages/emails (API HbpeNotifyService)

Producers are application code, not SQL triggers: CalendarEventService,
BrowserActivityService, and CommunicationService call pg_notify after
create/update/delete so the path is visible in API logs.

On notification:
  1. Parse the payload (JSON with user_id and date, a UTC day).
  2. Debounce: batch notifications arriving within DEBOUNCE_SEC seconds.
  3. Re-tokenise today right away. A ``ci_events`` notification for an earlier
     day goes on the re-serialize queue (hbpe.reserialize_days) instead, which
     the nightly serialize step drains: a day outside its budget is rewritten
     there, and one inside it is rewritten by the nightly pass anyway. See
     pipeline.reserialize_queue.
  4. Invalidate the InferenceEngine output-cache for that date.

Steps 3 and 4 are independent. Step 3 keeps HBPE's own output current and runs
for every user. Step 4 is skipped for a user this process holds no engine for:
engines are created on a user's first forecast request, so after a restart there
is often nothing to invalidate. It used to gate step 3 as well, so a change made
before a user's first forecast after a restart never reached the token stream.

Only the NOTIFY path re-tokenises or enqueues. The safety poll watches
``hbpe.token_stream`` — HBPE's own *output* — so a poll hit means a producer
(nightly, bootstrap, ``run_pipeline.py``) has already serialised that day, and
re-running the serialiser would recompute what was just written. Worse, it
would feed itself: ``serialize_day`` is a DELETE-then-INSERT and
``serialized_at`` defaults to ``NOW()``, so the rows it wrote satisfy the very
predicate the next poll uses (``serialized_at > watermark``) — detection
re-triggers the flush, which re-serialises, which re-triggers, once per poll
interval with no new source data. The poll therefore invalidates only; source
data arriving live still re-tokenises via NOTIFY. Enqueueing from the poll
would close the same loop a night at a time: every day the nightly drain
rewrites shows up in the next poll and would be queued for the next drain.

The ingester is started by the FastAPI lifespan handler and runs as a
background asyncio task.  Each HBPE process instance ingests for all
users whose channels it receives notifications on.

Implements T4.3 (CI-Server-32t).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, date, datetime, timedelta

log = logging.getLogger(__name__)

DEBOUNCE_SEC = 5.0
# Safety poll runs alongside the LISTEN path. Application pg_notify gives
# instant invalidation; this slower poll covers a dropped LISTEN connection
# or a producer that failed to notify.
SAFETY_POLL_SEC = 30.0
RECONNECT_SEC = 5.0
CHANNELS = ("ci_events", "ci_browser_activity", "ci_communications")

# The one channel whose notifications can change what the serializer writes for
# a past day. It reads ci.events and what hangs off an event (its labels, its
# linked content), completed ci.tasks and hourly ci.summaries; browser activity
# and communications feed none of those. Queuing their days would spend the
# nightly drain's cap on rewrites that come out identical, while a real change
# to an old day waited behind them.
REQUEUE_CHANNEL = "ci_events"

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


def _utc_today() -> date:
    """
    Today as the notification payload counts days: in UTC (HbpeNotifyService's
    ``utcDay``), as bootstrap does. ``date.today()`` is the host's local day, so
    on a host away from UTC it disagreed with every payload for part of each
    day. A named seam so tests can pin it.
    """
    return datetime.now(UTC).date()


def _past_days(date_strs: set[str], today: date) -> list[date]:
    """
    The notified days before ``today``, oldest first; anything unparseable is
    dropped.

    Only past days can need the queue. Today is rewritten right away, and a
    future day holds no tokens (the day list clamps at today), so queuing one
    would only make the nightly drain consume a row it can do nothing with.
    """
    days: set[date] = set()
    for date_str in date_strs:
        try:
            d = date.fromisoformat(date_str)
        except ValueError:
            log.warning("Bad date in notify payload: %s", date_str)
            continue
        if d < today:
            days.add(d)
    return sorted(days)


class EventIngester:
    """
    Subscribes to PostgreSQL NOTIFY channels. When new events arrive for a
    user it rewrites today's tokens, queues earlier days for the nightly
    drain, and invalidates the inference cache.

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
        # Subset of _pending whose source was a NOTIFY (i.e. new source data).
        # Only these may re-tokenise; poll hits are invalidate-only.
        self._notified: dict[str, set[str]] = {}
        # Subset of _notified that arrived on REQUEUE_CHANNEL: the only days
        # that may go on the re-serialize queue.
        self._requeue: dict[str, set[str]] = {}
        self._debounce_tasks: dict[str, asyncio.Task] = {}
        # asyncio holds only a weak reference to a running task, so a
        # fire-and-forget create_task() can be garbage collected mid-flight
        # and the work silently disappears. Hold a strong reference until
        # each one finishes.
        self._background_tasks: set[asyncio.Task] = set()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._listen_loop(), name="hbpe-ingester")
        log.info("EventIngester started — listening on %s", CHANNELS)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("EventIngester stopped")

    async def _listen_loop(self) -> None:
        """
        Main loop: subscribe to PostgreSQL LISTEN/NOTIFY via asyncpg and, in
        parallel, run a slow safety poll of hbpe.token_stream.

        Both paths reconnect on failure instead of dying, so a Postgres restart
        or a dropped LISTEN connection self-heals. If asyncpg is unavailable the
        loop degrades to polling only.
        """
        try:
            import asyncpg
        except ImportError:
            log.warning("asyncpg not installed — using polling ingester only")
            await self._polling_loop(DEBOUNCE_SEC)
            return

        await asyncio.gather(
            self._asyncpg_listen_forever(asyncpg),
            self._polling_loop(SAFETY_POLL_SEC),
        )

    async def _asyncpg_listen_forever(self, asyncpg) -> None:
        """Run the LISTEN loop, reconnecting after any connection failure."""
        while True:
            try:
                await self._asyncpg_loop(asyncpg)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception(
                    "asyncpg LISTEN connection dropped — reconnecting in %ss",
                    RECONNECT_SEC,
                )
                await asyncio.sleep(RECONNECT_SEC)

    async def _asyncpg_loop(self, asyncpg) -> None:
        from ci.hbpe.config import settings

        conn = await asyncpg.connect(settings.database_url)
        try:
            for ch in CHANNELS:
                await conn.add_listener(ch, self._on_notify)
            log.info("LISTEN active on: %s", ", ".join(CHANNELS))
            # Periodically check liveness so a server-side drop triggers a
            # reconnect instead of silently sleeping on a dead connection.
            while True:
                await asyncio.sleep(15)
                if conn.is_closed():
                    raise ConnectionError("asyncpg LISTEN connection closed")
        finally:
            if not conn.is_closed():
                await conn.close()

    async def _polling_loop(self, interval: float = DEBOUNCE_SEC) -> None:
        """
        Poll hbpe.token_stream for rows newer than the watermark and invalidate.

        Runs as a safety net alongside the LISTEN path (or as the sole path when
        asyncpg is unavailable): it covers a dropped LISTEN connection, a
        producer that failed to notify, and the out-of-process writers (nightly,
        bootstrap, run_pipeline.py) that never notify at all.

        Invalidate-only — see the module docstring for why re-tokenising here
        would feed itself.

        The watermark only ever advances to a ``serialized_at`` this loop has
        actually seen. Using the host clock instead (``datetime.utcnow()``) had
        two defects: it is naive, so Postgres reinterpreted it in the session
        time zone when comparing against a TIMESTAMPTZ column, and it was
        stamped after the query returned, so a producer committing in between
        was skipped for good.

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
                    self._dispatch(
                        str(row["user_id"]), str(row["date"]), from_notify=False
                    )
                    seen = row["last_serialized"]
                    if seen is not None and _as_utc(seen) > watermark:
                        watermark = _as_utc(seen)
            except Exception:
                log.exception("Polling ingester error")

    def _on_notify(self, _conn, _pid, channel: str, payload: str) -> None:
        """asyncpg notification callback (called from event loop)."""
        try:
            data = json.loads(payload)
            user_id = str(data.get("user_id", ""))
            date_str = str(data.get("date", ""))
            if user_id and date_str:
                self._dispatch(user_id, date_str, from_notify=True, channel=channel)
        except Exception as exc:
            log.warning("Notify parse error on %s: %s", channel, exc)

    def _dispatch(
        self,
        user_id: str,
        date_str: str,
        *,
        from_notify: bool,
        channel: str | None = None,
    ) -> None:
        """
        Schedule a debounced invalidation for (user_id, date).

        ``from_notify`` marks new *source* data, which is the only thing that
        may re-tokenise or enqueue. Poll hits describe token_stream writes that
        already happened, so they invalidate without re-serialising. ``channel``
        says which producer sent it; only REQUEUE_CHANNEL may enqueue.
        """
        if user_id not in self._pending:
            self._pending[user_id] = set()
        self._pending[user_id].add(date_str)

        if from_notify:
            self._notified.setdefault(user_id, set()).add(date_str)
            if channel == REQUEUE_CHANNEL:
                self._requeue.setdefault(user_id, set()).add(date_str)

        # Cancel any existing debounce timer for this user
        existing = self._debounce_tasks.get(user_id)
        if existing and not existing.done():
            existing.cancel()

        self._debounce_tasks[user_id] = asyncio.create_task(
            self._flush_after_debounce(user_id),
            name=f"debounce-{user_id[:8]}",
        )

    async def _flush_after_debounce(self, user_id: str) -> None:
        """
        Wait DEBOUNCE_SEC, then bring HBPE's output up to date for every pending
        date of this user, and invalidate the cache if there is one.
        """
        await asyncio.sleep(DEBOUNCE_SEC)
        dates = self._pending.pop(user_id, set())
        notified = self._notified.pop(user_id, set())
        requeue = self._requeue.pop(user_id, set())

        # The token stream first, and whether or not this process holds an
        # engine for the user: it is HBPE's own output, not a cache entry.
        #
        # Re-run serialisation for today to pick up the new token(s). Gated on
        # `notified`, not `dates`: a poll hit is token_stream reporting its own
        # contents back, and re-serialising it restamps serialized_at into the
        # next poll's window — a loop with no new source data behind it.
        today = _utc_today()
        if today.isoformat() in notified:
            self._spawn(self._reserialise(user_id, today), f"reserialise-{user_id[:8]}")
        # An earlier day is left to the nightly, through the queue. The nightly
        # pass rewrites it anyway if it is inside the budget; the queue is what
        # reaches it if it is not. Gated on `requeue`, a subset of `notified`,
        # for the same reason as above.
        older = _past_days(requeue, today)
        if older:
            self._spawn(self._enqueue(user_id, older), f"requeue-{user_id[:8]}")

        engine = self._registry.get(user_id)
        if engine is None:
            log.debug("No engine for user %s — skip invalidation", user_id[:8])
            return
        for date_str in dates:
            try:
                d = date.fromisoformat(date_str)
                engine.invalidate(d)
                log.info("Cache invalidated: user=%s date=%s", user_id[:8], d)
            except ValueError:
                log.warning("Bad date in notify payload: %s", date_str)

    def _spawn(self, coro, name: str) -> None:
        """Run ``coro`` in the background, holding a strong reference to it."""
        task = asyncio.create_task(coro, name=name)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def _enqueue(self, user_id: str, days: list[date]) -> None:
        """Put past days on hbpe.reserialize_days for the nightly drain."""

        def _run():
            from ci.hbpe.pipeline import reserialize_queue

            try:
                if reserialize_queue.enqueue(user_id, days):
                    log.info(
                        "Queued %d day(s) for re-serialization: user=%s %s..%s",
                        len(days),
                        user_id[:8],
                        days[0],
                        days[-1],
                    )
            except Exception:
                # Lost, exactly as an older day's change was before the queue
                # existed; the nightly still rewrites it if it is in the budget.
                log.exception(
                    "Re-serialize enqueue failed for user=%s (%d day(s))",
                    user_id[:8],
                    len(days),
                )

        await asyncio.get_running_loop().run_in_executor(None, _run)

    async def _reserialise(self, user_id: str, d: date) -> None:
        """Re-run the tokeniser pipeline for a single day in a thread."""

        def _run():
            try:
                from ci.hbpe.tokenizer.serializer import TokenSerializer

                ser = TokenSerializer()
                n = ser.serialize_day(user_id, d)
                log.info(
                    "Re-serialised %d tokens for user=%s date=%s", n, user_id[:8], d
                )
            except Exception:
                log.exception("Re-serialise failed for user=%s date=%s", user_id[:8], d)

        await asyncio.get_running_loop().run_in_executor(None, _run)
