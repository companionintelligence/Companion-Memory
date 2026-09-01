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
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, timedelta

import pytest

import ci.hbpe.database as hbpe_database
from ci.hbpe.pipeline.ingester import EventIngester

TODAY = date.today().isoformat()
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

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.statements: list[tuple[str, tuple]] = []
        self.select_params: list[tuple] = []

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
        if flat.upper().startswith("SELECT"):
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
async def test_notify_for_an_older_day_invalidates_without_reserialising(
    monkeypatch, fast_debounce
):
    """Only today is re-tokenised; an older day is a cache eviction alone."""
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    db = FakeDb([])
    monkeypatch.setattr(hbpe_database, "get_conn", lambda: FakeConn(db))

    serialize_calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        TokenSerializer,
        "serialize_day",
        lambda _self, u, d: serialize_calls.append((str(u), str(d))),
    )

    older = (date.today() - timedelta(days=3)).isoformat()
    engine = FakeEngine()
    ingester = EventIngester({USER: engine})
    ingester._on_notify(
        None, None, "ci_events", json.dumps({"user_id": USER, "date": older})
    )

    await _wait_for(lambda: engine.invalidated == [older], "the older day to evict")
    assert serialize_calls == []
