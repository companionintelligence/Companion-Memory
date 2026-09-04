"""Contracts pinning every registry exclusion filter to NULL-safe SQL.

`col = false` is NULL, not true, when `col` is NULL, so a row whose nullable
flag was written as an explicit NULL disappears from the hourly summary and
from insight context with nothing logged. These tests pin the NULL-safe form on
each nullable column, and pin the plain equality on the one column that is
NOT NULL, so a future blanket rewrite in either direction has to be deliberate.
"""

from datetime import UTC, datetime
from uuid import UUID

import pytest

from ci.summary import insight_aggregator
from ci.summary.summary_sources import SUMMARY_SOURCES

USER_ID = UUID("01a0124f-cbca-7609-938a-2d044dd8fbbc")
START = datetime(2026, 9, 2, 12, tzinfo=UTC)
END = datetime(2026, 9, 2, 13, tzinfo=UTC)

# (source name, qualified column, required NULL-safe predicate). Every column
# here is nullable in the live ci schema (information_schema.columns says
# is_nullable = YES; the false/'user_input' default only applies when the
# writer omits the column entirely).
NULLABLE_EXCLUSIONS = (
    ("position", "p.is_private", "p.is_private IS NOT TRUE"),
    ("communications", "c.is_archived", "c.is_archived IS NOT TRUE"),
    ("messages", "m.is_deleted", "m.is_deleted IS NOT TRUE"),
    ("browser_activity", "b.is_incognito", "b.is_incognito IS NOT TRUE"),
    (
        "browser_activity",
        "b.contains_sensitive",
        "b.contains_sensitive IS NOT TRUE",
    ),
    ("answers", "answer.is_sensitive", "answer.is_sensitive IS NOT TRUE"),
    (
        "answers",
        "answer.answer_source",
        "answer.answer_source IS DISTINCT FROM 'inferred'",
    ),
)

QUERIES = {source.name: source.query for source in SUMMARY_SOURCES}


@pytest.mark.parametrize(
    ("name", "column", "predicate"),
    NULLABLE_EXCLUSIONS,
    ids=[f"{name}.{column}" for name, column, _ in NULLABLE_EXCLUSIONS],
)
def test_nullable_exclusion_filters_keep_null_rows(name, column, predicate):
    query = QUERIES[name]

    assert predicate in query
    # A NULL-valued flag must not be filtered out by two-valued comparisons:
    # the row is unmarked, not privately marked, and dropping it is silent.
    assert f"{column} = false" not in query
    assert f"{column} = true" not in query
    assert f"{column} != " not in query
    assert f"{column} <> " not in query


def test_events_keeps_the_total_equality_on_a_not_null_column():
    # ci.events.is_deleted is NOT NULL, so `= false` is already total there.
    # Pinned so the NULL-safe rewrite above is understood as targeted at the
    # nullable columns rather than a style preference applied everywhere.
    assert "ev.is_deleted = false" in QUERIES["events"]


def test_insight_communication_context_keeps_null_archived_rows(monkeypatch):
    captured: dict = {}

    def execute(query: str, params: dict):
        captured["query"] = " ".join(query.split())
        return []

    monkeypatch.setattr(insight_aggregator.db, "execute_query", execute)

    insight_aggregator.InsightAggregator()._get_recent_communications(
        USER_ID, START, END
    )

    assert "comm.is_archived IS NOT TRUE" in captured["query"]
    assert "comm.is_archived = false" not in captured["query"]
