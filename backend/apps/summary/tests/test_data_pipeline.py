"""Contracts for current-schema aggregation and bounded hourly prompts."""

from datetime import UTC, datetime
from uuid import UUID

import pytest

from ci.summary import data_aggregator, summary_functions
from ci.summary.summary_sources import SUMMARY_SOURCES

USER_ID = UUID("01a0124f-cbca-7609-938a-2d044dd8fbbc")
START = datetime(2026, 9, 2, 12, tzinfo=UTC)
END = datetime(2026, 9, 2, 13, tzinfo=UTC)


def test_registry_uses_current_grounded_sources_only():
    names = {source.name for source in SUMMARY_SOURCES}

    assert {
        "position",
        "communications",
        "events",
        "messages",
        "files",
        "content",
        "file_chunks",
        "notes",
        "tasks",
        "browser_activity",
        "objects",
        "object_observations",
        "receipts",
        "receipt_line_items",
        "answers",
        "tool_invocations",
    } == names
    assert names.isdisjoint(
        {
            "measurements",
            "activities",
            "api_logs",
            "screen_captures",
            "capture_events",
            "summaries",
            "insights",
            "activity_rollup",
            "agent_memories",
        }
    )


@pytest.mark.parametrize("source", SUMMARY_SOURCES, ids=lambda source: source.name)
def test_every_source_is_explicitly_scoped_and_bounded(source):
    normalized = " ".join(source.query.split()).lower()

    assert "from ci." in normalized
    assert ":user_id" in source.query
    assert ":start" in source.query
    assert ":end" in source.query
    assert ":limit" in source.query
    assert "select *" not in normalized


def test_semantic_text_precedes_bookkeeping_in_chat_and_communication_queries():
    queries = {source.name: source.query for source in SUMMARY_SOURCES}

    assert queries["messages"].index("LEFT(m.content") < queries["messages"].index(
        "m.thread_id"
    )
    assert queries["communications"].index("COALESCE") < queries[
        "communications"
    ].index("c.source_system")


def test_aggregator_queries_every_source_with_the_same_window(monkeypatch):
    calls: list[tuple[str, dict]] = []

    def execute(query: str, params: dict):
        calls.append((query, params))
        return [{"text": "material"}]

    monkeypatch.setattr(data_aggregator.db, "execute_query", execute)

    result = data_aggregator.DataAggregator().aggregate_hour(USER_ID, START, END)

    assert len(calls) == len(SUMMARY_SOURCES)
    assert {key for key, value in result.items() if isinstance(value, list)} == {
        source.name for source in SUMMARY_SOURCES
    }
    assert all(
        params
        == {
            "user_id": str(USER_ID),
            "start": START,
            "end": END,
            "limit": source.limit,
        }
        for (_, params), source in zip(calls, SUMMARY_SOURCES, strict=True)
    )


def test_aggregator_does_not_turn_a_schema_failure_into_an_empty_hour(monkeypatch):
    def fail(_query: str, _params: dict):
        raise RuntimeError("missing column")

    monkeypatch.setattr(data_aggregator.db, "execute_query", fail)

    with pytest.raises(RuntimeError, match="missing column"):
        data_aggregator.DataAggregator().aggregate_hour(USER_ID, START, END)


def test_activity_counts_follow_all_list_valued_sources():
    counts = summary_functions.count_activities(
        {
            "user_id": str(USER_ID),
            "start_time": START.isoformat(),
            "notes": [{"text": "one"}],
            "new_source": [{"text": "two"}, {"text": "three"}],
        }
    )

    assert counts == {"notes": 1, "new_source": 2, "total": 3}


def test_prompt_budget_preserves_semantic_material_from_late_sources(monkeypatch):
    monkeypatch.setattr(summary_functions, "MAX_HOURLY_PROMPT_CHARS", 500)
    data = {
        "messages": [{"text": "early semantic " + "a" * 500}],
        "tool_invocations": [{"intent": "late.semantic.intent", "detail": "b" * 500}],
    }
    counts = summary_functions.count_activities(data)

    prompt = summary_functions.build_data_prompt(data, counts)

    assert len(prompt) <= 500
    assert "early semantic" in prompt
    assert "Tool Invocations" in prompt
    assert "late.semantic.intent" in prompt


def _sections(prompt: str) -> list[list[str]]:
    return [block.splitlines() for block in prompt.split("\n\n")[1:]]


def test_prompt_header_never_claims_more_items_than_the_section_contains():
    # Sixteen active sources is the shipped registry size, and it is the case where
    # a whole-section cut used to leave one item plus a fragment under a header
    # promising five.
    data = {
        f"source_{index:02d}": [
            {"text": f"row {row} of source {index} " + "x" * 2_000} for row in range(5)
        ]
        for index in range(16)
    }
    counts = summary_functions.count_activities(data)

    prompt = summary_functions.build_data_prompt(data, counts)

    assert len(prompt) <= summary_functions.MAX_HOURLY_PROMPT_CHARS
    assert len(_sections(prompt)) == 16
    for lines in _sections(prompt):
        claimed = int(lines[1].removeprefix("  Sample (newest ").removesuffix("):"))
        rendered = [line for line in lines[2:] if line.startswith("    - ")]
        assert claimed == len(rendered)
        assert claimed >= 1


def test_a_lone_busy_source_can_reach_the_per_item_character_cap():
    # The per-item cap was dead code while the section cut bound first: prove an
    # item can now actually spend MAX_PROMPT_ITEM_CHARS.
    data = {"messages": [{"text": "y" * 5_000} for _ in range(5)]}
    counts = summary_functions.count_activities(data)

    prompt = summary_functions.build_data_prompt(data, counts)

    items = [line for line in prompt.splitlines() if line.startswith("    - ")]
    assert len(items) == 5
    assert all(
        len(line) - len("    - ") == summary_functions.MAX_PROMPT_ITEM_CHARS
        for line in items
    )


def test_a_budget_too_small_for_one_legible_item_drops_the_sample_claim(monkeypatch):
    # ~27 chars per section: not enough for a row, but enough for the count line.
    # A section cut on rendered length instead left a fragment of the "Sample"
    # header behind, announcing a sample the section could not carry.
    monkeypatch.setattr(summary_functions, "MAX_HOURLY_PROMPT_CHARS", 120)
    data = {
        "messages": [{"text": "a" * 300}],
        "notes": [{"text": "b" * 300}],
        "tasks": [{"text": "c" * 300}],
    }
    counts = summary_functions.count_activities(data)

    prompt = summary_functions.build_data_prompt(data, counts)

    assert len(prompt) <= 120
    assert "Sample" not in prompt
    assert "Messages: 1 items" in prompt
    assert "Notes: 1 items" in prompt
    assert "Tasks: 1 items" in prompt


def test_a_one_character_section_budget_does_not_overflow_itself(monkeypatch):
    # section_budget floors at 1, and the old truncation answered that by writing
    # "..." - three characters into a one-character budget, per section.
    monkeypatch.setattr(summary_functions, "MAX_HOURLY_PROMPT_CHARS", 43)
    data = {
        "messages": [{"text": "a" * 300}],
        "notes": [{"text": "b" * 300}],
        "tasks": [{"text": "c" * 300}],
    }
    counts = summary_functions.count_activities(data)

    prompt = summary_functions.build_data_prompt(data, counts)

    assert len(prompt) <= 43
    assert "..." not in prompt


def test_prompt_skips_a_source_whose_rows_are_absent_from_the_aggregated_data():
    # build_data_prompt is exported and takes data and counts as independent
    # arguments, so counts can name a source the dict does not carry.
    prompt = summary_functions.build_data_prompt(
        {"notes": [{"text": "present"}]},
        {"notes": 1, "browser_activity": 7, "total": 8},
    )

    assert "present" in prompt
    assert "Browser Activity: 7 items" in prompt
    assert "Sample (newest 7)" not in prompt


def test_insights_prompt_renders_a_communication_with_every_text_column_null():
    # A call log or an attachment-only MMS: content is '' so the COALESCE/NULLIF
    # projection yields NULL text, and no sender or recipient entity resolves.
    prompt = summary_functions._build_insights_prompt(
        {
            "recent_communications": [
                {
                    "text": None,
                    "subject": None,
                    "communication_type": "call",
                    "direction": None,
                    "from_name": None,
                    "to_names": None,
                    "time": datetime(2026, 9, 2, 12, 30, tzinfo=UTC),
                }
            ]
        }
    )

    assert "## RECENT COMMUNICATIONS" in prompt
    assert "- Communication: " in prompt


def test_insights_prompt_ignores_unresolved_recipient_names():
    prompt = summary_functions._build_insights_prompt(
        {
            "recent_communications": [
                {
                    "text": "See you Friday",
                    "subject": None,
                    "direction": "outbound",
                    "from_name": None,
                    "to_names": [None, "Max"],
                }
            ]
        }
    )

    assert "(outbound; Max)" in prompt


def test_actions_prompt_renders_an_insight_with_no_text():
    prompt = summary_functions._build_actions_prompt(
        {"recent_insights": [{"title": "Travel week", "insight_text": None}]}
    )

    assert "- Travel week: " in prompt
