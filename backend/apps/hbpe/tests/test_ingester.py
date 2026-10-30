"""
Regression tests for the ingester's two paths.

The ingester has a NOTIFY path (producers are the API's `HbpeNotifyService`,
added in #2477) and a `hbpe.token_stream` safety poll. They must behave
differently, and two defects are pinned here.

**The poll must not re-tokenise.** It watches `token_stream` — HBPE's own
*output* — so a hit means a producer already serialised that day. Re-running
`TokenSerializer.serialize_day()` there fed itself: it is a DELETE-then-INSERT
and `serialized_at` defaults to `NOW()`, so the rows it wrote satisfied the very
predicate the next poll used (`serialized_at > watermark`). Detection
re-triggered the flush, which re-serialised, which re-triggered, once per poll
interval with no new source data. The NOTIFY path *does* re-tokenise, because
there the trigger really is new source data — that split is pinned too, so the
fix cannot be "read-only everywhere".

**The poll watermark must come from the observed rows.** It was
`datetime.utcnow()`: naive, so Postgres reinterpreted it in the session time
zone when comparing against a TIMESTAMPTZ column, and stamped after the query
returned, so a producer committing in between was skipped for good.

**An older day goes on the re-serialize queue, from NOTIFY alone.** The
ingester rewrites today only. A day older than the nightly's serialize budget is
rewritten by nothing else, so a change to it is queued in `hbpe.reserialize_days`
for the nightly drain. Only an event notification may queue a day: a poll hit is
HBPE's own output (queuing it would re-arm every day the drain rewrites), and
the other channels feed nothing the serializer reads. The queue's own contract
is pinned in test_reserialize_queue.py.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, timedelta

import psycopg2.errors
import pytest

import ci.hbpe.database as hbpe_database
from ci.hbpe.pipeline import ingester as ingester_mod
from ci.hbpe.pipeline.ingester import EventIngester

# Pinned through ingester._utc_today (see the autouse fixture): the payload's
# date is a UTC day, and a wall-clock TODAY raced midnight.
TODAY_DATE = date(2026, 10, 1)
TODAY = TODAY_DATE.isoformat()
USER = "11111111-2222-3333-4444-555555555555"


class FakeEngine:
    """Stands in for InferenceEngine — records what got evicted."""

    def __init__(self) -> None:
        self.invalidated: list[str] = []

    def invalidate(self, d) -> None:
        self.invalidated.append(str(d))


class FakeDb:
    """
    Minimal ``hbpe.token_stream`` stand-in.

    Records every statement so a reintroduced re-serialisation shows up as a
    DELETE/INSERT, and serves SELECTs from rows the test controls.
    """

    def __init__(self, rows: list[dict], *, queue_exists: bool = True) -> None:
        self.rows = rows
        self.statements: list[tuple[str, tuple]] = []
        self.select_params: list[tuple] = []
        self.queue_exists = queue_exists
        # (user_id, date) pairs the ingester put on hbpe.reserialize_days.
        self.queued: list[tuple[str, date]] = []

    @property
    def writes(self) -> list[tuple[str, tuple]]:
        return [
            (sql, params)
            for sql, params in self.statements
            if sql.upper().startswith(("DELETE", "INSERT", "UPDATE"))
        ]

    def newer_than(self, since: datetime) -> list[dict]:
        # Postgres does not raise on a naive bound param compared against a
        # TIMESTAMPTZ column — it reinterprets it in the session time zone.
        # Model that (session TZ = UTC) so a naive watermark shows up as the
        # behaviour it actually causes, not as a TypeError here.
        if since.tzinfo is None:
            since = since.replace(tzinfo=UTC)
        return [r for r in self.rows if r["last_serialized"] > since]


class FakeCursor:
    def __init__(self, db: FakeDb) -> None:
        self._db = db
        self._rows: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql: str, params=None) -> None:
        flat = " ".join(sql.split())
        self._db.statements.append((flat, params))
        if flat.startswith("INSERT INTO hbpe.reserialize_days"):
            if not self._db.queue_exists:
                raise psycopg2.errors.UndefinedTable(
                    'relation "hbpe.reserialize_days" does not exist'
                )
            user_id, _reason, days = params
            self._db.queued.extend((user_id, d) for d in days)
            self._rows = []
        elif flat.upper().startswith("SELECT"):
            self._db.select_params.append(params)
            self._rows = self._db.newer_than(params[0])
        else:
            self._rows = []

    def fetchall(self) -> list[dict]:
        return self._rows


class FakeConn:
    def __init__(self, db: FakeDb) -> None:
        self._db = db

    def cursor(self, cursor_factory=None):
        return FakeCursor(self._db)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


async def _wait_for(pred, what: str) -> None:
    """Spin until `pred` holds, failing with a readable message if it never does."""
    # Deliberate poll, matching tests/test_function_runner.py: the condition is a
    # side effect of the ingester's own loop, not something that can signal an
    # asyncio.Event without changing the ingester.
    try:
        async with asyncio.timeout(5.0):
            while not pred():  # noqa: ASYNC110
                await asyncio.sleep(0.01)
    except TimeoutError:
        raise AssertionError(f"timed out waiting for {what}") from None


async def _run_polls(ingester: EventIngester, db: FakeDb, rounds: int) -> None:
    """Drive the real poll loop for `rounds` queries, then stop it cleanly."""
    task = asyncio.create_task(ingester._polling_loop(interval=0.05))
    try:
        await _wait_for(
            lambda: len(db.select_params) >= rounds, f"{rounds} poll queries"
        )
        # Let any debounced flush land (DEBOUNCE_SEC is patched to ~0 in tests).
        await asyncio.sleep(0.2)
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.fixture
def fast_debounce(monkeypatch):
    monkeypatch.setattr("ci.hbpe.pipeline.ingester.DEBOUNCE_SEC", 0.005)


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setattr(ingester_mod, "_utc_today", lambda: TODAY_DATE)


async def _settled(ingester: EventIngester) -> None:
    """Wait until every debounced flush, and everything it spawned, is done."""
    await _wait_for(
        lambda: (
            not ingester._pending
            and not ingester._background_tasks
            and all(t.done() for t in ingester._debounce_tasks.values())
        ),
        "the ingester to settle",
    )


def _notify(ingester: EventIngester, day: str, channel: str = "ci_events") -> None:
    ingester._on_notify(None, None, channel, json.dumps({"user_id": USER, "date": day}))


@pytest.mark.asyncio
async def test_poll_invalidates_without_writing(monkeypatch, fast_debounce):
    """A changed day is evicted from the cache, and nothing is written back."""
    db = FakeDb(
        [
            {
                "user_id": USER,
                "date": TODAY,
                "last_serialized": datetime.now(UTC),
            }
        ]
    )
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    await _run_polls(ingester, db, rounds=1)

    assert engine.invalidated == [TODAY]
    assert db.writes == [], f"ingester wrote to token_stream: {db.writes}"


@pytest.mark.asyncio
async def test_poll_does_not_retrigger_itself(monkeypatch, fast_debounce):
    """
    The self-feeding loop, modelled end to end.

    ``serialize_day`` is stubbed to do what the real one does to the poll's
    predicate: restamp the day's ``serialized_at`` to ``NOW()``. If the ingester
    calls it after invalidating, the next poll re-detects the day it just wrote
    and the cycle never ends. With no new producer writes, exactly one
    invalidation may happen and the serialiser must never be reached.
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb(
        [
            {
                "user_id": USER,
                "date": TODAY,
                "last_serialized": datetime.now(UTC),
            }
        ]
    )
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    serialize_calls: list[tuple[str, str]] = []

    def fake_serialize_day(_self, user_id, d):
        serialize_calls.append((str(user_id), str(d)))
        # DELETE-then-INSERT: serialized_at defaults to NOW().
        for row in db.rows:
            if row["user_id"] == str(user_id) and row["date"] == str(d):
                row["last_serialized"] = datetime.now(UTC)
        return 3

    monkeypatch.setattr(TokenSerializer, "serialize_day", fake_serialize_day)

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    await _run_polls(ingester, db, rounds=3)

    assert serialize_calls == [], (
        f"poll path re-serialised its own input: {serialize_calls}"
    )
    assert engine.invalidated == [TODAY], (
        f"day re-detected without new source data: {engine.invalidated}"
    )
    assert db.writes == []


@pytest.mark.asyncio
async def test_watermark_advances_to_observed_row(monkeypatch, fast_debounce):
    """
    The next poll's bound parameter is the serialized_at actually observed —
    timezone-aware, and never a host-clock reading taken after the query.
    """
    stamp = datetime.now(UTC)
    db = FakeDb([{"user_id": USER, "date": TODAY, "last_serialized": stamp}])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    ingester = EventIngester({USER: FakeEngine()})
    await _run_polls(ingester, db, rounds=2)

    first, second = db.select_params[0][0], db.select_params[1][0]
    assert first.tzinfo is not None and second.tzinfo is not None
    assert first < stamp, "initial watermark must not hide existing rows"
    assert second == stamp, f"watermark should be the observed row, got {second}"


@pytest.mark.asyncio
async def test_unregistered_user_is_skipped(monkeypatch, fast_debounce):
    """No engine for the user — nothing to evict, and still no writes."""
    db = FakeDb(
        [
            {
                "user_id": USER,
                "date": TODAY,
                "last_serialized": datetime.now(UTC),
            }
        ]
    )
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    other = FakeEngine()
    ingester = EventIngester({"99999999-0000-0000-0000-000000000000": other})
    await _run_polls(ingester, db, rounds=2)

    assert other.invalidated == []
    assert db.writes == []


@pytest.mark.asyncio
async def test_poll_survives_db_errors(monkeypatch, fast_debounce):
    """A failing query is logged and the loop keeps polling."""
    calls = {"n": 0}
    stamp = datetime.now(UTC)
    db = FakeDb([{"user_id": USER, "date": TODAY, "last_serialized": stamp}])

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("connection reset")
        return FakeConn(db)

    monkeypatch.setattr(hbpe_database, "get_conn", flaky)

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    task = asyncio.create_task(ingester._polling_loop(interval=0.01))
    try:
        await _wait_for(
            lambda: engine.invalidated == [TODAY],
            "invalidation to resume after a DB error",
        )
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_bad_date_does_not_abort_the_flush(monkeypatch, fast_debounce):
    """One unparseable date must not stop the other days from being evicted."""
    now = datetime.now(UTC)
    db = FakeDb(
        [
            {"user_id": USER, "date": "not-a-date", "last_serialized": now},
            {"user_id": USER, "date": TODAY, "last_serialized": now},
        ]
    )
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    await _run_polls(ingester, db, rounds=1)

    assert engine.invalidated == [TODAY]


@pytest.mark.asyncio
async def test_notify_path_still_reserialises(monkeypatch, fast_debounce):
    """
    The other half of the split: a NOTIFY means new *source* data, so the day
    must be re-tokenised. Pins #2477's live-ingest path against a fix that
    over-corrects the poll loop into "never serialise anywhere".
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    serialize_calls: list[tuple[str, str]] = []

    def fake_serialize_day(_self, user_id, d):
        serialize_calls.append((str(user_id), str(d)))
        return 3

    monkeypatch.setattr(TokenSerializer, "serialize_day", fake_serialize_day)

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    ingester._on_notify(
        None, None, "ci_events", json.dumps({"user_id": USER, "date": TODAY})
    )

    await _wait_for(
        lambda: serialize_calls == [(USER, TODAY)],
        "the NOTIFY path to re-tokenise today",
    )
    assert engine.invalidated == [TODAY]


@pytest.mark.asyncio
async def test_the_serialiser_is_handed_an_iso_string_not_a_date(
    monkeypatch, fast_debounce
):
    """
    ``serialize_day`` takes the day as ``YYYY-MM-DD`` and the summary read
    parses it with ``date.fromisoformat``, which raises ``TypeError`` for a
    ``date``. The summary merge swallows that ("Summary token merge failed
    (non-fatal): fromisoformat: argument must be str"), so a re-serialise that
    passed a ``date`` quietly dropped the day's summary tokens every time.

    The tests above stub ``serialize_day`` and record ``str(d)``, which makes a
    ``date`` and its ISO string indistinguishable; this one keeps the argument
    as it arrived and parses it the way the real read does.
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    received: list[object] = []

    def fake_serialize_day(_self, user_id, d):
        received.append(d)
        date.fromisoformat(d)  # the summary read's own parse
        return 3

    monkeypatch.setattr(TokenSerializer, "serialize_day", fake_serialize_day)

    ingester = EventIngester({USER: FakeEngine()})
    _notify(ingester, TODAY)

    await _wait_for(lambda: received, "the NOTIFY path to re-tokenise today")
    await _settled(ingester)
    assert received == [TODAY]


@pytest.mark.asyncio
async def test_notify_for_an_older_day_invalidates_without_reserialising(
    monkeypatch, fast_debounce
):
    """
    Only today is re-tokenised here. An older day is evicted from the cache and
    queued for the nightly (see the next test), never rewritten inline.
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    serialize_calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        TokenSerializer,
        "serialize_day",
        lambda _self, u, d: serialize_calls.append((str(u), str(d))),
    )

    older = (TODAY_DATE - timedelta(days=3)).isoformat()
    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    _notify(ingester, older)

    await _wait_for(lambda: engine.invalidated == [older], "the older day to evict")
    await _settled(ingester)
    assert serialize_calls == []


@pytest.mark.asyncio
async def test_notify_for_an_older_day_queues_it_for_the_nightly(
    monkeypatch, fast_debounce
):
    """
    THE FIX. A day older than the nightly's serialize budget still has its
    source, so neither the content tiers nor the purge tier visit it again, and
    before the queue an event cancelled, deleted or edited on it never reached
    hbpe.token_stream. The nightly drains what is queued here.
    """
    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    older = TODAY_DATE - timedelta(days=200)
    ingester = EventIngester({USER: FakeEngine()})
    _notify(ingester, older.isoformat())

    await _wait_for(lambda: db.queued == [(USER, older)], "the older day to queue")


@pytest.mark.asyncio
async def test_token_work_does_not_wait_for_an_engine(monkeypatch, fast_debounce):
    """
    Engines are created on a user's first forecast request, so after a restart
    the registry is empty. The cache eviction needs one; rewriting today and
    queuing an older day do not, and a change made before the user's first
    forecast must still reach the token stream.
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))
    serialize_calls: list[tuple[str, str]] = []

    def fake_serialize_day(_self, user_id, d):
        serialize_calls.append((str(user_id), str(d)))
        return 3

    monkeypatch.setattr(TokenSerializer, "serialize_day", fake_serialize_day)

    older = TODAY_DATE - timedelta(days=120)
    ingester = EventIngester({})
    _notify(ingester, TODAY)
    _notify(ingester, older.isoformat())

    await _wait_for(
        lambda: serialize_calls == [(USER, TODAY)] and db.queued == [(USER, older)],
        "today to be rewritten and the older day queued with no engine loaded",
    )


@pytest.mark.asyncio
async def test_a_poll_hit_never_queues_a_day(monkeypatch, fast_debounce):
    """
    The poll reports HBPE's own writes back. Every day the nightly drain
    rewrites shows up in the next poll, so queuing poll hits would re-arm the
    drain's own output, one night at a time, forever.
    """
    older = (TODAY_DATE - timedelta(days=200)).isoformat()
    db = FakeDb(
        [{"user_id": USER, "date": older, "last_serialized": datetime.now(UTC)}]
    )
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    await _run_polls(ingester, db, rounds=2)
    await _settled(ingester)

    assert engine.invalidated == [older]
    assert db.queued == []


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["ci_communications", "ci_browser_activity"])
async def test_only_event_notifications_queue_a_day(
    monkeypatch, fast_debounce, channel
):
    """
    The serializer reads ci.events (and summaries and tasks, which no producer
    notifies about). Messages and page visits feed none of it, so the days they
    name would cost the nightly drain's cap rewrites that come out identical.
    """
    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    older = (TODAY_DATE - timedelta(days=200)).isoformat()
    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    _notify(ingester, older, channel)

    await _wait_for(lambda: engine.invalidated == [older], "the eviction")
    await _settled(ingester)
    assert db.queued == []


@pytest.mark.asyncio
async def test_today_and_future_days_are_never_queued(monkeypatch, fast_debounce):
    """
    Today is rewritten on the spot. A future day holds no tokens (the day list
    clamps at today), so its row could only ever be consumed unused.
    """
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))
    monkeypatch.setattr(TokenSerializer, "serialize_day", lambda *_a: 0)

    ingester = EventIngester({USER: FakeEngine()})
    _notify(ingester, TODAY)
    _notify(ingester, (TODAY_DATE + timedelta(days=4)).isoformat())
    _notify(ingester, "not-a-date")

    await _settled(ingester)
    assert db.queued == []


@pytest.mark.asyncio
async def test_a_missing_queue_table_costs_only_the_queue(
    monkeypatch, fast_debounce, caplog
):
    """
    Deploy skew: the HBPE image can run before the API migration that creates
    hbpe.reserialize_days. The request is dropped with a warning — exactly what
    happened to an older day before the queue existed — and the flush carries
    on with the cache.
    """
    db = FakeDb([], queue_exists=False)
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    older = (TODAY_DATE - timedelta(days=200)).isoformat()
    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    with caplog.at_level("DEBUG", logger="ci.hbpe.pipeline.reserialize_queue"):
        _notify(ingester, older)
        await _wait_for(lambda: engine.invalidated == [older], "the eviction")
        await _settled(ingester)

    assert db.queued == []
    assert any("does not exist yet" in r.getMessage() for r in caplog.records)
