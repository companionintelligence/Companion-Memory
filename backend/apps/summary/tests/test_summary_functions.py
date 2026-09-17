"""
Unit tests for the empty-window contract of ci.summary.functions.

"No input yet" is a routine state on an appliance, not a failure: the rollup
crons fire on the calendar and dossier_refresh fires at :12 every hour, both
regardless of whether anything has been captured. Raising in that case spent
the pg-boss retry budget and left a permanent dead letter every run (19 of
them, one per hour, on the QA appliance). These tests pin the skip-don't-raise
behaviour, and pin that a non-empty window still does the real work.

Every activity is monkeypatched: no database, no LLM.
"""

from __future__ import annotations

from typing import Any

import pytest

from ci.summary import functions


def _patch(monkeypatch: pytest.MonkeyPatch, name: str, result: Any) -> list[tuple]:
    """Replace an activity with a recording stub returning ``result``."""
    calls: list[tuple] = []

    async def stub(*args: Any, **kwargs: Any) -> Any:
        calls.append((args, kwargs))
        return result

    monkeypatch.setattr(functions, name, stub)

    return calls


# ── Rollups (daily / weekly / monthly) ───────────────────────────────


@pytest.mark.asyncio
async def test_rollup_skips_instead_of_raising_on_an_empty_window(monkeypatch):
    _patch(monkeypatch, "fetch_child_summaries_activity", [])
    generated = _patch(monkeypatch, "generate_rollup_summary_activity", {})
    stored = _patch(monkeypatch, "store_summary_activity", "summary-1")

    result = await functions.daily_summary(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-17T00:00:00+00:00",
        end_time="2026-08-18T00:00:00+00:00",
        timezone="UTC",
    )

    assert result["skipped"] == "no_summaries"
    assert result["summary_id"] is None
    assert result["summary_type"] == "daily"
    assert result["num_hourly_summaries"] == 0
    # Nothing generated, nothing written: the next window starts clean.
    assert generated == []
    assert stored == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fn", "period_type", "child_period_type"),
    [
        (functions.daily_summary, "daily", "hourly"),
        (functions.weekly_summary, "weekly", "daily"),
        (functions.monthly_summary, "monthly", "daily"),
    ],
)
async def test_every_rollup_cadence_skips_an_empty_window(
    monkeypatch, fn, period_type, child_period_type
):
    _patch(monkeypatch, "fetch_child_summaries_activity", [])

    result = await fn(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-01T00:00:00+00:00",
        end_time="2026-08-18T00:00:00+00:00",
        timezone="UTC",
    )

    assert result["skipped"] == "no_summaries"
    assert result["summary_type"] == period_type
    assert result[f"num_{child_period_type}_summaries"] == 0


@pytest.mark.asyncio
async def test_rollup_still_aggregates_when_the_window_has_summaries(monkeypatch):
    _patch(monkeypatch, "fetch_child_summaries_activity", [{"summary_id": "hourly-1"}])
    _patch(
        monkeypatch,
        "generate_rollup_summary_activity",
        {"summary_text": "a day", "activity_counts": {"events": 3}, "tokens_used": 12},
    )
    stored = _patch(monkeypatch, "store_summary_activity", "summary-1")

    result = await functions.daily_summary(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-17T00:00:00+00:00",
        end_time="2026-08-18T00:00:00+00:00",
        timezone="UTC",
    )

    assert "skipped" not in result
    assert result["summary_id"] == "summary-1"
    assert result["summary_text"] == "a day"
    assert result["num_hourly_summaries"] == 1
    assert len(stored) == 1


# ── Hourly ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hourly_summary_skips_when_the_window_has_no_activity(monkeypatch):
    _patch(monkeypatch, "find_existing_summary_activity", None)
    _patch(monkeypatch, "aggregate_data_activity", {"events": [], "messages": []})
    generated = _patch(monkeypatch, "generate_hourly_summary_activity", {})
    stored = _patch(monkeypatch, "store_summary_activity", "summary-1")

    result = await functions.hourly_summary(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-18T14:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
        timezone="UTC",
    )

    assert result["skipped"] == "no_activity"
    assert result["summary_id"] is None
    assert result["summary_type"] == "hourly"
    assert result["summary_text"] == "Nothing new."
    assert result["tokens_used"] == 0
    assert generated == []
    assert stored == []


@pytest.mark.asyncio
async def test_hourly_summary_still_generates_when_the_window_has_activity(
    monkeypatch,
):
    _patch(monkeypatch, "find_existing_summary_activity", None)
    _patch(monkeypatch, "aggregate_data_activity", {"events": [{"id": "e1"}]})
    _patch(
        monkeypatch,
        "generate_hourly_summary_activity",
        {
            "summary_text": "a meeting",
            "key_insights": ["one"],
            "activity_counts": {"events": 1, "total": 1},
            "tokens_used": 40,
        },
    )
    stored = _patch(monkeypatch, "store_summary_activity", "summary-1")

    result = await functions.hourly_summary(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-18T14:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
        timezone="UTC",
    )

    assert "skipped" not in result
    assert result["summary_id"] == "summary-1"
    assert result["summary_text"] == "a meeting"
    assert result["tokens_used"] == 40
    assert len(stored) == 1


@pytest.mark.asyncio
async def test_hourly_summary_returns_existing_exact_window_without_more_work(
    monkeypatch,
):
    _patch(
        monkeypatch,
        "find_existing_summary_activity",
        {
            "summary_id": "summary-existing",
            "content": {
                "summary_text": "already summarized",
                "activity_counts": {"notes": 1, "total": 1},
                "tokens_used": 24,
            },
        },
    )
    aggregated = _patch(monkeypatch, "aggregate_data_activity", {})
    generated = _patch(monkeypatch, "generate_hourly_summary_activity", {})
    stored = _patch(monkeypatch, "store_summary_activity", "summary-new")

    result = await functions.hourly_summary(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-18T14:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
        timezone="UTC",
    )

    assert result["summary_id"] == "summary-existing"
    assert result["skipped"] == "already_exists"
    assert result["summary_text"] == "already summarized"
    assert aggregated == []
    assert generated == []
    assert stored == []


@pytest.mark.asyncio
async def test_hourly_backfill_runs_chronological_one_hour_windows(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def hourly(_user_id: str, *, start_time: str, end_time: str, **_):
        calls.append((start_time, end_time))
        index = len(calls)
        if index == 2:
            return {"summary_id": None, "skipped": "no_activity"}
        return {"summary_id": f"summary-{index}"}

    monkeypatch.setattr(functions, "hourly_summary", hourly)

    result = await functions.hourly_summary_backfill(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        start_time="2026-08-18T12:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
        timezone="UTC",
    )

    assert calls == [
        ("2026-08-18T12:00:00+00:00", "2026-08-18T13:00:00+00:00"),
        ("2026-08-18T13:00:00+00:00", "2026-08-18T14:00:00+00:00"),
        ("2026-08-18T14:00:00+00:00", "2026-08-18T15:00:00+00:00"),
    ]
    assert result["hours"] == 3
    assert result["generated"] == 2
    assert result["skipped"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("start_time", "end_time", "message"),
    [
        (
            "2026-08-18T12:30:00+00:00",
            "2026-08-18T13:30:00+00:00",
            "hour boundaries",
        ),
        (
            "2026-08-18T12:00:00",
            "2026-08-18T13:00:00",
            "UTC offsets",
        ),
        (
            "2026-08-18T13:00:00+00:00",
            "2026-08-18T12:00:00+00:00",
            "after start_time",
        ),
        (
            "2026-08-17T12:00:00+00:00",
            "2026-08-18T13:00:00+00:00",
            "limited to 24 hours",
        ),
    ],
)
async def test_hourly_backfill_rejects_unsafe_ranges(start_time, end_time, message):
    with pytest.raises(ValueError, match=message):
        await functions.hourly_summary_backfill(
            "01a0124f-cbca-7609-938a-2d044dd8fbbc",
            start_time=start_time,
            end_time=end_time,
        )


# ── Dossier ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dossier_refresh_skips_instead_of_raising_when_no_summaries_exist(
    monkeypatch,
):
    _patch(monkeypatch, "get_entity_id_activity", "entity-1")
    _patch(monkeypatch, "fetch_previous_dossier_activity", None)
    _patch(
        monkeypatch, "fetch_summaries_for_dossier_activity", {"daily": [], "hourly": []}
    )
    generated = _patch(monkeypatch, "generate_dossier_activity", {"text": "…"})
    stored = _patch(monkeypatch, "store_dossier_activity", None)

    result = await functions.dossier_refresh(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        end_time="2026-08-18T15:00:00+00:00",
    )

    assert result == {
        "entity_id": "entity-1",
        "dossier": None,
        "skipped": "no_summaries",
    }
    # No LLM call, and the previous dossier is left untouched.
    assert generated == []
    assert stored == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "summaries",
    [
        {"daily": [{"summary_id": "d1"}], "hourly": []},
        {"daily": [], "hourly": [{"summary_id": "h1"}]},
    ],
)
async def test_dossier_refresh_still_runs_with_either_summary_cadence(
    monkeypatch, summaries
):
    _patch(monkeypatch, "get_entity_id_activity", "entity-1")
    _patch(monkeypatch, "fetch_previous_dossier_activity", None)
    _patch(monkeypatch, "fetch_summaries_for_dossier_activity", summaries)
    _patch(monkeypatch, "generate_dossier_activity", {"text": "a dossier"})
    stored = _patch(monkeypatch, "store_dossier_activity", None)

    result = await functions.dossier_refresh(
        "01a0124f-cbca-7609-938a-2d044dd8fbbc",
        end_time="2026-08-18T15:00:00+00:00",
    )

    assert result == {"entity_id": "entity-1", "dossier": {"text": "a dossier"}}
    assert len(stored) == 1


@pytest.mark.asyncio
async def test_dossier_refresh_still_raises_when_the_user_has_no_entity(monkeypatch):
    """A missing entity is a broken user record, not an empty window."""
    _patch(monkeypatch, "get_entity_id_activity", None)

    with pytest.raises(ValueError, match="No entity found"):
        await functions.dossier_refresh("01a0124f-cbca-7609-938a-2d044dd8fbbc")
