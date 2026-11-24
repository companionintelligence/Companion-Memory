"""Tests for bounded historical hourly-summary labeling."""

from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import data_client as dc  # noqa: E402
from ci.hbpe import database as db  # noqa: E402
from ci.hbpe import functions  # noqa: E402
from ci.hbpe.event_status import LIVE_EVENT_SQL  # noqa: E402
from ci.hbpe.inference import qwen as qwen_mod  # noqa: E402
from ci.hbpe.pipeline import bootstrap as bs  # noqa: E402
from ci.hbpe.pipeline import nightly_runner as nr  # noqa: E402
from ci.hbpe.tokenizer import summary_tokenizer as st  # noqa: E402
from ci.hbpe.tokenizer import vocab_registry as vr  # noqa: E402

USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"


class _Cursor:
    def __init__(self, rows: list[dict], calls: list[tuple]) -> None:
        self.rows = rows
        self.calls = calls

    def execute(self, sql, params=None):
        self.calls.append((" ".join(str(sql).split()), tuple(params or ())))

    def fetchall(self):
        return self.rows

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, rows: list[dict], calls: list[tuple]) -> None:
        self.rows = rows
        self.calls = calls

    def cursor(self, **_kwargs):
        return _Cursor(self.rows, self.calls)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _ScalarCursor:
    """Records SQL and replays one canned result for fetchone/fetchall."""

    def __init__(self, result, calls: list[tuple]) -> None:
        self.result = result
        self.calls = calls

    def execute(self, sql, params=None):
        self.calls.append((" ".join(str(sql).split()), tuple(params or ())))

    def fetchone(self):
        return self.result

    def fetchall(self):
        return self.result

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _ScalarConn:
    def __init__(self, result, calls: list[tuple]) -> None:
        self.result = result
        self.calls = calls

    def cursor(self, **_kwargs):
        return _ScalarCursor(self.result, self.calls)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def test_token_source_days_cover_events_and_summaries_and_clamp_to_today(monkeypatch):
    """
    The day list is the serializer's target, so both dated sources have to be in
    it and nothing after today may be, or a future-dated calendar row consumes
    one of the LIMIT slots and pushes a real day out of the budget.
    """
    calls: list[tuple] = []
    rows = [("2026-08-30", True), ("2024-01-15", True)]
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn(rows, calls))

    days = bs.token_source_days(USER, window_days=90, today=dt.date(2026, 8, 30))

    # Returned oldest-first even though the query hands back newest-first.
    assert days == [dt.date(2024, 1, 15), dt.date(2026, 8, 30)]
    sql, params = calls[0]
    assert "FROM ci.events e" in sql
    assert "FROM ci.summaries s" in sql
    assert "s.period_type = 'hourly'" in sql
    assert "SELECT DISTINCT" in sql
    # The two source branches are UNIONed — a day holding both an event and a
    # summary is one day. The final SELECT is UNION ALL because it carries the
    # content/purge tag that keeps label_recency_start off the purge days, and
    # the two sets are already disjoint (purge excludes both source branches).
    assert (
        "SELECT source_date FROM event_days UNION SELECT source_date FROM summary_days"
        in sql
    )
    assert (
        "SELECT source_date, TRUE AS is_content FROM content "
        "UNION ALL SELECT source_date, FALSE AS is_content FROM purge" in sql
    )
    assert "ORDER BY source_date DESC LIMIT" in sql
    assert "e.start_time < (%s::date + INTERVAL '1 day')" in sql
    assert "s.period_start < (%s::date + INTERVAL '1 day')" in sql
    # user_id/today per source branch, then the event-day reservation and the
    # content budget, then the purge branch's own user_id/today and its cap.
    #
    # The budget is inclusive on both ends, so 90 window days is 91 calendar
    # days, matching the old contiguous range's width. The floor is half of it —
    # the largest reservation that still leaves the fill tier a majority of the
    # slots for recent context.
    today = dt.date(2026, 8, 30)
    assert bs.EVENT_DAY_FLOOR == 45
    assert params == (USER, today, USER, today, 45, 91, USER, today, 91)


def test_token_source_days_exclude_planning_blocks_like_both_reads_do(monkeypatch):
    """
    The day query PREDICTS two reads, and it has to carry their predicates or a
    selected slot buys nothing. ``data_client.get_token_events_for_day`` (what
    the serializer publishes) and ``data_client._unlabeled_events_where`` (what
    the drain labels) both filter ``event_type IS DISTINCT FROM
    'planned_block'`` — planning's own suggested blocks, written by
    PlannedBlockService, are the appliance's output rather than observed
    behaviour. A day holding only those serializes to zero event tokens.

    Asserted as the whole event branch, not as a loose substring: the predicate
    has to be in ``event_days`` (and in the bounds query, its fallback), not
    merely somewhere in the file.
    """
    calls: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn([], calls))
    bs.token_source_days(USER, today=dt.date(2026, 8, 30))
    bs.event_date_bounds(USER)

    day_sql, bounds_sql = calls[0][0], calls[1][0]
    assert (
        "event_days AS ( SELECT DISTINCT e.start_time::date AS source_date "
        "FROM ci.events e WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE "
        "AND e.event_type IS DISTINCT FROM 'planned_block'" in day_sql
    )
    assert (
        "FROM ci.events e WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE "
        "AND e.event_type IS DISTINCT FROM 'planned_block'" in bounds_sql
    )


def test_token_source_days_exclude_events_that_did_not_happen_like_both_reads_do(
    monkeypatch,
):
    """
    The status half of the same rule. Both reads the day query predicts leave
    out events that did not happen (event_status.LIVE_EVENT_SQL: cancelled,
    no_show, skipped), so the event branch has to as well. A day holding only a
    cancelled meeting yields no event tokens. A day whose last live event is
    cancelled after it was serialized has to drop out of ``event_days``, or the
    purge tier never sees it and the meeting's tokens stay.

    Asserted as the whole event branch, like the planned-block test above.
    """
    calls: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn([], calls))
    bs.token_source_days(USER, today=dt.date(2026, 8, 30))
    bs.event_date_bounds(USER)

    day_sql, bounds_sql = calls[0][0], calls[1][0]
    event_branch = (
        "FROM ci.events e WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE "
        "AND e.event_type IS DISTINCT FROM 'planned_block' "
        f"AND {LIVE_EVENT_SQL} AND e.start_time >= '2010-01-01'::timestamptz"
    )
    assert (
        f"event_days AS ( SELECT DISTINCT e.start_time::date AS source_date {event_branch}"
        in day_sql
    )
    assert event_branch in bounds_sql
    # One read of ci.events in each query, so one copy of the predicate.
    assert day_sql.count(LIVE_EVENT_SQL) == 1
    assert bounds_sql.count(LIVE_EVENT_SQL) == 1


def test_token_source_days_reserve_a_share_of_the_budget_for_event_days(monkeypatch):
    """
    The tiers, in SQL shape. Events carry hard L0/L1 labels; hourly summaries
    are the SUMMARY_SOFT_PROB (0.7) gap-filler. A flat ``ORDER BY source_date
    DESC LIMIT 91`` over their union therefore hands the whole corpus to the
    weaker source on any appliance with both an archival import and live
    capture: summaries accrue one day-with-data per calendar day, so about 91
    days after the import every imported event day is evicted from the budget.

    ``reserved`` takes the newest EVENT_DAY_FLOOR event days first; ``fill``
    takes the newest remaining days of either kind for whatever the reservation
    left — an expression, not a literal, so an absent or short event corpus
    hands its slots back to the fill instead of wasting them.
    """
    calls: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn([], calls))

    bs.token_source_days(USER, window_days=90, today=dt.date(2026, 8, 30))

    sql, _params = calls[0]
    # The whole reserved CTE, not a prefix of it: widening its source to the
    # union is exactly the mutation that undoes the fix while leaving every
    # other assertion here true.
    assert (
        "reserved AS ( SELECT source_date FROM event_days "
        "ORDER BY source_date DESC LIMIT %s )" in sql
    )
    assert "fill AS (" in sql
    assert "LIMIT GREATEST(%s - (SELECT count(*) FROM reserved), 0)" in sql
    # The fill draws from BOTH sources, minus what the reservation already took.
    assert (
        "SELECT source_date FROM event_days UNION SELECT source_date FROM summary_days"
        in sql
    )
    assert "FROM reserved r WHERE r.source_date = content_days.source_date" in sql


def test_token_source_days_revisit_days_that_only_hold_stale_tokens(monkeypatch):
    """
    serialize_day's DELETE is the only purge of hbpe.token_stream there is, and
    it only runs on days this query returns. A day can EMPTY OUT — its sole
    event soft-deleted, or its start_time edited onto another day — and it then
    disappears from both source branches, so without a token_stream branch its
    rows survive indefinitely while pipeline.recurrence and HMT training keep
    reading a deleted event. The contiguous serialize_range this replaced purged
    such days for free by walking every calendar day in the window.
    """
    calls: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn([], calls))

    today = dt.date(2026, 8, 30)
    bs.token_source_days(USER, window_days=90, today=today)

    sql, params = calls[0]
    assert "FROM hbpe.token_stream ts" in sql
    assert "SELECT DISTINCT ts.date AS source_date" in sql
    # Clamped like the other two branches: a future-dated stale row would
    # otherwise be visited ahead of days that can still be read.
    assert "ts.date < (%s::date + INTERVAL '1 day')" in sql
    # Delete-only work, and correctness-critical: a day whose stale rows are
    # never purged keeps nudging the forecast forever. So the purge tier is
    # added ON TOP of the content budget — days it visits are excluded from the
    # content tiers rather than competing with them — under its own cap, which
    # is what keeps one bulk delete from making a single night unbounded. The
    # set only ever shrinks (a visited day is purged and never returns), so the
    # leftovers converge over subsequent nights.
    #
    # What it selects is SOURCE-LESS days, not "days outside the budget": those
    # are two different sets once the tier sits on top of the budget rather than
    # inside it. hbpe.token_stream holds far more history than 91 days —
    # recurrence reads 180 and seasonal 800 — so purging everything the budget
    # did not select would delete the profiler's history every night.
    assert "FROM event_days e WHERE e.source_date = stale.source_date" in sql
    assert "FROM summary_days s WHERE s.source_date = stale.source_date" in sql
    assert params[-3:] == (USER, today, 91)
    assert bs.PURGE_DAY_CAP == 91


def test_token_source_days_omit_the_always_empty_tasks_branch(monkeypatch):
    """
    ci.tasks.l0_class has no writer anywhere in the repo — that is why
    data_client._completed_tasks_l0_class_populated() probes it once per process
    and short-circuits. A ``l0_class <> 'UNKNOWN'`` union branch here would put
    the same always-empty scan back into the hot path of both serialize-day
    queries, and could never contribute a day.
    """
    calls: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn([], calls))
    bs.token_source_days(USER, today=dt.date(2026, 8, 30))
    bs.event_date_bounds(USER)

    for sql, _params in calls:
        assert "ci.tasks" not in sql
        assert "l0_class" not in sql


def test_event_date_bounds_still_span_events_and_summaries(monkeypatch):
    """
    Kept as the label drain's fallback cutoff and as the only cheap way to tell
    an empty corpus from an entirely future-dated one, so it must still see both
    sources — but it no longer decides what serialize writes.
    """
    calls: list[tuple] = []
    bounds = (dt.date(2026, 6, 1), dt.date(2026, 9, 2))
    monkeypatch.setattr(db, "get_conn", lambda: _ScalarConn(bounds, calls))

    assert bs.event_date_bounds(USER) == bounds
    sql, params = calls[0]
    assert "FROM ci.events e" in sql
    assert "FROM ci.summaries s" in sql
    assert "s.period_type = 'hourly'" in sql
    assert params == (USER, USER)


def test_range_reader_selects_only_unlabeled_hourly_summaries(monkeypatch):
    calls: list[tuple] = []
    rows = [
        {
            "summary_id": "summary-1",
            "period_start": dt.datetime(2026, 8, 1, tzinfo=dt.UTC),
            "content": {"summary_text": "grounded hour"},
        }
    ]
    monkeypatch.setattr(dc, "get_conn", lambda: _Conn(rows, calls))

    result = dc.get_unlabeled_summaries_in_range(USER, "2026-08-01", "2026-08-03")

    assert result == rows
    sql, params = calls[0]
    assert "s.period_type = 'hourly'" in sql
    assert "LEFT JOIN hbpe.summary_l1_label" in sql
    assert "label.summary_id IS NULL" in sql
    assert "s.period_start >= %s::date" in sql
    assert "s.period_start < (%s::date + INTERVAL '1 day')" in sql
    assert params == (USER, "2026-08-01", "2026-08-03")


def test_day_set_reader_matches_an_explicit_non_contiguous_day_list(monkeypatch):
    """
    The serialize day list jumps the gap on a bimodal corpus, so the reader must
    select the days themselves. The MIN/MAX range predicate rides along because
    ``period_start::date = ANY(...)`` is not sargable on its own — without it
    the planner has nothing index-usable and scans every hourly summary.
    """
    calls: list[tuple] = []
    rows = [
        {
            "summary_id": "summary-1",
            "period_start": dt.datetime(2026, 8, 30, tzinfo=dt.UTC),
            "content": {"summary_text": "grounded hour"},
        }
    ]
    monkeypatch.setattr(dc, "get_conn", lambda: _Conn(rows, calls))

    result = dc.get_unlabeled_summaries_on_days(
        USER, ["2026-08-30", "2024-01-15", "2024-01-15"]
    )

    assert result == rows
    sql, params = calls[0]
    assert "s.period_start::date = ANY(%s::date[])" in sql
    assert "s.period_start >= %s::date" in sql
    assert "s.period_start < (%s::date + INTERVAL '1 day')" in sql
    assert "label.summary_id IS NULL" in sql
    # Deduped and sorted; the range brackets the list it selects.
    assert params == (USER, "2024-01-15", "2026-08-30", ["2024-01-15", "2026-08-30"])


def test_day_set_reader_does_not_query_for_an_empty_day_list(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(dc, "get_conn", lambda: _Conn([], calls))
    assert dc.get_unlabeled_summaries_on_days(USER, []) == []
    assert calls == []


def test_tokenizer_labels_the_day_list_in_one_read(monkeypatch):
    rows = [{"summary_id": "summary-1", "content": {"summary_text": "work"}}]
    fetched: list[tuple] = []
    labeled: list[tuple] = []

    def fetch(user_id: str, dates: list[str]):
        fetched.append((user_id, tuple(dates)))
        return rows

    def label(self, user_id, supplied, scope, should_continue=None):
        labeled.append((user_id, supplied, scope))
        return 1

    monkeypatch.setattr(dc, "get_unlabeled_summaries_on_days", fetch)
    monkeypatch.setattr(st.SummaryTokenizer, "_label_rows", label)

    result = st.SummaryTokenizer().label_days(USER, ["2024-01-15", "2026-08-30"])

    assert result == 1
    assert fetched == [(USER, ("2024-01-15", "2026-08-30"))]
    assert labeled[0][2] == "days=2 first=2024-01-15 last=2026-08-30"


def test_tokenizer_range_uses_one_range_read_and_shared_labeler(monkeypatch):
    rows = [{"summary_id": "summary-1", "content": {"summary_text": "work"}}]
    fetched: list[tuple] = []
    labeled: list[tuple] = []

    def fetch(user_id: str, start_date: str, end_date: str):
        fetched.append((user_id, start_date, end_date))
        return rows

    def label(self, user_id, supplied, scope, should_continue=None):
        labeled.append((self, user_id, supplied, scope))
        return 1

    monkeypatch.setattr(dc, "get_unlabeled_summaries_in_range", fetch)
    monkeypatch.setattr(st.SummaryTokenizer, "_label_rows", label)

    tokenizer = st.SummaryTokenizer()
    result = tokenizer.label_range(USER, "2026-08-01", "2026-08-03")

    assert result == 1
    assert fetched == [(USER, "2026-08-01", "2026-08-03")]
    assert labeled == [(tokenizer, USER, rows, "start=2026-08-01 end=2026-08-03")]


async def _immediate_inference(fn):
    return fn(None)


def test_nightly_step_targets_the_serialize_day_list_not_its_span(monkeypatch):
    """
    Same days serialize will write, not the range between them. Spanning the
    two-year gap of a bimodal corpus would fetch every summary inside it and pay
    two Qwen calls apiece for labels serialize is never going to publish.
    """
    calls: list[tuple] = []

    class _Tokenizer:
        def label_days(self, user_id, dates, should_continue=None):
            calls.append((user_id, tuple(dates)))
            return 7

    monkeypatch.setattr(nr, "_run_inference", _immediate_inference)
    monkeypatch.setattr(
        bs,
        "content_source_days",
        lambda _user_id: [dt.date(2024, 1, 15), dt.date(2026, 8, 30)],
    )
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    result = asyncio.run(nr.label_summary_tokens(USER))

    assert calls == [(USER, ("2024-01-15", "2026-08-30"))]
    assert result == {
        "labeled": 7,
        "start_date": "2024-01-15",
        "end_date": "2026-08-30",
        "days": 2,
    }


def test_nightly_step_labels_content_days_only_not_purge_days(monkeypatch):
    """
    Summaries are labeled on ``content_source_days``, not on the full
    ``token_source_days``. A purge day is source-less by construction — having
    no event and no summary is what put it in that tier — so it can only ever
    add a date that matches nothing. That is not free:
    ``get_unlabeled_summaries_on_days`` pairs its ``= ANY(...)`` match with a
    MIN/MAX bracket because the array match is not sargable on its own, so one
    source-less 2020 day widens the planner's bracket across six years of
    hourly summaries.
    """
    calls: list[tuple] = []

    class _Tokenizer:
        def label_days(self, user_id, dates, should_continue=None):
            calls.append((user_id, tuple(dates)))
            return 3

    purged = dt.date(2020, 5, 1)
    monkeypatch.setattr(nr, "_run_inference", _immediate_inference)
    monkeypatch.setattr(bs, "content_source_days", lambda _uid: [dt.date(2026, 8, 30)])
    monkeypatch.setattr(
        bs, "token_source_days", lambda _uid: [purged, dt.date(2026, 8, 30)]
    )
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    result = asyncio.run(nr.label_summary_tokens(USER))

    assert calls == [(USER, ("2026-08-30",))]
    assert result["start_date"] == "2026-08-30"


def test_nightly_step_falls_back_to_yesterday_with_no_serializable_day(monkeypatch):
    calls: list[tuple] = []

    class _Tokenizer:
        def label_days(self, user_id, dates, should_continue=None):
            calls.append((user_id, tuple(dates)))
            return 0

    monkeypatch.setattr(nr, "_run_inference", _immediate_inference)
    monkeypatch.setattr(bs, "content_source_days", lambda _user_id: [])
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    result = asyncio.run(nr.label_summary_tokens(USER))

    yesterday = (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=1)).isoformat()
    assert calls == [(USER, (yesterday,))]
    assert result["start_date"] == yesterday


def test_nightly_step_accepts_an_explicit_recovery_range(monkeypatch):
    calls: list[tuple] = []

    class _Tokenizer:
        def label_range(self, user_id, start_date, end_date, should_continue=None):
            calls.append((user_id, start_date, end_date))
            return 2

    monkeypatch.setattr(nr, "_run_inference", _immediate_inference)
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    result = asyncio.run(
        nr.label_summary_tokens(USER, start_date="2026-08-28", end_date="2026-08-30")
    )

    assert calls == [(USER, "2026-08-28", "2026-08-30")]
    assert result["labeled"] == 2


def test_nightly_step_rejects_recovery_outside_the_serialization_window(
    monkeypatch,
):
    monkeypatch.setattr(nr, "_run_inference", _immediate_inference)

    try:
        asyncio.run(
            nr.label_summary_tokens(
                USER, start_date="2026-05-01", end_date="2026-08-30"
            )
        )
    except ValueError as exc:
        assert "cannot exceed the serialization window" in str(exc)
    else:
        raise AssertionError("expected an oversized recovery range to fail")


def test_nightly_function_forwards_explicit_summary_recovery_dates(monkeypatch):
    forwarded: list[tuple] = []

    async def no_op(*_args, **_kwargs):
        return {}

    async def label_summaries(user_id: str, **kwargs):
        forwarded.append((user_id, kwargs))
        return {"labeled": 0}

    async def no_bootstrap(*_args, **_kwargs):
        return {"needs": False}

    for name in (
        "serialize_token_stream",
        "train_hmt_model",
        "calibrate_and_export_onnx",
    ):
        monkeypatch.setattr(bs, name, no_op)
    for name in (
        "label_unlabeled",
        "l1_stale_sweep",
        "l2_stale_sweep",
        "lora_fine_tune",
        "backfill_actuals",
        "recurrence_profile",
        "drift_detection",
        "cache_invalidation",
    ):
        monkeypatch.setattr(nr, name, no_op)
    monkeypatch.setattr(nr, "label_summary_tokens", label_summaries)
    monkeypatch.setattr(nr, "needs_bootstrap", no_bootstrap)

    asyncio.run(
        functions.nightly(
            USER,
            summary_start_date="2026-08-01",
            summary_end_date="2026-08-30",
        )
    )

    assert forwarded == [
        (
            USER,
            {"start_date": "2026-08-01", "end_date": "2026-08-30"},
        )
    ]


# ── Cancellation ──────────────────────────────────────────────────────────────
#
# _run_inference's contract is that fn(should_stop) polls the event between
# items, so a cancelled task stops at the next item boundary instead of
# zombie-running the rest of the batch on the single-flight inference executor.
# This batch used to be one day (<=24 summaries) and is now the whole serialize
# day list — up to ~2,160 summaries at two Qwen calls each, ~4,300 model calls.


class _FakeQwen:
    """Two-stage labeler stand-in: Stage 1 answers L0, Stage 2 answers L1."""

    def __init__(self) -> None:
        self.calls = 0

    def generate(self, message, system_message=None, max_new_tokens=None):
        self.calls += 1
        return '{"l0": "WORK"}' if "Categories:" in message else '{"l1": "Email"}'


def _stub_labeler(monkeypatch) -> _FakeQwen:
    qwen = _FakeQwen()
    monkeypatch.setattr(qwen_mod, "get_qwen", lambda: qwen)
    monkeypatch.setattr(vr, "get_l1_vocab", lambda _uid, _l0: [])
    monkeypatch.setattr(vr, "get_or_create_l1", lambda _uid, _l0, _l1: ("l1-id", False))
    monkeypatch.setattr(st, "_store_summary_label", lambda *_a: None)
    return qwen


def _summary_rows(n: int) -> list[dict]:
    return [
        {"summary_id": f"summary-{i}", "content": {"summary_text": "answered email"}}
        for i in range(n)
    ]


def test_label_rows_stops_at_the_next_row_when_cancelled(monkeypatch):
    qwen = _stub_labeler(monkeypatch)
    polls = {"n": 0}

    def keep_going() -> bool:
        polls["n"] += 1
        return polls["n"] <= 2

    labeled = st.SummaryTokenizer()._label_rows(
        USER, _summary_rows(50), "days=91", should_continue=keep_going
    )

    # Two rows through, then the poll before the third row ends the batch —
    # not 50 rows and 100 Qwen calls.
    assert labeled == 2
    assert qwen.calls == 4
    assert polls["n"] == 3


def test_label_rows_without_a_predicate_runs_the_whole_batch(monkeypatch):
    qwen = _stub_labeler(monkeypatch)
    labeled = st.SummaryTokenizer()._label_rows(USER, _summary_rows(3), "date=x")
    assert labeled == 3
    assert qwen.calls == 6


def test_stop_poll_adapts_the_inference_event_and_tolerates_its_absence():
    import threading

    event = threading.Event()
    poll = nr._stop_poll(event)
    assert poll() is True
    event.set()
    assert poll() is False
    assert nr._stop_poll(None) is None


def test_nightly_step_hands_the_cancellation_event_to_the_tokenizer(monkeypatch):
    """
    The step's own ``_run(should_stop)`` used to ignore its argument entirely,
    so cancelling the nightly left the whole summary batch running.
    """
    import threading

    seen: list = []

    class _Tokenizer:
        def label_days(self, user_id, dates, should_continue=None):
            seen.append(should_continue)
            return 0

    cancelled = threading.Event()
    cancelled.set()

    async def _run_with_cancelled_event(fn):
        return fn(cancelled)

    monkeypatch.setattr(nr, "_run_inference", _run_with_cancelled_event)
    monkeypatch.setattr(bs, "content_source_days", lambda _uid: [dt.date(2026, 8, 30)])
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    asyncio.run(nr.label_summary_tokens(USER))

    assert len(seen) == 1
    assert seen[0] is not None
    assert seen[0]() is False


def test_explicit_recovery_range_is_cancellable_too(monkeypatch):
    import threading

    seen: list = []

    class _Tokenizer:
        def label_range(self, user_id, start_date, end_date, should_continue=None):
            seen.append(should_continue)
            return 0

    async def _run_with_live_event(fn):
        return fn(threading.Event())

    monkeypatch.setattr(nr, "_run_inference", _run_with_live_event)
    monkeypatch.setattr(st, "SummaryTokenizer", _Tokenizer)

    asyncio.run(
        nr.label_summary_tokens(USER, start_date="2026-08-28", end_date="2026-08-30")
    )

    assert seen[0] is not None
    assert seen[0]() is True
