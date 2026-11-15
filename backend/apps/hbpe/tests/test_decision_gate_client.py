"""
DecisionModelClient routing under the promotion gate.

The remote endpoint is stubbed by replacing urllib.request.urlopen, so each test
can show whether a request was sent.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import ci.hbpe.inference.decision_model as decision_model
from ci.hbpe.config import settings
from ci.hbpe.inference.decision_model import (
    MEMORY_INGRESS_QUESTIONS,
    DecisionModelClient,
    LocalDecisionEngine,
)
from ci.hbpe.model.decision_gate import DECISION_GATE_FILENAME

ENDPOINT = "http://decision.test"
STATE = "Remember to pay the rent on Friday"


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def read(self) -> bytes:
        return self._body


@pytest.fixture(autouse=True)
def _fresh_gate_cache(monkeypatch):
    monkeypatch.setattr(decision_model, "_GATE_CACHE", None)
    monkeypatch.delenv("DECISION_MODEL_URL", raising=False)


def _stub_endpoint(
    monkeypatch, body: dict | None = None, error: Exception | None = None
):
    calls: list[str] = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        if error is not None:
            raise error
        return _FakeResponse(json.dumps(body or {"decisions": {}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


def _write_gate(path: Path, passed: bool, reasons: list[str] | None = None) -> Path:
    payload = {"passed": passed, "reasons": reasons or []}
    path.write_text(json.dumps(payload))
    return path


def test_endpoint_is_not_called_when_the_gate_failed(tmp_path, monkeypatch):
    gate = _write_gate(
        tmp_path / DECISION_GATE_FILENAME,
        passed=False,
        reasons=["accuracy 0.5000 below baseline 0.5000 + margin 0.0200"],
    )
    calls = _stub_endpoint(monkeypatch, body={"decisions": {}})

    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))
    results = client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert set(results) == set(MEMORY_INGRESS_QUESTIONS)
    for result in results.values():
        assert result.fallback_reason is not None
        assert result.fallback_reason.startswith("decision gate not passed:")
        assert "accuracy 0.5000 below baseline" in result.fallback_reason

    local = LocalDecisionEngine().evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert results["intent"].value == local["intent"].value
    assert results["is_commitment"].value == local["is_commitment"].value


def test_endpoint_is_used_when_the_gate_passed(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    body = {
        "decisions": {"is_commitment": {"value": True, "probability": 0.91}},
        "calibrated": True,
    }
    calls = _stub_endpoint(monkeypatch, body=body)

    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))
    results = client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == [f"{ENDPOINT}/v1/systemone"]
    assert results["is_commitment"].probability == pytest.approx(0.91)
    assert results["is_commitment"].fallback_reason is None


def test_missing_gate_file_falls_back_with_reason(tmp_path, monkeypatch):
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(tmp_path / "absent.json")
    )

    results = client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert "decision gate file not found" in results["intent"].fallback_reason


def test_gate_file_comes_from_settings_when_not_passed_in(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    monkeypatch.setattr(settings, "decision_gate_file", str(gate))
    calls = _stub_endpoint(monkeypatch)

    results = DecisionModelClient(base_url=ENDPOINT).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == []
    assert results["intent"].fallback_reason.startswith("decision gate not passed:")


def test_unconfigured_gate_file_blocks_a_configured_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "decision_gate_file", "")
    calls = _stub_endpoint(monkeypatch)

    results = DecisionModelClient(base_url=ENDPOINT).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == []
    assert "not configured" in results["intent"].fallback_reason


def test_no_endpoint_never_reads_the_gate(monkeypatch):
    def fail_if_read(path: str):
        raise AssertionError("the gate must not be read without an endpoint")

    monkeypatch.setattr(decision_model, "_gate_for_path", fail_if_read)
    monkeypatch.setattr(settings, "decision_gate_file", "/nonexistent/gate.json")
    calls = _stub_endpoint(monkeypatch)

    results = DecisionModelClient(base_url=None).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == []
    assert all(r.fallback_reason is None for r in results.values())


def test_gate_failure_without_local_fallback_raises_and_sends_nothing(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, enable_local_fallback=False, gate_file=str(gate)
    )

    with pytest.raises(RuntimeError, match="not used: decision gate not passed"):
        client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert calls == []


def test_endpoint_error_falls_back_and_records_the_error(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    _stub_endpoint(monkeypatch, error=urllib.error.URLError("connection refused"))
    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))

    results = client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)

    assert results["intent"].fallback_reason == "endpoint error: URLError"


def test_gate_change_on_disk_takes_effect_without_restart(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    calls = _stub_endpoint(monkeypatch, body={"decisions": {}})
    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))

    client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert calls == []

    # A later export replaces the gate file, and the client picks it up.
    _write_gate(gate, passed=True)
    client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert calls == [f"{ENDPOINT}/v1/systemone"]


def test_fallback_reason_is_not_set_on_results_without_an_endpoint():
    results = DecisionModelClient(base_url=None).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )
    assert all(r.fallback_reason is None for r in results.values())
    assert "fallback_reason" not in results["intent"].to_dict()


def test_fallback_reason_appears_in_to_dict_only_when_set(tmp_path):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    results = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate)).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )
    assert "fallback_reason" in results["intent"].to_dict()


def test_exported_gate_unlocks_the_endpoint_end_to_end(tmp_path, monkeypatch):
    """The export writes the gate beside the model; the client reads it from settings."""
    from ci.hbpe.model.unsloth_decision_trainer import UnslothDecisionTrainer

    labels = ["store_task", "recall", "update_or_forget", "conversational"]
    items = [
        {
            "state": f"neutral note number {i}",
            "answers": {"intent": labels[i % len(labels)]},
        }
        for i in range(200)
    ]
    truth = {item["state"]: item["answers"]["intent"] for item in items}
    choices = ["store_fact", *labels]

    def perfect_predictor(state: str) -> dict[str, float]:
        return {c: 1.0 if c == truth[state] else 0.0 for c in choices}

    export_dir = tmp_path / "model"
    meta = UnslothDecisionTrainer(trained_predictor=perfect_predictor).train_and_export(
        [], items, export_dir
    )
    assert meta["gate"]["passed"] is True

    monkeypatch.setattr(
        settings, "decision_gate_file", str(export_dir / DECISION_GATE_FILENAME)
    )
    calls = _stub_endpoint(
        monkeypatch,
        body={"decisions": {"is_commitment": {"value": True, "probability": 0.8}}},
    )

    results = DecisionModelClient(base_url=ENDPOINT).evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == [f"{ENDPOINT}/v1/systemone"]
    assert results["is_commitment"].probability == pytest.approx(0.8)
    assert results["is_commitment"].fallback_reason is None


def test_corrupt_gate_file_falls_back_instead_of_raising(tmp_path, monkeypatch):
    gate = tmp_path / DECISION_GATE_FILENAME
    gate.write_bytes(b"\xff\xfe\x00 not utf-8")
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))

    results = client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert "unreadable" in results["intent"].fallback_reason
