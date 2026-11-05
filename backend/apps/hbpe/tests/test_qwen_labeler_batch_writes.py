"""
The labeler resolves each distinct label of a batch against the vocabulary once
and writes the batch's assignments together; the per-item mint flags the
nightly runner counts are unchanged.
"""

from __future__ import annotations

import json

import pytest

from ci.hbpe.tokenizer import qwen_labeler as ql


class _Model:
    """Answers the L0 pass with one class and the L1/L2 pass with the given labels."""

    def __init__(self, l0: str, labels: list[dict]) -> None:
        self.l0 = l0
        self.labels = labels
        self.calls = 0

    def batch_generate(self, prompts: list, max_new_tokens: int = 0) -> list[str]:
        self.calls += 1
        if self.calls == 1:
            return [json.dumps({"l0": self.l0}) for _ in prompts]
        return [json.dumps(label) for label in self.labels]


@pytest.fixture
def harness(monkeypatch):
    minted: list[tuple[str, str]] = []
    written: dict[str, list] = {}

    def get_or_create_l1(user_id: str, l0: str, label: str) -> tuple[str, bool]:
        minted.append((l0, label))
        return f"l1:{label}", label == "Standup"

    def get_or_create_l2(
        user_id: str, l0: str, l1_id: str, label: str
    ) -> tuple[str, bool]:
        minted.append((l1_id, label))
        return f"l2:{label}", label == "Notes"

    monkeypatch.setattr(ql, "get_or_create_l1", get_or_create_l1)
    monkeypatch.setattr(ql, "get_or_create_l2", get_or_create_l2)
    monkeypatch.setattr(ql, "get_l1_vocab", lambda *_a: [])
    monkeypatch.setattr(ql, "get_l2_vocab", lambda *_a: [])
    monkeypatch.setattr(
        ql,
        "write_event_labels",
        lambda rows: written.setdefault("events", []).append(rows),
    )
    monkeypatch.setattr(
        ql,
        "write_content_labels",
        lambda rows: written.setdefault("content", []).append(rows),
    )
    return minted, written


def _install_model(monkeypatch, model: _Model) -> None:
    import ci.hbpe.inference.qwen as qwen

    monkeypatch.setattr(qwen, "get_qwen", lambda: model)


def test_events_sharing_a_label_resolve_it_once_and_are_written_as_one_batch(
    monkeypatch, harness
):
    minted, written = harness
    _install_model(
        monkeypatch,
        _Model("WORK", [{"l1": "Standup"}, {"l1": "Standup"}, {"l1": "Review"}]),
    )

    results = ql.QwenLabeler().label_events_batch(
        [
            {"event_id": "e1", "title": "a"},
            {"event_id": "e2", "title": "b"},
            {"event_id": "e3", "title": "c"},
        ],
        "user-1",
    )

    assert minted == [("WORK", "Standup"), ("WORK", "Review")]
    assert written["events"] == [
        [("e1", "l1:Standup"), ("e2", "l1:Standup"), ("e3", "l1:Review")]
    ]
    # The mint is reported once, on the event whose label minted it.
    assert [r["is_new_l1"] for r in results] == [True, False, False]
    assert [r["l1_id"] for r in results] == ["l1:Standup", "l1:Standup", "l1:Review"]


def test_content_resolves_each_l1_and_l2_once_and_writes_one_batch(
    monkeypatch, harness
):
    minted, written = harness
    _install_model(
        monkeypatch,
        _Model(
            "WORK", [{"l1": "Standup", "l2": "Notes"}, {"l1": "Standup", "l2": "Notes"}]
        ),
    )

    results = ql.QwenLabeler().label_content_batch(
        [{"content_id": "k1", "title": "a"}, {"content_id": "k2", "title": "b"}],
        "user-1",
    )

    assert minted == [("WORK", "Standup"), ("l1:Standup", "Notes")]
    assert written["content"] == [
        [
            ("k1", "user-1", "WORK", "l1:Standup", "l2:Notes"),
            ("k2", "user-1", "WORK", "l1:Standup", "l2:Notes"),
        ]
    ]
    assert [(r["is_new_l1"], r["is_new_l2"]) for r in results] == [
        (True, True),
        (False, False),
    ]


def test_an_empty_batch_asks_nothing(monkeypatch, harness):
    minted, written = harness

    assert ql.QwenLabeler().label_events_batch([], "user-1") == []
    assert minted == [] and written == {}
