"""
DecisionModelClient routing under the promotion gate.

The remote endpoint is stubbed by replacing urllib.request.urlopen, so each test
can show what was sent. Without enforcement the endpoint answers every question
whatever the gate says, and the gate status is only recorded. With enforcement
the endpoint answers the intent question only, and only while the gate passed.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ci.hbpe.config import settings
from ci.hbpe.inference.decision_model import (
    L0_EVENT_QUESTIONS,
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
def _settings_at_defaults(monkeypatch):
    monkeypatch.delenv("DECISION_MODEL_URL", raising=False)
    monkeypatch.setattr(settings, "decision_gate_file", "")
    monkeypatch.setattr(settings, "decision_gate_enforce", False)


def _stub_endpoint(
    monkeypatch, body: dict | None = None, error: Exception | None = None
):
    """Each entry is (url, decoded JSON payload) for one request the client sent."""
    calls: list[tuple[str, dict]] = []

    def fake_urlopen(req, timeout=None):
        calls.append((req.full_url, json.loads(req.data.decode("utf-8"))))
        if error is not None:
            raise error
        return _FakeResponse(json.dumps(body or {"decisions": {}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


def _write_gate(path: Path, passed: bool, reasons: list[str] | None = None) -> Path:
    payload = {"passed": passed, "reasons": reasons or []}
    path.write_text(json.dumps(payload))
    return path


def _local_values(state: str, questions) -> dict[str, object]:
    return {
        name: result.value
        for name, result in LocalDecisionEngine().evaluate(state, questions).items()
    }


# ── Enforcement on ───────────────────────────────────────────────────────────


def test_enforced_endpoint_is_not_called_when_the_gate_failed(tmp_path, monkeypatch):
    reason = "accuracy 0.5000 below baseline 0.5000 + margin 0.0200"
    gate = _write_gate(
        tmp_path / DECISION_GATE_FILENAME, passed=False, reasons=[reason]
    )
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert evaluation.enforced is True
    assert evaluation.gate.passed is False
    assert evaluation.endpoint_questions == ()
    assert evaluation.fallback_reason == f"decision gate not passed: {reason}"
    assert {n: r.value for n, r in evaluation.results.items()} == _local_values(
        STATE, MEMORY_INGRESS_QUESTIONS
    )


def test_enforced_endpoint_answers_only_the_intent_question_when_the_gate_passed(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    body = {
        "decisions": {
            "intent": {
                "choice": "store_task",
                "probability": 0.91,
                "distribution": {"store_task": 0.91, "recall": 0.09},
            },
            # The endpoint may also answer heads the gate does not measure.
            # Those must be ignored, because they are never asked for.
            "is_commitment": {"value": True, "probability": 0.99},
        },
        "calibrated": True,
    }
    calls = _stub_endpoint(monkeypatch, body=body)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert len(calls) == 1
    url, payload = calls[0]
    assert url == f"{ENDPOINT}/v1/systemone"
    assert set(payload["questions"]) == {"intent"}
    assert evaluation.endpoint_questions == ("intent",)
    assert evaluation.fallback_reason is None
    assert evaluation.results["intent"].value == "store_task"
    assert evaluation.results["intent"].probability == pytest.approx(0.91)
    local = LocalDecisionEngine().evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert evaluation.results["is_commitment"] == local["is_commitment"]
    assert evaluation.results["sensitivity"] == local["sensitivity"]


def test_enforced_non_intent_heads_are_answered_locally_without_a_request(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )
    text = "Title: Dentist appointment"

    evaluation = client.evaluate_detailed(text, L0_EVENT_QUESTIONS)

    assert calls == []
    assert evaluation.endpoint_questions == ()
    assert evaluation.fallback_reason is None
    assert evaluation.results == LocalDecisionEngine().evaluate(
        text, L0_EVENT_QUESTIONS
    )


def test_enforced_endpoint_error_falls_back_to_local_for_the_whole_call(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    calls = _stub_endpoint(
        monkeypatch, error=urllib.error.URLError("connection refused")
    )
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert len(calls) == 1
    assert evaluation.endpoint_questions == ("intent",)
    assert evaluation.fallback_reason == "endpoint error: URLError"
    assert evaluation.results == LocalDecisionEngine().evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )


def test_enforced_gate_failure_without_local_fallback_raises_and_sends_nothing(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT,
        enable_local_fallback=False,
        gate_file=str(gate),
        gate_enforce=True,
    )

    with pytest.raises(RuntimeError, match="not used: decision gate not passed"):
        client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert calls == []


def test_enforced_missing_gate_file_falls_back_with_reason(tmp_path, monkeypatch):
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT,
        gate_file=str(tmp_path / "absent.json"),
        gate_enforce=True,
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert "decision gate file not found" in evaluation.fallback_reason


def test_enforced_corrupt_gate_file_falls_back_instead_of_raising(
    tmp_path, monkeypatch
):
    gate = tmp_path / DECISION_GATE_FILENAME
    gate.write_bytes(b"\xff\xfe\x00 not utf-8")
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert "unreadable" in evaluation.fallback_reason


def test_enforced_unconfigured_gate_file_blocks_a_configured_endpoint(monkeypatch):
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(base_url=ENDPOINT, gate_enforce=True)

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert "not configured" in evaluation.fallback_reason


def test_enforced_gate_change_on_disk_takes_effect_without_restart(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    calls = _stub_endpoint(monkeypatch, body={"decisions": {}})
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate), gate_enforce=True
    )

    client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert calls == []

    # A later export replaces the gate file, and the client picks it up.
    _write_gate(gate, passed=True)
    client.evaluate(STATE, MEMORY_INGRESS_QUESTIONS)
    assert [url for url, _ in calls] == [f"{ENDPOINT}/v1/systemone"]


def test_enforcement_follows_the_settings_switch_when_not_passed_in(
    tmp_path, monkeypatch
):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    monkeypatch.setattr(settings, "decision_gate_enforce", True)
    calls = _stub_endpoint(monkeypatch)

    evaluation = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(gate)
    ).evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert calls == []
    assert evaluation.enforced is True
    assert evaluation.fallback_reason.startswith("decision gate not passed:")


def test_gate_file_comes_from_settings_when_not_passed_in(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=False)
    monkeypatch.setattr(settings, "decision_gate_file", str(gate))
    monkeypatch.setattr(settings, "decision_gate_enforce", True)
    calls = _stub_endpoint(monkeypatch)

    evaluation = DecisionModelClient(base_url=ENDPOINT).evaluate_detailed(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == []
    assert evaluation.fallback_reason.startswith("decision gate not passed:")


# ── Enforcement off (the default) ────────────────────────────────────────────


def test_default_endpoint_is_used_even_when_the_gate_failed(tmp_path, monkeypatch):
    gate = _write_gate(
        tmp_path / DECISION_GATE_FILENAME,
        passed=False,
        reasons=["accuracy 0.5000 below baseline 0.5000 + margin 0.0200"],
    )
    body = {"decisions": {"is_commitment": {"value": True, "probability": 0.91}}}
    calls = _stub_endpoint(monkeypatch, body=body)
    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    # Unchanged routing: every question goes to the endpoint.
    assert len(calls) == 1
    assert set(calls[0][1]["questions"]) == set(MEMORY_INGRESS_QUESTIONS)
    assert evaluation.results["is_commitment"].probability == pytest.approx(0.91)
    assert evaluation.endpoint_questions == tuple(MEMORY_INGRESS_QUESTIONS)
    assert evaluation.enforced is False
    assert evaluation.fallback_reason is None
    # The gate status is recorded on the result all the same.
    assert evaluation.gate.passed is False
    assert evaluation.gate.reasons == [
        "accuracy 0.5000 below baseline 0.5000 + margin 0.0200"
    ]


def test_default_endpoint_is_used_when_the_gate_passed(tmp_path, monkeypatch):
    gate = _write_gate(tmp_path / DECISION_GATE_FILENAME, passed=True)
    body = {"decisions": {"is_commitment": {"value": True, "probability": 0.91}}}
    calls = _stub_endpoint(monkeypatch, body=body)
    client = DecisionModelClient(base_url=ENDPOINT, gate_file=str(gate))

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert len(calls) == 1
    assert evaluation.gate.passed is True
    assert evaluation.results["is_commitment"].probability == pytest.approx(0.91)
    assert evaluation.fallback_reason is None


def test_default_missing_gate_file_is_recorded_and_the_endpoint_still_answers(
    tmp_path, monkeypatch
):
    calls = _stub_endpoint(monkeypatch)
    client = DecisionModelClient(
        base_url=ENDPOINT, gate_file=str(tmp_path / "absent.json")
    )

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert len(calls) == 1
    assert evaluation.gate.passed is False
    assert "decision gate file not found" in evaluation.gate.reasons[0]


def test_default_endpoint_error_falls_back_and_records_the_error(monkeypatch):
    _stub_endpoint(monkeypatch, error=urllib.error.URLError("connection refused"))
    client = DecisionModelClient(base_url=ENDPOINT, gate_file="/nonexistent/gate.json")

    evaluation = client.evaluate_detailed(STATE, MEMORY_INGRESS_QUESTIONS)

    assert evaluation.fallback_reason == "endpoint error: URLError"
    assert evaluation.results == LocalDecisionEngine().evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )


def test_no_endpoint_never_reads_the_gate(monkeypatch):
    def fail_if_read(self, path: str):
        raise AssertionError("the gate must not be read without an endpoint")

    monkeypatch.setattr(DecisionModelClient, "_read_gate", fail_if_read)
    monkeypatch.setattr(settings, "decision_gate_file", "/nonexistent/gate.json")
    monkeypatch.setattr(settings, "decision_gate_enforce", True)
    calls = _stub_endpoint(monkeypatch)

    evaluation = DecisionModelClient(base_url=None).evaluate_detailed(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert calls == []
    assert evaluation.gate is None
    assert evaluation.fallback_reason is None
    assert evaluation.results == LocalDecisionEngine().evaluate(
        STATE, MEMORY_INGRESS_QUESTIONS
    )


def test_results_without_an_endpoint_carry_no_gate_status():
    evaluation = DecisionModelClient(base_url=None).evaluate_detailed(
        STATE, MEMORY_INGRESS_QUESTIONS
    )
    assert evaluation.gate is None
    assert "fallback_reason" not in evaluation.results["intent"].to_dict()


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
    monkeypatch.setattr(settings, "decision_gate_enforce", True)
    calls = _stub_endpoint(
        monkeypatch,
        body={
            "decisions": {
                "intent": {"choice": "recall", "probability": 0.8},
                "is_commitment": {"value": True, "probability": 0.8},
            }
        },
    )

    evaluation = DecisionModelClient(base_url=ENDPOINT).evaluate_detailed(
        STATE, MEMORY_INGRESS_QUESTIONS
    )

    assert [url for url, _ in calls] == [f"{ENDPOINT}/v1/systemone"]
    assert set(calls[0][1]["questions"]) == {"intent"}
    assert evaluation.results["intent"].value == "recall"
    assert (
        evaluation.results["is_commitment"]
        == LocalDecisionEngine().evaluate(STATE, MEMORY_INGRESS_QUESTIONS)[
            "is_commitment"
        ]
    )
