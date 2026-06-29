"""
Event stream ingester — async listener for new behavioral events (T4.3).

Listens to PostgreSQL LISTEN/NOTIFY channels for:
  • ci_events          — calendar/task events (ci.events INSERT trigger)
  • ci_browser_activity — browser activity (ci.browser_activity INSERT trigger)
  • ci_communications  — messages/emails (ci.communications INSERT trigger)

On notification:
  1. Parse the payload (JSON with user_id and date).
  2. Debounce: batch notifications arriving within DEBOUNCE_SEC seconds.
  3. Tokenise the affected day (re-run L0/L1/L2 routing + serialiser).
  4. Invalidate the InferenceEngine output-cache for that date.

The ingester is started by the FastAPI lifespan handler and runs as a
background asyncio task.  Each HBPE process instance ingests for all
users whose channels it receives notifications on.

Implements T4.3 (CI-Server-32t).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta

log = logging.getLogger(__name__)

DEBOUNCE_SEC   = 5.0
# Safety poll runs alongside the LISTEN path. Push-based NOTIFY (if producers
# are installed) gives instant invalidation; this slower poll guarantees the
# cache still refreshes even where no NOTIFY trigger exists yet.
SAFETY_POLL_SEC = 30.0
RECONNECT_SEC   = 5.0
CHANNELS       = ("ci_events", "ci_browser_activity", "ci_communications")


class EventIngester:
    """
    Subscribes to PostgreSQL NOTIFY channels and invalidates the inference
    cache when new events arrive for a user.

    Usage (from FastAPI lifespan):
        ingester = EventIngester(engine_registry)
        await ingester.start()
        ...
        await ingester.stop()
    """

    def __init__(self, engine_registry: "dict[str, InferenceEngine]") -> None:  # noqa: F821
        self._registry = engine_registry   # user_id → InferenceEngine
        self._task: asyncio.Task | None = None
        # Pending invalidations: user_id → {date_str}
        self._pending: dict[str, set[str]] = {}
        self._debounce_tasks: dict[str, asyncio.Task] = {}

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
                log.exception("asyncpg LISTEN connection dropped — reconnecting in %ss", RECONNECT_SEC)
                await asyncio.sleep(RECONNECT_SEC)

    async def _asyncpg_loop(self, asyncpg) -> None:
        from ci.config import settings
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
        Poll hbpe.token_stream for rows newer than the last check and invalidate.

        Runs as a safety net alongside the LISTEN path (or as the sole path when
        asyncpg is unavailable). Errors are logged and the loop continues; the
        connection pool recycles dead connections so a DB blip self-heals.
        """
        from ci.database import get_conn
        last_check: datetime = datetime.utcnow() - timedelta(hours=1)
        while True:
            await asyncio.sleep(interval)
            try:
                def _query():
                    import psycopg2.extras
                    with get_conn() as conn:
                        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                            cur.execute(
                                """
                                SELECT DISTINCT user_id::text, date
                                FROM hbpe.token_stream
                                WHERE serialized_at > %s
                                """,
                                (last_check,),
                            )
                            return cur.fetchall()

                rows = await asyncio.get_running_loop().run_in_executor(None, _query)
                for row in rows:
                    self._dispatch(str(row["user_id"]), str(row["date"]))
                last_check = datetime.utcnow()
            except Exception:
                log.exception("Polling ingester error")

    def _on_notify(self, _conn, _pid, channel: str, payload: str) -> None:
        """asyncpg notification callback (called from event loop)."""
        try:
            data = json.loads(payload)
            user_id  = str(data.get("user_id", ""))
            date_str = str(data.get("date",    ""))
            if user_id and date_str:
                self._dispatch(user_id, date_str)
        except Exception as exc:
            log.warning("Notify parse error on %s: %s", channel, exc)

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
                engine.invalidate(d)
                log.info("Cache invalidated: user=%s date=%s", user_id[:8], d)
            except ValueError:
                log.warning("Bad date in notify payload: %s", date_str)

        # Re-run serialisation for today to pick up the new token(s)
        today = date.today()
        if str(today) in {d for d in dates}:
            asyncio.create_task(
                self._reserialise(user_id, today),
                name=f"reserialise-{user_id[:8]}",
            )

    async def _reserialise(self, user_id: str, d: date) -> None:
        """Re-run the tokeniser pipeline for a single day in a thread."""
        def _run():
            try:
                from ci.tokenizer.serializer import TokenSerializer
                ser = TokenSerializer()
                n = ser.serialize_day(user_id, d)
                log.info("Re-serialised %d tokens for user=%s date=%s", n, user_id[:8], d)
            except Exception:
                log.exception("Re-serialise failed for user=%s date=%s", user_id[:8], d)

        await asyncio.get_running_loop().run_in_executor(None, _run)
