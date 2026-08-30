"""
Unit tests for the two-phase label drain (ci.hbpe.pipeline.nightly_runner) and
the window predicates it leans on (ci.hbpe.data_client, ci.hbpe.pipeline.bootstrap).

Context: the drain used to be a single oldest-first walk of the whole corpus.
On a real appliance (198k events reaching back to 2006) the labeling front sat
four years in the past, so the window hbpe.pipeline.recurrence reads held zero
labeled tokens, hbpe.recurrence_profiles stayed empty and GET /forecast
returned ``clusters: []`` every day, indefinitely. These tests pin the
properties that fix depends on — phase order, window partitioning, per-phase
cursors, budget rollover, the serialize window's clamp to today, and the fact
that the nightly actually publishes what the drain labeled.

The recency window is sized by bootstrap.SERIALIZE_WINDOW_DAYS, not by
recurrence.HISTORY_DAYS: labels only become visible to the profiler once
serialize writes them into hbpe.token_stream, and serialize only ever touches
that trailing window.

Everything runs against injected fakes: an in-memory corpus that reproduces the
real query's window/keyset/order semantics, a labeler that advances a fake
clock, and a recording fake connection for the SQL-shape assertions. No
Postgres, no model.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import data_client as dc  # noqa: E402
from ci.hbpe.pipeline import bootstrap as bs  # noqa: E402
from ci.hbpe.pipeline import nightly_runner as nr  # noqa: E402
from ci.hbpe.pipeline import recurrence as rec  # noqa: E402

UTC = dt.UTC
USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"
TODAY = dt.date(2026, 8, 30)
# The phase boundary a 90-day serialize window yields for TODAY on a corpus
# that runs up to today — i.e. what _recency_cutoff returns live.
CUTOFF = dt.datetime(2026, 6, 1, tzinfo=UTC)


# ── Fakes ──────────────────────────────────────────────────────────────────────


class _Clock:
    """Monotonic clock that only moves when the labeler is told to charge it."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class _NeverStop:
    @staticmethod
    def is_set() -> bool:
        return False


class _Corpus:
    """
    In-memory stand-in for get_unlabeled_events.

    Reproduces the real query faithfully enough to be worth testing against:
    already-labeled rows disappear (the LEFT JOIN), ``since``/``before`` are
    half-open, ordering is the full composite key in the requested direction,
    and the keyset comparison points the same way as the ORDER BY.
    """

    def __init__(self, rows: list[dict], batch: int = 1000) -> None:
        self.rows = rows
        self.batch = batch
        self.calls: list[dict] = []
        self.labeled: set[str] = set()

    @staticmethod
    def _key(row: dict) -> tuple:
        return (row["start_time"], row["event_id"])

    def fetch(
        self,
        user_id: str,
        *,
        after_start=None,
        after_id=None,
        since=None,
        before=None,
        newest_first=False,
    ) -> list[dict]:
        self.calls.append(
            {
                "after_start": after_start,
                "after_id": after_id,
                "since": since,
                "before": before,
                "newest_first": newest_first,
            }
        )
        rows = [r for r in self.rows if r["event_id"] not in self.labeled]
        if since is not None:
            rows = [r for r in rows if r["start_time"] >= since]
        if before is not None:
            rows = [r for r in rows if r["start_time"] < before]
        rows.sort(key=self._key, reverse=newest_first)
        if after_start is not None and after_id:
            cursor = (after_start, after_id)
            rows = [
                r
                for r in rows
                if (self._key(r) < cursor if newest_first else self._key(r) > cursor)
            ]
        return rows[: self.batch]


class _Labeler:
    def __init__(
        self,
        corpus: _Corpus | None = None,
        clock: _Clock | None = None,
        cost: float = 1.0,
        fail_ids: tuple[str, ...] = (),
    ) -> None:
        self.corpus = corpus
        self.clock = clock
        self.cost = cost
        self.fail_ids = fail_ids
        self.seen: list[str] = []

    def label_event(self, *, event_id, user_id, title, description):
        self.seen.append(event_id)
        if self.clock is not None:
            self.clock.t += self.cost
        if event_id in self.fail_ids:
            # A failed label writes nothing, so the row stays unlabeled in the
            # corpus — only the keyset stops the drain re-serving it forever.
            raise RuntimeError("labeler blew up")
        if self.corpus is not None:
            self.corpus.labeled.add(event_id)
        return {"is_new_l1": False}


def _noop_progress(user_id, *, done, total, detail=None):
    return None


def _event(day: str, ident: str) -> dict:
    return {
        "event_id": ident,
        "start_time": dt.datetime.fromisoformat(day).replace(tzinfo=UTC),
        "title": ident,
        "description": None,
    }


def _run_phases(corpus, labeler, *, cutoff, budget, share, clock):
    counters = nr._DrainCounters()
    phases = nr._drain_event_phases(
        user_id=USER,
        labeler=labeler,
        should_stop=_NeverStop(),
        counters=counters,
        cutoff=cutoff,
        started_at=clock(),
        budget_seconds=budget,
        recency_share=share,
        fetch=corpus.fetch,
        progress=_noop_progress,
        clock=clock,
    )
    return phases, counters


# ── The cutoff ────────────────────────────────────────────────────────────────


def _pin_corpus(monkeypatch, bounds, today=TODAY):
    """Pin bootstrap's view of the corpus and of 'today' for a cutoff test."""
    monkeypatch.setattr(bs, "_utc_today", lambda: today)
    monkeypatch.setattr(bs, "event_date_bounds", lambda _uid: bounds)


def test_midnight_utc_is_the_start_of_the_day():
    assert nr._midnight_utc(dt.date(2026, 6, 1)) == dt.datetime(
        2026, 6, 1, 0, 0, tzinfo=UTC
    )


def test_cutoff_is_the_serialize_window_start_not_the_profiler_lookback(monkeypatch):
    """
    The binding constraint is the serialize window, not recurrence.HISTORY_DAYS.

    A label only reaches the profiler as an hbpe.token_stream row, and the sole
    writer of that table serializes the trailing SERIALIZE_WINDOW_DAYS. Labeling
    the 90–180 day band produces no rows at all — on the live corpus that band
    holds 5,775 of the 7,192 unlabeled events inside 180 days, so a cutoff of
    ``today - HISTORY_DAYS`` spends the reserved budget share on work that
    cannot move any forecast.
    """
    _pin_corpus(monkeypatch, (dt.date(2010, 1, 6), TODAY))
    cutoff = nr._recency_cutoff(USER, 90)
    assert cutoff == CUTOFF
    assert cutoff.date() != TODAY - dt.timedelta(days=rec.HISTORY_DAYS)


def test_cutoff_follows_a_lagging_corpus_instead_of_the_wall_clock(monkeypatch):
    """
    With MAX(start_time) three days behind, serialize writes
    ``[today-93, today-3]``. A cutoff anchored on ``today`` would hand three of
    those days to the oldest-first historical phase, which reaches them last —
    so they would be serialized with their events still unlabeled.
    """
    _pin_corpus(monkeypatch, (dt.date(2010, 1, 6), dt.date(2026, 8, 27)))
    assert nr._recency_cutoff(USER, 90) == dt.datetime(2026, 5, 29, tzinfo=UTC)


def test_cutoff_ignores_future_dated_rows_when_the_corpus_reaches_today(monkeypatch):
    """MAX(start_time) in the future is clamped, exactly as serialize clamps it."""
    _pin_corpus(monkeypatch, (dt.date(2010, 1, 6), dt.date(2026, 10, 15)))
    assert nr._recency_cutoff(USER, 90) == CUTOFF


def test_cutoff_of_a_short_corpus_stops_at_its_first_day(monkeypatch):
    """A brand-new appliance has no history below its first event day."""
    _pin_corpus(monkeypatch, (dt.date(2026, 8, 20), dt.date(2026, 8, 30)))
    assert nr._recency_cutoff(USER, 90) == dt.datetime(2026, 8, 20, tzinfo=UTC)


def test_cutoff_falls_back_to_the_wall_clock_when_the_corpus_is_unreadable(monkeypatch):
    """
    An empty corpus, an all-future one, or a failing bounds query must still
    yield a usable cutoff — the drain has to run either way.
    """
    monkeypatch.setattr(bs, "_utc_today", lambda: TODAY)

    def _boom(_uid):
        raise RuntimeError("no database")

    monkeypatch.setattr(bs, "event_date_bounds", _boom)
    assert nr._recency_cutoff(USER, 90) == CUTOFF

    monkeypatch.setattr(bs, "event_date_bounds", lambda _uid: None)
    assert nr._recency_cutoff(USER, 90) == CUTOFF

    _pin_corpus(monkeypatch, (dt.date(2026, 9, 1), dt.date(2026, 10, 15)))
    assert nr._recency_cutoff(USER, 90) == CUTOFF


@pytest.mark.parametrize(
    "bounds",
    [
        (dt.date(2010, 1, 6), dt.date(2026, 8, 30)),  # corpus runs to today
        (dt.date(2010, 1, 6), dt.date(2026, 10, 15)),  # future-dated rows
        (dt.date(2010, 1, 6), dt.date(2026, 8, 27)),  # ingestion lagging
        (dt.date(2026, 8, 20), dt.date(2026, 8, 30)),  # brand-new appliance
        (dt.date(2010, 1, 6), dt.date(2024, 1, 15)),  # archival corpus
    ],
)
def test_drain_cutoff_equals_the_serialize_window_start(monkeypatch, bounds):
    """
    The invariant the whole fix rests on: every day serialize will write is
    inside the recency phase, and no day outside it is. Drift either way is
    silent — too wide burns budget on rows that reach no forecast, too narrow
    leaves days serialize *will* write to the phase that reaches them last.
    """
    _pin_corpus(monkeypatch, bounds)
    window = bs.serialize_window(bounds, bs.SERIALIZE_WINDOW_DAYS, TODAY)
    assert window is not None
    cutoff = nr._recency_cutoff(USER, bs.SERIALIZE_WINDOW_DAYS)
    assert cutoff.date() == window[0]


def test_label_recency_days_defaults_to_the_serialize_window(monkeypatch):
    """
    Pinned to bootstrap.SERIALIZE_WINDOW_DAYS, NOT recurrence.HISTORY_DAYS.
    Larger wastes the recency budget on rows no serialize run will ever write;
    smaller hands days that serialize *will* write to the historical phase.
    """
    monkeypatch.delenv("HBPE_LABEL_RECENCY_DAYS", raising=False)
    from ci.hbpe.config import Settings

    assert Settings().label_recency_days == bs.SERIALIZE_WINDOW_DAYS
    assert bs.SERIALIZE_WINDOW_DAYS != rec.HISTORY_DAYS


# ── Phase order and partitioning ──────────────────────────────────────────────


def test_recency_window_is_drained_before_history():
    """
    The whole point of the fix: on a corpus that is mostly ancient, the events
    the forecast can actually see get labeled first — and future-dated calendar
    rows, which the week-forecast overlay and the due list join through
    hbpe.l1_event_cluster, come first of all.
    """
    cutoff = CUTOFF
    rows = [
        _event("2011-08-23", "old-1"),
        _event("2013-04-02", "old-2"),
        _event("2022-03-25", "old-3"),
        _event("2026-06-10", "recent-1"),
        _event("2026-07-22", "recent-2"),
        _event("2026-10-15", "future-1"),
    ]
    corpus = _Corpus(rows)
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=0.0)

    phases, counters = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=1000.0, share=0.8, clock=clock
    )

    assert labeler.seen[0] == "future-1"  # newest-first, unbounded above
    assert labeler.seen[:3] == ["future-1", "recent-2", "recent-1"]
    assert labeler.seen[3:] == ["old-1", "old-2", "old-3"]  # then oldest-first
    assert phases["recent"] == 3
    assert phases["historical"] == 3
    assert counters.labeled_events == 6
    assert counters.errors == 0


def test_phases_partition_the_corpus_on_the_same_cutoff():
    """Half-open bounds: every row is visible to exactly one phase."""
    cutoff = CUTOFF
    corpus = _Corpus([_event("2026-06-01", "boundary"), _event("2026-05-31", "below")])
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=0.0)

    _run_phases(corpus, labeler, cutoff=cutoff, budget=1000.0, share=0.8, clock=clock)

    first, second = (
        corpus.calls[0],
        next(c for c in corpus.calls if not c["newest_first"]),
    )
    assert first == {
        "after_start": None,
        "after_id": None,
        "since": cutoff,
        "before": None,
        "newest_first": True,
    }
    assert second["since"] is None
    assert second["before"] == cutoff
    # A row sitting exactly on the cutoff belongs to the recency phase (>=),
    # the one a day below to history (<) — no overlap, no gap.
    assert labeler.seen == ["boundary", "below"]


def test_each_phase_owns_its_cursor():
    """
    A cursor hoisted out of _drain_events and shared between the phases would
    leave phase 2 resuming from phase 1's newest-first position, and the ``>``
    comparison would then filter out the entire historical backlog.
    """
    cutoff = CUTOFF
    rows = [
        _event(f"2026-0{6 + i // 10}-{1 + i % 10:02d}", f"recent-{i}") for i in range(6)
    ]
    rows += [_event(f"2011-08-{10 + i:02d}", f"old-{i}") for i in range(4)]
    corpus = _Corpus(rows, batch=2)  # force paging so phase 1's cursor advances
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=0.0)

    phases, _ = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=1000.0, share=0.8, clock=clock
    )

    phase_two = [c for c in corpus.calls if not c["newest_first"]]
    assert phase_two[0]["after_start"] is None
    assert phase_two[0]["after_id"] is None
    assert phases["recent"] == 6
    assert phases["historical"] == 4  # zero if the cursor were shared


# ── Budget ────────────────────────────────────────────────────────────────────


def test_recency_phase_cannot_starve_the_historical_backfill():
    cutoff = CUTOFF
    rows = [_event("2026-06-15", f"recent-{i}") for i in range(20)]
    rows += [_event("2011-08-23", f"old-{i}") for i in range(20)]
    corpus = _Corpus(rows)
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=1.0)

    phases, counters = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=10.0, share=0.5, clock=clock
    )

    assert phases["recent"] == 5  # half the budget, then hands over
    assert phases["historical"] == 5
    assert counters.labeled_events == 10
    assert clock.t == 10.0  # stopped at the hard deadline, did not overrun


def test_empty_recency_window_rolls_its_share_over_to_history():
    """
    Unused recency time is not burned: an appliance whose window is already
    drained (or empty) spends one query on phase 1 and the whole night on the
    backlog.
    """
    cutoff = CUTOFF
    corpus = _Corpus([_event("2011-08-23", f"old-{i}") for i in range(20)])
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=1.0)

    phases, _ = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=10.0, share=0.8, clock=clock
    )

    assert phases["recent"] == 0
    assert len([c for c in corpus.calls if c["newest_first"]]) == 1
    assert phases["historical"] == 10  # not 2 — the 80% share was not wasted


def test_huge_backlog_terminates_at_the_hard_deadline():
    """200k-event corpus: the drain must stop on the budget, not on exhaustion."""
    cutoff = CUTOFF
    clock = _Clock()

    def endless_fetch(user_id, *, after_start=None, after_id=None, **_kw):
        n = endless_fetch.served
        endless_fetch.served += 1000
        return [_event("2011-08-23", f"e-{i}") for i in range(n, n + 1000)]

    endless_fetch.served = 0
    labeler = _Labeler(None, clock, cost=1.0)
    counters = nr._DrainCounters()

    phases = nr._drain_event_phases(
        user_id=USER,
        labeler=labeler,
        should_stop=_NeverStop(),
        counters=counters,
        cutoff=cutoff,
        started_at=clock(),
        budget_seconds=50.0,
        recency_share=0.8,
        fetch=endless_fetch,
        progress=_noop_progress,
        clock=clock,
    )

    assert phases["recent"] == 40  # exactly the share boundary
    assert phases["historical"] == 10  # exactly the hard deadline
    assert counters.labeled_events == 50


def test_small_corpus_is_labeled_once_and_only_once():
    """A brand-new appliance with 20 events must not regress into re-labeling."""
    cutoff = CUTOFF
    corpus = _Corpus([_event("2026-06-15", f"e-{i}") for i in range(20)], batch=7)
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=0.0)

    phases, counters = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=1000.0, share=0.8, clock=clock
    )

    assert sorted(labeler.seen) == sorted(f"e-{i}" for i in range(20))
    assert len(labeler.seen) == 20
    assert phases["recent"] == 20
    assert phases["historical"] == 0
    assert counters.errors == 0
    # Phase 2 costs exactly one query when there is no history at all.
    assert len([c for c in corpus.calls if not c["newest_first"]]) == 1


def test_poison_row_advances_the_cursor_instead_of_wedging_the_drain():
    cutoff = CUTOFF
    corpus = _Corpus(
        [_event("2026-06-15", "good-1"), _event("2026-06-16", "poison")], batch=1
    )
    clock = _Clock()
    labeler = _Labeler(corpus, clock, cost=0.0, fail_ids=("poison",))

    _, counters = _run_phases(
        corpus, labeler, cutoff=cutoff, budget=1000.0, share=0.8, clock=clock
    )

    # newest-first, so "poison" is served first and must not be re-served.
    assert labeler.seen == ["poison", "good-1"]
    assert corpus.calls[1]["after_id"] == "poison"
    assert counters.errors == 1
    assert counters.labeled_events == 1


# ── SQL shape (data_client) ───────────────────────────────────────────────────


class _RecordingCursor:
    def __init__(self, calls: list):
        self._calls = calls

    def execute(self, sql, params=None):
        self._calls.append((" ".join(str(sql).split()), list(params or [])))

    def fetchall(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _RecordingConn:
    def __init__(self, calls: list):
        self._calls = calls

    def cursor(self, **_kw):
        return _RecordingCursor(self._calls)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture(monkeypatch, **kwargs) -> tuple[str, list]:
    calls: list = []
    monkeypatch.setattr(dc, "get_conn", lambda: _RecordingConn(calls))
    monkeypatch.setattr(dc, "_ensure_events_cti_schema", lambda conn: None)
    monkeypatch.setattr(
        "ci.hbpe.tokenizer.static_labeler.mapped_kind_sql", lambda: "FALSE"
    )
    dc.get_unlabeled_events(USER, **kwargs)
    return calls[0]


def test_default_query_is_unchanged_oldest_first_full_history(monkeypatch):
    sql, params = _capture(monkeypatch)
    assert "ORDER BY e.start_time, e.event_id LIMIT" in sql
    assert "DESC" not in sql
    assert "::timestamptz" not in sql.replace("'2010-01-01'::timestamptz", "")
    assert params == [USER, 1000]


def test_ascending_keyset_uses_a_greater_than_comparison(monkeypatch):
    after = dt.datetime(2026, 5, 1, tzinfo=UTC)
    sql, params = _capture(monkeypatch, after_start=after, after_id="abc")
    assert "(e.start_time, e.event_id) > (%s::timestamptz, %s::uuid)" in sql
    assert "ORDER BY e.start_time, e.event_id LIMIT" in sql
    assert params == [USER, after, "abc", 1000]


def test_descending_scan_flips_both_the_order_and_the_keyset(monkeypatch):
    """
    The keyset is only correct while the ORDER BY is the full composite in a
    single direction and the comparison points the same way. This corpus has
    exact duplicate start_times (two reddit rows at 2026-08-30 08:38:22.313+00),
    so a half-flipped clause silently skips rows that are then never labeled.
    """
    after = dt.datetime(2026, 5, 1, tzinfo=UTC)
    sql, params = _capture(
        monkeypatch, after_start=after, after_id="abc", newest_first=True
    )
    assert "(e.start_time, e.event_id) < (%s::timestamptz, %s::uuid)" in sql
    assert "ORDER BY e.start_time DESC, e.event_id DESC LIMIT" in sql
    assert " > (%s::timestamptz" not in sql
    assert params == [USER, after, "abc", 1000]


def test_window_bounds_are_half_open_and_bound_as_timestamptz(monkeypatch):
    since = dt.datetime(2026, 3, 3, tzinfo=UTC)
    before = dt.datetime(2026, 3, 3, tzinfo=UTC)
    sql, params = _capture(monkeypatch, since=since, before=before)
    assert "AND e.start_time >= %s::timestamptz" in sql
    assert "AND e.start_time < %s::timestamptz" in sql
    # user_id, since, before, limit — the window binds before the keyset.
    assert params == [USER, since, before, 1000]


def test_window_and_keyset_params_bind_in_query_order(monkeypatch):
    since = dt.datetime(2026, 3, 3, tzinfo=UTC)
    after = dt.datetime(2026, 5, 1, tzinfo=UTC)
    _, params = _capture(
        monkeypatch, after_start=after, after_id="abc", since=since, newest_first=True
    )
    assert params == [USER, since, after, "abc", 1000]


# ── Serialize window clamp (bootstrap) ────────────────────────────────────────


_SERIALIZED_RANGES: list[tuple[str, str]] = []


class _RangeSerializer:
    def serialize_range(self, user_id, start_date, end_date):
        _SERIALIZED_RANGES.append((start_date, end_date))
        return 1412


def _run_serialize(monkeypatch, min_date, max_date, today):
    _SERIALIZED_RANGES.clear()

    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return (min_date, max_date)

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

    import ci.hbpe.database as db
    import ci.hbpe.pipeline.token_rollup as tr
    import ci.hbpe.tokenizer.serializer as ser

    monkeypatch.setattr(db, "get_conn", lambda: _Conn())
    monkeypatch.setattr(ser, "TokenSerializer", _RangeSerializer)
    monkeypatch.setattr(tr, "rebuild_token_rollups", lambda uid: {"days": 0})
    monkeypatch.setattr(bs, "_utc_today", lambda: today)
    return asyncio.run(bs.serialize_token_stream(USER))


def test_serialize_window_is_clamped_to_today_not_to_a_future_max(monkeypatch):
    """
    Three future-dated rows (a scan, two tax reminders) pulled MAX(start_time)
    to 2026-10-15 on the dev corpus, so the 90-day window became
    2026-07-17..2026-10-15 — 7 events. Clamped it holds 1,412 over 24 days.
    """
    result = _run_serialize(
        monkeypatch,
        dt.date(2010, 1, 6),
        dt.date(2026, 10, 15),
        today=TODAY,
    )
    assert _SERIALIZED_RANGES == [("2026-06-01", "2026-08-30")]
    assert result["end"] == "2026-08-30"
    assert result["rows"] == 1412


def test_serialize_window_of_an_archival_corpus_is_untouched(monkeypatch):
    """
    Clamp, do not anchor. An appliance whose data stops two years ago must keep
    serializing its own last 90 days; ``end = today`` would give it an empty
    range, rows: 0, and a bootstrap abort with no_token_data.
    """
    _run_serialize(
        monkeypatch,
        dt.date(2010, 1, 6),
        dt.date(2024, 1, 15),
        today=TODAY,
    )
    assert _SERIALIZED_RANGES == [("2023-10-17", "2024-01-15")]


def test_serialize_reports_a_corpus_that_is_entirely_in_the_future(monkeypatch):
    result = _run_serialize(
        monkeypatch,
        dt.date(2026, 9, 1),
        dt.date(2026, 10, 15),
        today=TODAY,
    )
    assert result == {"rows": 0, "reason": "only_future_events"}
    assert _SERIALIZED_RANGES == []


# ── The nightly publishes what the drain labeled (functions.nightly) ──────────
#
# Labeling recency-first is only half the chain. label_unlabeled writes
# hbpe.l1_event_cluster; the sole writer of hbpe.token_stream — the only table
# build_recurrence_profiles reads — is bootstrap.serialize_token_stream. That
# step used to sit inside `if needs_bootstrap`, so on an established appliance
# (valid checkpoint, no vocab drift) a full night of labeling reached nothing
# and /forecast stayed at clusters:[]. These tests pin it outside that branch.


def _stub_nightly(monkeypatch) -> list[str]:
    """Replace every nightly step with an order-recording async no-op."""
    order: list[str] = []

    def _step(name: str, result: dict | None = None):
        async def _fn(_user_id):
            order.append(name)
            return result if result is not None else {"step": name}

        return _fn

    from ci.hbpe.pipeline import bootstrap, nightly_runner

    for name in (
        "serialize_token_stream",
        "train_hmt_model",
        "calibrate_and_export_onnx",
    ):
        monkeypatch.setattr(bootstrap, name, _step(name))
    for name in (
        "label_unlabeled",
        "label_summary_tokens",
        "l1_stale_sweep",
        "l2_stale_sweep",
        "lora_fine_tune",
        "backfill_actuals",
        "recurrence_profile",
        "drift_detection",
        "cache_invalidation",
    ):
        monkeypatch.setattr(nightly_runner, name, _step(name))
    return order


def _nightly(monkeypatch, *, needs: bool) -> tuple[dict, list[str]]:
    from ci.hbpe import functions
    from ci.hbpe.pipeline import nightly_runner

    order = _stub_nightly(monkeypatch)

    async def _needs(_user_id):
        order.append("needs_bootstrap")
        return {"needs": needs, "reason": "test"}

    monkeypatch.setattr(nightly_runner, "needs_bootstrap", _needs)
    return asyncio.run(functions.nightly(USER)), order


def test_nightly_serializes_even_when_no_bootstrap_is_needed(monkeypatch):
    """
    The regression that made the whole drain fix inert: an appliance whose
    checkpoint is valid and whose L1 vocab has not drifted skipped serialize,
    so every label the night produced stayed invisible to /forecast.
    """
    results, order = _nightly(monkeypatch, needs=False)

    assert "serialize_token_stream" in order
    assert results["steps"]["serialize"]["status"] == "ok"
    # Still gated: no retrain when nothing drifted.
    assert "train_hmt_model" not in order
    assert "calibrate_and_export_onnx" not in order


def test_nightly_serializes_after_labeling_and_before_recurrence(monkeypatch):
    """
    Order is the whole point: serialize has to see this night's labels, and
    build_recurrence_profiles has to see this night's token_stream rows.
    """
    _, order = _nightly(monkeypatch, needs=False)

    assert order.index("label_unlabeled") < order.index("serialize_token_stream")
    assert order.index("label_summary_tokens") < order.index("serialize_token_stream")
    assert order.index("serialize_token_stream") < order.index("recurrence_profile")


def test_nightly_still_serializes_before_training_when_bootstrap_is_needed(monkeypatch):
    """Hoisting serialize out of the branch must not leave train without data."""
    _, order = _nightly(monkeypatch, needs=True)

    assert order.index("serialize_token_stream") < order.index("train_hmt_model")
    assert order.index("train_hmt_model") < order.index("calibrate_and_export_onnx")


def test_nightly_serialize_failure_does_not_abort_the_rest(monkeypatch):
    """Fail-continue, like every other nightly step."""
    from ci.hbpe import functions
    from ci.hbpe.pipeline import bootstrap, nightly_runner

    order = _stub_nightly(monkeypatch)

    async def _boom(_user_id):
        order.append("serialize_token_stream")
        raise RuntimeError("no database")

    async def _needs(_user_id):
        return {"needs": False, "reason": "test"}

    monkeypatch.setattr(bootstrap, "serialize_token_stream", _boom)
    monkeypatch.setattr(nightly_runner, "needs_bootstrap", _needs)

    results = asyncio.run(functions.nightly(USER))

    assert results["steps"]["serialize"]["status"] == "error"
    assert "recurrence_profile" in order
    assert results["steps"]["step6_cache"]["status"] == "ok"
