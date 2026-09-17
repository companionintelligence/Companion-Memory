"""
Unit tests for the two-phase label drain (ci.hbpe.pipeline.nightly_runner) and
the window predicates it leans on (ci.hbpe.data_client, ci.hbpe.pipeline.bootstrap).

Context: the drain used to be a single oldest-first walk of the whole corpus.
On a real appliance (198k events reaching back to 2006) the labeling front sat
four years in the past, so the window hbpe.pipeline.recurrence reads held zero
labeled tokens, hbpe.recurrence_profiles stayed empty and GET /forecast
returned ``clusters: []`` every day, indefinitely. These tests pin the
properties that fix depends on — phase order, window partitioning, per-phase
cursors, budget rollover, which days serialize writes, and the fact that the
nightly actually publishes what the drain labeled.

The recency window is sized by bootstrap.SERIALIZE_WINDOW_DAYS, not by
recurrence.HISTORY_DAYS: labels only become visible to the profiler once
serialize writes them into hbpe.token_stream, and serialize only ever touches
the days bootstrap.token_source_days selects — days that hold data (or stale
tokens needing a purge), clamped to today, newest first, which is not the same
set as a contiguous (MIN, MAX) range once hourly summaries keep MAX pinned at
today.

Everything runs against injected fakes: an in-memory corpus that reproduces the
real query's window/keyset/order semantics, a labeler that advances a fake
clock, a Postgres stand-in for bootstrap's day queries, and a recording fake
connection for the SQL-shape assertions. No Postgres, no model.
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
from ci.hbpe import database as db  # noqa: E402
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


def _order_desc(body: str) -> bool:
    """
    Whether a tier's own ``ORDER BY`` runs newest-first.

    Direction is policy, not formatting, so the fake reads it off the query
    instead of assuming it. A fake that assumed DESC could not see the mutation
    at all: flipping the fill tier to ASC on a bimodal corpus returns a full
    91-day budget spanning 2023 with ZERO days inside the last 90 — strictly
    worse than the eviction the tiers exist to prevent — and every test here
    stayed green.
    """
    return "DESC" in body.rsplit("ORDER BY", 1)[1].split("LIMIT")[0]


def _tier(days, limit: int, *, desc: bool, exclude=()) -> list[dt.date]:
    """``ORDER BY source_date <dir> LIMIT n`` over a day set, minus ``exclude``."""
    kept = sorted(set(days) - set(exclude), reverse=desc)
    return kept[: max(limit, 0)]


def _cte_body(flat: str, name: str) -> str:
    """
    The text of one CTE, so a tier's SOURCE can be read off the query instead of
    assumed. Which set a tier selects from is the policy — tier A reserving from
    the event branch ALONE is the entire fix — so a fake that hardcoded it would
    keep answering correctly for a query that had stopped doing it.
    """
    start = flat.index(f"{name} AS (") + len(name) + 5
    depth, i = 1, start
    while depth:
        depth += {"(": 1, ")": -1}.get(flat[i], 0)
        i += 1
    return flat[start : i - 1]


def _pool(body: str, events, summaries) -> set:
    """The day set a tier's CTE body actually draws from."""
    pool = set()
    if "event_days" in body:
        pool |= set(events)
    if "summary_days" in body:
        pool |= set(summaries)
    return pool


class _DayQueryCursor:
    """
    Postgres stand-in for bootstrap's two day queries.

    Answers from one day set per source table, and folds a set in only when
    ``FROM <table>`` actually appears in the SQL. That table check is the point:
    a fake that returned the same days whatever the query said could not tell a
    correct day list from one that had dropped a source branch, which is how
    ``token_source_days`` lost the emptied-day purge in the first place. The
    LIMITs and the clamp are read off the bound parameters for the same reason —
    the production values, not the test's idea of them.

    Which *policy* it applies is read off the SQL too. The day query is tiered
    (``reserved`` / ``fill`` / ``purge`` CTEs); a query without those CTEs is
    the flat ``ORDER BY source_date DESC LIMIT n`` this replaced, and the fake
    evaluates whichever one it was handed. So deleting a tier from the
    production SQL does not quietly keep the tiered answers here — the fake
    drops to the flat policy and the bimodal expectations go red.
    """

    _TABLES = ("FROM ci.events", "FROM ci.summaries", "FROM hbpe.token_stream")

    # Days whose ONLY events are planning's own suggested blocks. Both reads the
    # day query predicts — the serializer's (get_token_events_for_day) and the
    # drain's (_unlabeled_events_where) — filter ``event_type IS DISTINCT FROM
    # 'planned_block'``, so such a day yields no event tokens and no labels. It
    # is therefore visible to the event branch here only when that branch
    # forgets the same predicate, which is exactly the mutation to catch.
    _PLANNED_ONLY = "FROM ci.events (planned blocks only)"

    def __init__(self, sources: dict[str, list[dt.date]], calls: list) -> None:
        self._sources = sources
        self._calls = calls
        self._result = None

    def _days(self, flat: str, table: str, end: dt.date) -> list[dt.date]:
        if table not in flat:
            return []
        days = {d for d in self._sources.get(table, ()) if d <= end}
        if table == "FROM ci.events" and "planned_block" not in flat:
            days |= {d for d in self._sources.get(self._PLANNED_ONLY, ()) if d <= end}
        return sorted(days)

    def execute(self, sql, params=None):
        flat = " ".join(str(sql).split())
        params = tuple(params or ())
        self._calls.append((flat, params))

        if "MIN(source_date)" in flat:
            days = sorted(
                {
                    day
                    for table in self._TABLES
                    for day in self._days(flat, table, dt.date.max)
                }
            )
            self._result = (days[0], days[-1]) if days else (None, None)
            return

        end = next(p for p in params if isinstance(p, dt.date))
        limits = [p for p in params if isinstance(p, int)]
        events = self._days(flat, "FROM ci.events", end)
        summaries = self._days(flat, "FROM ci.summaries", end)
        stale = self._days(flat, "FROM hbpe.token_stream", end)

        tiered = (
            "reserved AS (" in flat and "fill AS (" in flat and "purge AS (" in flat
        )
        if tiered:
            floor_days, budget, purge_cap = limits
            reserved_body = _cte_body(flat, "reserved")
            reserved = _tier(
                _pool(reserved_body, events, summaries),
                floor_days,
                desc=_order_desc(reserved_body),
            )
            fill_body = _cte_body(flat, "fill")
            fill = _tier(
                _pool(fill_body, events, summaries),
                budget - len(reserved),
                desc=_order_desc(fill_body),
                exclude=reserved,
            )
            content = set(reserved) | set(fill)
            # What the purge tier excludes is policy too: source-less days, not
            # "days outside the budget". token_stream holds far more history
            # than the budget, and a day that still has an event or a summary
            # behind it is history, not staleness.
            purge_body = _cte_body(flat, "purge")
            excluded = _pool(purge_body, events, summaries)
            if "FROM content" in purge_body:
                excluded |= content
            purge = _tier(
                stale, purge_cap, desc=_order_desc(purge_body), exclude=excluded
            )
        else:
            (budget,) = limits
            content = set(
                _tier(set(events) | set(summaries) | set(stale), budget, desc=True)
            )
            purge = []
        # Content and purge come back TAGGED and disjoint, as the final UNION
        # ALL does: label_recency_start reads only the content half.
        rows = [(d.isoformat(), True) for d in content]
        rows += [(d.isoformat(), False) for d in purge]
        self._result = sorted(rows, reverse=True)

    def fetchone(self):
        return self._result

    def fetchall(self):
        return self._result

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _DayQueryConn:
    def __init__(self, sources: dict[str, list[dt.date]], calls: list) -> None:
        self._sources = sources
        self._calls = calls

    def cursor(self, **_kw):
        return _DayQueryCursor(self._sources, self._calls)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _dense_between(min_date: dt.date, max_date: dt.date) -> list[dt.date]:
    return [
        min_date + dt.timedelta(days=i) for i in range((max_date - min_date).days + 1)
    ]


def _pin_corpus(monkeypatch, bounds, today=TODAY):
    """
    Pin bootstrap's view of the corpus and of 'today' for a cutoff test.

    The day list is served by a fake *connection* over a corpus that is dense
    between ``bounds``, so ``token_source_days`` runs for real. Stubbing the
    function instead is what hollowed out
    test_drain_cutoff_equals_the_serialize_window_start: the stub re-derived
    serialize_window's own arithmetic, so the assertion compared a fake built
    from serialize_window against serialize_window, and replacing the
    production ``window_days + 1`` budget with a literal 200 left all five
    parametrizations green.

    A dense corpus has exactly one day-with-data per calendar day, which is what
    makes the cross-check against the contiguous window meaningful. The sparse
    case, where the list jumps a two-year gap, is pinned in
    test_summary_label_range and in the serialize tests below.
    """
    monkeypatch.setattr(bs, "_utc_today", lambda: today)
    days = [] if bounds is None else _dense_between(*bounds)
    monkeypatch.setattr(
        db, "get_conn", lambda: _DayQueryConn({"FROM ci.events": days}, [])
    )


# ── The tiered day budget (bootstrap.token_source_days) ───────────────────────
#
# The budget is still ``window_days + 1`` content days; what changed is how they
# are allocated. A flat ``ORDER BY source_date DESC LIMIT 91`` over the union of
# the sources is correct on every corpus whose newest 91 days-with-data hold the
# events — which is every corpus EXCEPT the bimodal one, where hourly summaries
# accrue a day-with-data per calendar day and evict the imported event days ~91
# days after the import. Events carry hard L0/L1 labels; summary tokens are the
# SUMMARY_SOFT_PROB (0.7) gap-filler, so that eviction spends the whole corpus on
# the weaker source. Hence the tiers — and hence these tests, four fifths of
# which exist to pin that the tiers change NOTHING anywhere else.


def _run_back(end: dt.date, n: int) -> list[dt.date]:
    """``n`` consecutive days ending at ``end``, i.e. one day-with-data each."""
    return [end - dt.timedelta(days=i) for i in range(n)]


def _day_list(monkeypatch, sources, today=TODAY, **kwargs) -> list[dt.date]:
    """Run the real day query against a fake corpus, one day set per table."""
    monkeypatch.setattr(bs, "_utc_today", lambda: today)
    monkeypatch.setattr(db, "get_conn", lambda: _DayQueryConn(sources, []))
    return bs.token_source_days(USER, **kwargs)


BUDGET = bs.SERIALIZE_WINDOW_DAYS + 1


def test_event_floor_reserves_at_most_half_the_budget():
    """
    The floor is a reservation carved out of a fixed budget, so its size is the
    whole trade-off: too small and an archival corpus still starves, too large
    and recent context does. Half is the largest value that cannot starve the
    recent end — the fill tier always keeps the majority of the slots.
    """
    assert 0 < bs.EVENT_DAY_FLOOR * 2 <= BUDGET


def test_day_list_is_the_newest_days_when_every_day_holds_both_sources(monkeypatch):
    """
    The normal live appliance: an event and an hourly summary on every day. The
    two tiers draw from overlapping sets, so the answer is the newest 91 days —
    byte for byte what the flat LIMIT returned. No behaviour change.
    """
    days = _run_back(TODAY, 200)
    got = _day_list(
        monkeypatch,
        {"FROM ci.events": days, "FROM ci.summaries": days},
    )
    assert got == sorted(_run_back(TODAY, BUDGET))


def test_day_list_is_the_newest_event_days_with_no_summaries(monkeypatch):
    """Events only: the reservation and the fill both draw from one set."""
    got = _day_list(monkeypatch, {"FROM ci.events": _run_back(TODAY, 200)})
    assert got == sorted(_run_back(TODAY, BUDGET))


def test_day_list_is_the_newest_summary_days_with_no_events(monkeypatch):
    """
    Summaries only (a fresh appliance capturing before anything is imported):
    the reservation finds no event day, so the fill takes the whole budget. A
    floor that consumed its slots whether or not events existed would leave 45
    of them empty here.
    """
    got = _day_list(monkeypatch, {"FROM ci.summaries": _run_back(TODAY, 200)})
    assert got == sorted(_run_back(TODAY, BUDGET))


def test_day_list_reserves_event_days_on_a_bimodal_corpus(monkeypatch):
    """
    THE FIX. Archival import (events stop 2024-01-15) plus continuous live
    capture (hourly summaries every day since). Under the flat LIMIT the 120
    summary days are all newer than every event day, so the budget is spent
    entirely on them and ZERO events reach hbpe.token_stream — the hard-labeled
    corpus is silently replaced by the 0.7-confidence gap-filler.

    With the floor, the newest EVENT_DAY_FLOOR event days are reserved first and
    the remaining slots go to the newest content days of either kind.
    """
    last_event = dt.date(2024, 1, 15)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": _run_back(last_event, 200),
            "FROM ci.summaries": _run_back(TODAY, 120),
        },
    )

    reserved = sorted(_run_back(last_event, bs.EVENT_DAY_FLOOR))
    fill = sorted(_run_back(TODAY, BUDGET - bs.EVENT_DAY_FLOOR))
    assert got == reserved + fill
    assert len(got) == BUDGET
    # The two ends the flat budget could not hold at once.
    assert got[0] == last_event - dt.timedelta(days=bs.EVENT_DAY_FLOOR - 1)
    assert got[-1] == TODAY


def test_event_reservation_shrinks_to_the_event_days_that_exist(monkeypatch):
    """
    Ten event days and a floor of 45: the reservation takes what there is and
    the fill takes the other 81 slots. A fixed-size carve-out would waste 35.
    """
    last_event = dt.date(2024, 1, 15)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": _run_back(last_event, 10),
            "FROM ci.summaries": _run_back(TODAY, 120),
        },
    )

    assert len(got) == BUDGET
    assert got[:10] == sorted(_run_back(last_event, 10))
    assert got[10:] == sorted(_run_back(TODAY, BUDGET - 10))


def test_event_floor_never_outgrows_a_shortened_window(monkeypatch):
    """
    ``window_days`` is a parameter — HBPE_LABEL_RECENCY_DAYS reaches this
    through label_recency_start — so the floor has to scale with the budget it
    is carved out of. A literal 45 against an 11-day budget would return 45 days
    of 2024 and no recent day at all: MORE work than the budget allows, and the
    inverse of the starvation it exists to prevent.
    """
    last_event = dt.date(2024, 1, 15)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": _run_back(last_event, 200),
            "FROM ci.summaries": _run_back(TODAY, 120),
        },
        window_days=10,
    )

    assert len(got) == 11
    assert got[:5] == sorted(_run_back(last_event, 5))
    assert got[5:] == sorted(_run_back(TODAY, 6))


def test_purge_days_are_added_on_top_of_the_content_budget(monkeypatch):
    """
    A day that emptied out is delete-only work — serialize_day's DELETE is the
    only purge of hbpe.token_stream there is — and a day whose stale rows are
    never purged keeps nudging the forecast forever. Taking those visits out of
    the content budget would let a handful of deletions evict real days, so they
    ride on top of it.
    """
    live = _run_back(TODAY, 200)
    emptied = _run_back(dt.date(2020, 5, 1), 5)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": live,
            "FROM hbpe.token_stream": [*live, *emptied],
        },
    )

    assert got[5:] == sorted(_run_back(TODAY, BUDGET))
    assert got[:5] == sorted(emptied)
    assert len(got) == BUDGET + 5


def test_purge_tier_leaves_token_stream_history_that_still_has_a_source(
    monkeypatch,
):
    """
    The purge tier selects SOURCE-LESS days, not "days the budget did not
    select" — and on top of a budget rather than inside it, that distinction is
    the difference between a purge and a nightly amnesia.

    hbpe.token_stream deliberately holds far more history than the 91-day
    serialize budget: recurrence.HISTORY_DAYS reads 180 days of it and
    seasonal.MAX_HISTORY_DAYS 800, and every one of those days still has its
    event behind it. Here 200 days hold both an event and tokens, so 109 of them
    are outside the content budget — and none of them may be visited, because
    serialize_day's DELETE is what a visit means.
    """
    live = _run_back(TODAY, 200)
    got = _day_list(
        monkeypatch,
        {"FROM ci.events": live, "FROM hbpe.token_stream": live},
    )

    assert got == sorted(_run_back(TODAY, BUDGET))


def test_purge_days_are_capped_so_one_bulk_delete_cannot_run_all_night(
    monkeypatch,
):
    """
    The cap is why "on top of the budget" is safe: a year of events deleted at
    once cannot turn one night into an unbounded serialize_day run. The set only
    ever shrinks — every day visited is purged and never returns — so the
    leftovers converge over subsequent nights.
    """
    live = _run_back(TODAY, 200)
    emptied = _run_back(dt.date(2020, 5, 1), 500)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": live,
            "FROM hbpe.token_stream": [*live, *emptied],
        },
    )

    assert len(got) == BUDGET + bs.PURGE_DAY_CAP
    # Newest-first within the purge tier: the stale days closest to the live
    # window are the ones a forecast can still read.
    assert got[: bs.PURGE_DAY_CAP] == sorted(
        _run_back(dt.date(2020, 5, 1), bs.PURGE_DAY_CAP)
    )


# ── Tier A must agree with the reads it predicts ──────────────────────────────


PLANNED_ONLY = _DayQueryCursor._PLANNED_ONLY


def test_reserved_tier_ignores_days_whose_only_events_are_planned_blocks(monkeypatch):
    """
    A reserved slot is only worth something if the day it reserves produces
    tokens. Both reads this query predicts — the serializer's
    (data_client.get_token_events_for_day) and the drain's
    (data_client._unlabeled_events_where) — carry ``event_type IS DISTINCT FROM
    'planned_block'``, so a day whose only events are planning's own suggested
    blocks serializes to ZERO event tokens and has nothing to label.

    Without the same predicate here, an appliance that uses planning writes one
    such day per calendar day and they are the NEWEST event days there are, so
    tier A spends all 45 reserved slots on them and the fill takes the rest —
    the archival corpus tier A exists to protect is evicted anyway, on exactly
    the bimodal shape it targets. Here the 60 planned-block days would take 60
    of the 91 slots and leave 31 real event days; with the predicate the budget
    is 91 real event days and no planned-block day at all.
    """
    last_event = dt.date(2024, 1, 15)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": _run_back(last_event, 200),
            PLANNED_ONLY: _run_back(TODAY, 60),
        },
    )

    assert got == sorted(_run_back(last_event, BUDGET))


def test_purge_tier_reclaims_a_day_left_holding_only_planned_blocks(monkeypatch):
    """
    The same predicate on the other side of the query. 2024-06-03 held a real
    event, serialize wrote its tokens, and the event was later replaced by (or
    reduced to) a planned block. Nothing the serializer reads is left on that
    day, so its rows are stale — but an ``event_days`` that counts planned
    blocks as a source excludes the day from tier C, and those rows then feed
    pipeline.recurrence forever with no way to ever remove them.
    """
    live = _run_back(TODAY, 200)
    stranded = dt.date(2024, 6, 3)
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": live,
            PLANNED_ONLY: [stranded],
            "FROM hbpe.token_stream": [*live, stranded],
        },
    )

    assert stranded in got
    assert got == [stranded, *sorted(_run_back(TODAY, BUDGET))]


# ── Each tier's ORDER BY direction ────────────────────────────────────────────
#
# The direction is policy, and it is the cheapest thing in the query to get
# wrong: ASC parses, runs, returns a full budget, and is silently worse than the
# bug the tiers were added to fix. These three pin one direction each.


def test_reservation_takes_the_newest_event_days_not_the_oldest(monkeypatch):
    """
    Tier A reserves the event days ADJACENT to the live window. Flipped to ASC
    it reserves the oldest 45 days the import ever recorded — the least
    predictive history there is — and drops the recent end of the event corpus,
    which is the half a forecast can still use.
    """
    last_event = dt.date(2024, 1, 15)
    events = _run_back(last_event, 200)
    got = _day_list(
        monkeypatch,
        {"FROM ci.events": events, "FROM ci.summaries": _run_back(TODAY, 120)},
    )

    assert got[: bs.EVENT_DAY_FLOOR] == sorted(
        _run_back(last_event, bs.EVENT_DAY_FLOOR)
    )
    assert min(events) not in got


def test_fill_tier_takes_the_newest_content_days_not_the_oldest(monkeypatch):
    """
    Tier B is what keeps recent context in the budget at all. Flipped to ASC on
    a bimodal corpus it spends its 46 slots on the OLDEST event days instead, so
    the whole 91-day budget lands in 2023 and not one selected day falls inside
    the last 90 — every live summary day is evicted, which is strictly worse
    than the summary-eviction the tiers were added to prevent.
    """
    got = _day_list(
        monkeypatch,
        {
            "FROM ci.events": _run_back(dt.date(2024, 1, 15), 200),
            "FROM ci.summaries": _run_back(TODAY, 120),
        },
    )

    recent = [d for d in got if d > TODAY - dt.timedelta(days=90)]
    assert max(got) == TODAY
    assert len(recent) == BUDGET - bs.EVENT_DAY_FLOOR


def test_purge_tier_takes_the_newest_stale_days_not_the_oldest(monkeypatch):
    """
    Tier C is capped, so on a large backlog its direction decides which emptied
    days are cleaned first. Newest-first is the only useful order: the stale
    rows closest to the live window are the ones pipeline.recurrence still
    reads, so ASC would spend every night's cap on rows no forecast can see
    while the ones that skew it survive.
    """
    live = _run_back(TODAY, 200)
    emptied = _run_back(dt.date(2020, 12, 31), 500)
    got = _day_list(
        monkeypatch,
        {"FROM ci.events": live, "FROM hbpe.token_stream": [*live, *emptied]},
    )

    assert max(emptied) in got
    assert min(emptied) not in got


# ── The purge tier's bounds: count, and reach ─────────────────────────────────


def test_purge_cap_scales_with_a_shortened_window(monkeypatch):
    """
    ``window_days`` is a caller parameter, so a flat purge cap breaks the bound
    it exists to hold. An 11-day budget with a literal cap of 91 makes a night
    of 11 content days and 91 purge days — eight times the work the caller asked
    for — where the constant's own claim is "at worst twice the content budget".
    EVENT_DAY_FLOOR is clamped for the same reason; so is this.
    """
    live = _run_back(TODAY, 200)
    emptied = _run_back(dt.date(2020, 12, 31), 300)
    got = _day_list(
        monkeypatch,
        {"FROM ci.events": live, "FROM hbpe.token_stream": [*live, *emptied]},
        window_days=10,
    )

    assert len(got) == 11 + 11
    assert got[11:] == sorted(_run_back(TODAY, 11))
    assert got[:11] == sorted(_run_back(dt.date(2020, 12, 31), 11))


def test_label_cutoff_reads_the_oldest_content_day_not_the_oldest_purge_day(
    monkeypatch,
):
    """
    THE SECOND FIX. The purge tier is capped in COUNT but deliberately not in
    REACH — reaching back is the whole point, since a day that emptied out below
    the 91st newest was never revisited under the old policy. That makes the
    oldest day of the merged list an arbitrarily old source-less day.

    ``label_recency_start`` returns that oldest day, and
    ``nightly_runner._recency_cutoff`` turns it into the label drain's phase
    boundary. Merged, this corpus — dense for 200 days, plus 300 source-less
    2020 token_stream days — moves the boundary from 2026-06-01 to 2020, so the
    recency phase (80% of the nightly label budget) stops being a recency phase
    at all and the days a forecast can actually read lose their priority.

    A purge day has no event and no summary on it, so there is no label on it
    for that cutoff to protect. Serialize still visits every one of them.
    """
    live = _run_back(TODAY, 200)
    emptied = _run_back(dt.date(2020, 12, 31), 300)
    sources = {
        "FROM ci.events": live,
        "FROM hbpe.token_stream": [*live, *emptied],
    }

    monkeypatch.setattr(bs, "_utc_today", lambda: TODAY)
    monkeypatch.setattr(db, "get_conn", lambda: _DayQueryConn(sources, []))

    assert bs.label_recency_start(USER, 90) == dt.date(2026, 6, 1)
    assert nr._recency_cutoff(USER, 90) == CUTOFF
    # And the purge reach itself is untouched: clamping it would have been the
    # wrong repair, because those 2020 days are precisely the ones whose stale
    # rows have been feeding pipeline.recurrence unchallenged.
    assert min(bs.token_source_days(USER)) == max(emptied) - dt.timedelta(
        days=bs.PURGE_DAY_CAP - 1
    )


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
    # All-future: the day list clamps it away and serialize_window of its real
    # bounds is None too, so both legs of the fallback fire.
    _pin_corpus(monkeypatch, (dt.date(2026, 9, 1), dt.date(2026, 10, 15)))
    assert nr._recency_cutoff(USER, 90) == CUTOFF

    _pin_corpus(monkeypatch, None)
    assert nr._recency_cutoff(USER, 90) == CUTOFF

    def _boom(_uid):
        raise RuntimeError("no database")

    monkeypatch.setattr(bs, "event_date_bounds", _boom)
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

    On a dense corpus the day list and the contiguous window agree exactly,
    which is what makes this cross-check meaningful: the cutoff is now the
    oldest day of the list, and it must still land on the window's start.

    Both sides are production code — the real ``_TOKEN_SOURCE_DAYS_SQL`` (its
    ORDER BY, LIMIT and clamp interpreted by the fake connection) against
    ``serialize_window``'s arithmetic. Swapping the query's ``window_days + 1``
    budget for a literal 200 turns four of the five cases red — every one whose
    corpus is longer than the budget, which the brand-new appliance is not.
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
    """
    Capture the SQL get_unlabeled_events emits, with the REAL kind predicate.

    This used to stub ``mapped_kind_sql`` out to the constant ``FALSE``, which
    is exactly why nothing here caught the map joining on the wrong column for
    two releases: the one part of this WHERE clause that had a bug was the one
    part the tests replaced. It contributes no bind parameters, so letting the
    real predicate through changes none of the param-order assertions below.
    """
    calls: list = []
    monkeypatch.setattr(dc, "get_conn", lambda: _RecordingConn(calls))
    monkeypatch.setattr(dc, "_ensure_events_cti_schema", lambda conn: None)
    dc.get_unlabeled_events(USER, **kwargs)
    return calls[0]


def test_default_query_is_unchanged_oldest_first_full_history(monkeypatch):
    sql, params = _capture(monkeypatch)
    assert "ORDER BY e.start_time, e.event_id LIMIT" in sql
    assert "DESC" not in sql
    assert "::timestamptz" not in sql.replace("'2010-01-01'::timestamptz", "")
    assert params == [USER, 1000]


def test_drain_excludes_mapped_kinds_on_the_capture_kind_column(monkeypatch):
    """
    The static labeler and the LLM drain must partition the corpus, and they
    only do so while both key on the same column. ci.events.event_type holds
    the importer's bare-verb classification ('listen'), hbpe.kind_l0_map holds
    the dotted capture kind ('media.listen'), and the two never overlap — so a
    drain that excluded on event_type excluded nothing and sent all 195k
    ambient events to the chat LLM one at a time.
    """
    sql, _ = _capture(monkeypatch)
    assert "NOT ( EXISTS ( SELECT 1 FROM hbpe.kind_l0_map m" in sql
    assert "(e.metadata->>'kind') LIKE m.kind_pattern" in sql
    assert "e.event_type LIKE" not in sql


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


# ── Which days serialize writes (bootstrap) ───────────────────────────────────


_SERIALIZED_DAYS: list[str] = []
_ROWS_PER_DAY = 59


class _DaySerializer:
    def serialize_day(self, user_id, date_str):
        _SERIALIZED_DAYS.append(date_str)
        return _ROWS_PER_DAY


def _run_serialize(monkeypatch, days, bounds=None, today=TODAY):
    """
    Drive serialize_token_stream against a fake days-with-data read.

    ``days`` is what the day-list query returns — already clamped to today and
    LIMITed, as the real SQL does, and in the query's DESC order. ``bounds`` is
    what the fallback bounds query returns, and is consulted only when ``days``
    is empty, to tell an empty corpus from an entirely future-dated one.
    """
    _SERIALIZED_DAYS.clear()

    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchall(self):
            # (source_date, is_content); this fake models content days only.
            return [(d.isoformat(), True) for d in sorted(days, reverse=True)]

        def fetchone(self):
            return bounds if bounds is not None else (None, None)

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
    monkeypatch.setattr(ser, "TokenSerializer", _DaySerializer)
    monkeypatch.setattr(tr, "rebuild_token_rollups", lambda uid: {"days": 0})
    monkeypatch.setattr(bs, "_utc_today", lambda: today)
    return asyncio.run(bs.serialize_token_stream(USER))


def _dense_days(end: dt.date, n: int) -> list[dt.date]:
    return [end - dt.timedelta(days=i) for i in range(n)]


def test_serialize_writes_every_returned_day_oldest_first(monkeypatch):
    """
    The query hands back the newest days first (that is how the LIMIT picks the
    budget); serialize must walk them chronologically, and write each exactly
    once. serialize_day deletes and rewrites one (user, date), so a duplicated
    day is wasted work and a skipped one is a hole in hbpe.token_stream.
    """
    days = _dense_days(dt.date(2026, 8, 30), 91)
    result = _run_serialize(monkeypatch, days)

    assert _SERIALIZED_DAYS == [d.isoformat() for d in sorted(days)]
    assert result["start"] == "2026-06-01"
    assert result["end"] == "2026-08-30"
    assert result["days"] == 91
    assert result["rows"] == 91 * _ROWS_PER_DAY


def test_serialize_of_an_archival_corpus_keeps_its_own_days(monkeypatch):
    """
    An appliance whose data stops two years ago must keep serializing its own
    most recent 90 days; anchoring the range on today would give it an empty
    range, rows: 0, and a bootstrap abort with no_token_data.
    """
    days = _dense_days(dt.date(2024, 1, 15), 91)
    _run_serialize(monkeypatch, days)

    assert _SERIALIZED_DAYS[0] == "2023-10-17"
    assert _SERIALIZED_DAYS[-1] == "2024-01-15"


def test_serialize_keeps_the_archival_event_days_and_todays_summary_day(monkeypatch):
    """
    The bimodal corpus, which a contiguous window cannot express at all.

    Imported events stop on 2024-01-15; ci.summaries keeps writing hourly rows,
    so 2026-08-30 also holds data. A (MIN, MAX) window ending at MAX puts the
    whole 90 days in 2026 and serializes ZERO events — the historical corpus
    silently drops out of hbpe.token_stream and is replaced by summary tokens at
    SUMMARY_SOFT_PROB. A window ending at the last event strands the new summary
    instead. The day list holds both ends inside the same 90-day budget.
    """
    days = [*_dense_days(dt.date(2024, 1, 15), 90), dt.date(2026, 8, 30)]
    result = _run_serialize(monkeypatch, days)

    assert "2024-01-15" in _SERIALIZED_DAYS
    assert "2026-08-30" in _SERIALIZED_DAYS
    assert _SERIALIZED_DAYS[0] == "2023-10-18"  # oldest event day still in budget
    assert _SERIALIZED_DAYS[-1] == "2026-08-30"
    # The gap costs nothing: 91 serialize_day calls, not the ~960 a range
    # spanning 2023-10-18..2026-08-30 would have made.
    assert len(_SERIALIZED_DAYS) == 91
    assert result["days"] == 91


def test_serialize_revisits_a_day_whose_only_content_is_stale_tokens(monkeypatch):
    """
    A day that EMPTIED OUT must still reach serialize_day, whose DELETE is the
    only purge of hbpe.token_stream anywhere in the repo.

    Event E is the only event on 2024-06-03 and serialize wrote its tokens. The
    user deletes E — CalendarEventService soft-deletes, and the day-list query
    filters ``is_deleted = FALSE``. Selecting only days that currently hold data
    drops 2024-06-03 from every subsequent run, so its rows sit in
    hbpe.token_stream indefinitely while pipeline.recurrence and HMT training
    keep reading a deleted event. The contiguous serialize_range this replaced
    purged the day for free by walking every calendar day in the window.

    Runs against the real day query: the fake connection folds in a table's days
    only when the SQL selects ``FROM`` it, so dropping the token_stream branch
    drops the day here too.
    """
    _SERIALIZED_DAYS.clear()
    emptied = dt.date(2024, 6, 3)
    live = dt.date(2026, 8, 30)

    import ci.hbpe.pipeline.token_rollup as tr
    import ci.hbpe.tokenizer.serializer as ser

    monkeypatch.setattr(
        db,
        "get_conn",
        lambda: _DayQueryConn(
            {
                "FROM ci.summaries": [live],
                # The emptied day is gone from both sources and survives only as
                # the stale rows the purge has to remove.
                "FROM hbpe.token_stream": [emptied, live],
            },
            [],
        ),
    )
    monkeypatch.setattr(ser, "TokenSerializer", _DaySerializer)
    monkeypatch.setattr(tr, "rebuild_token_rollups", lambda _uid: {"days": 0})
    monkeypatch.setattr(bs, "_utc_today", lambda: TODAY)

    result = asyncio.run(bs.serialize_token_stream(USER))

    assert _SERIALIZED_DAYS == ["2024-06-03", "2026-08-30"]
    # Both days are serialized, but they are REPORTED apart: "days" counts the
    # content tiers the model actually trains on, "purge_days" the delete-only
    # work riding on top. Merging them let a purge day years behind the corpus
    # set the reported start date — the same days[0] conflation that let tier C
    # hijack label_recency_start.
    assert result["days"] == 1
    assert result["purge_days"] == 1
    assert result["start"] == "2026-08-30"
    assert result["end"] == "2026-08-30"


def test_serialize_reports_a_corpus_that_is_entirely_in_the_future(monkeypatch):
    """
    The day list clamps future dates away, so an all-future corpus comes back
    empty. The bounds query is what still distinguishes it from no corpus at
    all — the reason string is the operator's only signal for the abort.
    """
    result = _run_serialize(
        monkeypatch, [], bounds=(dt.date(2026, 9, 1), dt.date(2026, 10, 15))
    )
    assert result == {"rows": 0, "reason": "only_future_events"}
    assert _SERIALIZED_DAYS == []


def test_serialize_reports_an_empty_corpus(monkeypatch):
    result = _run_serialize(monkeypatch, [], bounds=None)
    assert result == {"rows": 0, "reason": "no_events"}
    assert _SERIALIZED_DAYS == []


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
