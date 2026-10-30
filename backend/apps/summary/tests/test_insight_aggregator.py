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


def test_graph_deltas_join_the_entity_name(monkeypatch):
    captured: dict = {}

    def execute(query: str, params: dict):
        captured["query"] = " ".join(query.split()).lower()
        return []

    monkeypatch.setattr(insight_aggregator.db, "execute_query", execute)
    user_id = UUID("01a0124f-cbca-7609-938a-2d044dd8fbbc")
    since = datetime(2026, 9, 2, 12, tzinfo=UTC)
    until = datetime(2026, 9, 2, 13, tzinfo=UTC)

    insight_aggregator.InsightAggregator()._get_graph_deltas(user_id, since, until)

    assert (
        "left join ci.entities ent on ent.entity_id = d.entity_id" in captured["query"]
    )
    assert "ent.name as entity_name" in captured["query"]


def _entity_delta_lines(delta: dict) -> list[str]:
    prompt = summary_functions._build_insights_prompt({"graph_deltas": [delta]})
    return [line for line in prompt.splitlines() if line.startswith("- ")]


def test_prompt_names_a_non_rename_update_from_the_joined_entity():
    lines = _entity_delta_lines(
        {
            "node_type": "entity",
            "change_type": "updated",
            "entity_type": "Person",
            "changed_fields": {"nickname": {"old": None, "new": "Ave"}},
            "entity_name": "Avery Stone",
        }
    )

    assert lines == ["- UPDATED Person: Avery Stone"]


def test_prompt_prefers_the_renamed_value_over_the_joined_name():
    lines = _entity_delta_lines(
        {
            "node_type": "entity",
            "change_type": "updated",
            "entity_type": "Person",
            "changed_fields": {"name": {"old": "Avery", "new": "Avery Stone"}},
            "entity_name": "Avery Stone",
        }
    )

    assert lines == ["- UPDATED Person: Avery Stone"]


def test_prompt_falls_back_to_unknown_without_any_name():
    lines = _entity_delta_lines(
        {
            "node_type": "entity",
            "change_type": "deleted",
            "entity_type": "Item",
            "changed_fields": {},
            "entity_name": None,
        }
    )

    assert lines == ["- DELETED Item: Unknown"]
