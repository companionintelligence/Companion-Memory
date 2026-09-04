"""Contracts for the sidecar-owned insight novelty gate."""

from datetime import UTC, datetime
from uuid import UUID

from ci.summary import insight_aggregator, summary_functions


def test_novelty_includes_communications_and_event_updates(monkeypatch):
    captured: dict = {}

    def execute(query: str, params: dict):
        captured["query"] = " ".join(query.split()).lower()
        captured["params"] = params
        return [{"has_new_data": True}]

    monkeypatch.setattr(insight_aggregator.db, "execute_query", execute)
    user_id = UUID("01a0124f-cbca-7609-938a-2d044dd8fbbc")
    since = datetime(2026, 9, 2, 12, tzinfo=UTC)

    result = insight_aggregator.InsightAggregator().has_new_data(user_id, since)

    assert result is True
    assert "from ci.communications" in captured["query"]
    assert "greatest(created_at, updated_at) >= :since" in captured["query"]
    assert "period_type != 'insight'" in captured["query"]
    assert captured["params"] == {"user_id": str(user_id), "since": since}


def test_communication_context_and_prompt_preserve_meaning(monkeypatch):
    captured: dict = {}

    def execute(query: str, params: dict):
        captured["query"] = " ".join(query.split())
        captured["params"] = params
        return [
            {
                "subject": "Launch timing",
                "text": "Can we move the review to Friday?",
                "direction": "inbound",
                "from_name": "Avery",
                "to_names": ["Max"],
            }
        ]

    monkeypatch.setattr(insight_aggregator.db, "execute_query", execute)
    user_id = UUID("01a0124f-cbca-7609-938a-2d044dd8fbbc")
    since = datetime(2026, 9, 2, 12, tzinfo=UTC)
    until = datetime(2026, 9, 2, 13, tzinfo=UTC)

    communications = insight_aggregator.InsightAggregator()._get_recent_communications(
        user_id, since, until
    )
    prompt = summary_functions._build_insights_prompt(
        {"recent_communications": communications}
    )

    assert "AS text" in captured["query"]
    assert "sender.name AS from_name" in captured["query"]
    assert "Can we move the review to Friday?" in prompt
    assert "Avery" in prompt
    assert "Max" in prompt
