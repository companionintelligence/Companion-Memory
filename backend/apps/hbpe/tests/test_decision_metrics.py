"""
Tests for held-out decision metrics and the gate written by the Unsloth export.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ci.hbpe.inference.decision_model import (
    MEMORY_INGRESS_QUESTIONS,
    LocalDecisionEngine,
)
from ci.hbpe.model.decision_gate import DECISION_GATE_FILENAME, GateThresholds
from ci.hbpe.model.unsloth_decision_trainer import (
    UnslothDecisionTrainConfig,
    UnslothDecisionTrainer,
    compute_intent_metrics,
    local_intent_distribution,
)

INTENT_CYCLE = ["store_task", "recall", "update_or_forget", "conversational"]


def _eval_items(n: int) -> list[dict]:
    """Neutral states with intents that LocalDecisionEngine never predicts.

    On these states the engine scores every intent equally and returns
    store_fact, so its held-out accuracy is 0.0.
    """
    return [
        {
            "state": f"neutral note number {i}",
            "answers": {"intent": INTENT_CYCLE[i % len(INTENT_CYCLE)]},
        }
        for i in range(n)
    ]


def _one_hot_predictor(items: list[dict]):
    truth_by_state = {item["state"]: item["answers"]["intent"] for item in items}

    def predict(state: str) -> dict[str, float]:
        truth = truth_by_state[state]
        return {label: 1.0 if label == truth else 0.0 for label in INTENT_CYCLE} | {
            "store_fact": 0.0
        }

    return predict


# ── Metric functions ─────────────────────────────────────────────────────────


def test_intent_metrics_match_hand_computed_brier_and_ece():
    # Probabilities sit inside decile bins, away from float bin edges.
    predictions = [
        {"a": 0.85, "b": 0.10, "c": 0.05},  # truth a: correct, top 0.85
        {"a": 0.65, "b": 0.25, "c": 0.10},  # truth b: wrong,   top 0.65
        {"a": 0.15, "b": 0.75, "c": 0.10},  # truth b: correct, top 0.75
        {"a": 0.07, "b": 0.11, "c": 0.82},  # truth a: wrong,   top 0.82
    ]
    labels = ["a", "b", "b", "a"]

    metrics = compute_intent_metrics(predictions, labels)

    # Per-item squared errors 0.035, 0.995, 0.095, 1.5494; mean 0.6686.
    assert metrics["brier_score"] == pytest.approx(0.6686)
    # Bin [0.6,0.7) holds 0.65 wrong: 0.65 * 1/4 = 0.1625.
    # Bin [0.7,0.8) holds 0.75 right: 0.25 * 1/4 = 0.0625.
    # Bin [0.8,0.9) holds 0.85 right and 0.82 wrong: 0.335 * 2/4 = 0.1675.
    assert metrics["expected_calibration_error"] == pytest.approx(0.3925)
    assert metrics["accuracy"] == pytest.approx(0.5)
    assert metrics["eval_size"] == 4


def test_intent_metrics_for_perfect_predictions_are_zero_error():
    predictions = [
        {"a": 1.0, "b": 0.0, "c": 0.0},
        {"a": 0.0, "b": 1.0, "c": 0.0},
    ]
    metrics = compute_intent_metrics(predictions, ["a", "b"])
    assert metrics["brier_score"] == pytest.approx(0.0)
    assert metrics["expected_calibration_error"] == pytest.approx(0.0)
    assert metrics["accuracy"] == pytest.approx(1.0)


def test_intent_metrics_with_no_items_are_none_not_zero():
    # compute_brier_score returns 0.0 for empty input. That would read as perfect,
    # so the metrics must be missing instead.
    metrics = compute_intent_metrics([], [])
    assert metrics == {
        "brier_score": None,
        "expected_calibration_error": None,
        "accuracy": None,
        "eval_size": 0,
    }


def test_predictor_returning_no_distribution_is_an_error():
    with pytest.raises(ValueError, match="no intent distribution"):
        compute_intent_metrics([{}], ["a"])


def test_local_intent_distribution_matches_local_engine():
    state = "Remember to call the dentist tomorrow"
    expected = (
        LocalDecisionEngine()
        .evaluate(state, {"intent": MEMORY_INGRESS_QUESTIONS["intent"]})["intent"]
        .distribution
    )
    assert local_intent_distribution(state) == pytest.approx(expected)


# ── Export ───────────────────────────────────────────────────────────────────


def test_cpu_path_export_scores_with_local_engine_and_fails_gate(tmp_path):
    items = _eval_items(200)
    trainer = UnslothDecisionTrainer(UnslothDecisionTrainConfig(epochs=1))

    meta = trainer.train_and_export([], items, tmp_path)

    # Candidate and baseline are the same engine, so the margin cannot be met.
    metrics = meta["eval_metrics"]
    assert meta["prediction_source"] == "local_engine"
    assert metrics["eval_size"] == 200
    assert metrics["accuracy"] == pytest.approx(0.0)
    assert metrics["brier_score"] != pytest.approx(0.08)
    assert meta["gate"]["passed"] is False
    assert any("below baseline" in r for r in meta["gate"]["reasons"])
    assert meta["gate"]["reasons"][-1] == (
        "no trained model: predictions come from LocalDecisionEngine"
    )


def test_cpu_path_export_cannot_pass_even_with_lenient_thresholds(tmp_path):
    items = _eval_items(200)
    lenient = GateThresholds(
        brier_max=1.0, ece_max=1.0, accuracy_margin=0.0, min_eval_size=1
    )
    meta = UnslothDecisionTrainer(gate_thresholds=lenient).train_and_export(
        [], items, tmp_path
    )
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == [
        "no trained model: predictions come from LocalDecisionEngine"
    ]


def test_export_metrics_are_not_the_old_constants(tmp_path):
    items = _eval_items(200)
    meta = UnslothDecisionTrainer().train_and_export([], items, tmp_path)
    metrics = meta["eval_metrics"]
    assert metrics["brier_score"] != pytest.approx(0.08)
    assert metrics["expected_calibration_error"] != pytest.approx(0.03)
    assert metrics["accuracy"] != pytest.approx(0.94)
    for key in ("brier_score", "expected_calibration_error", "accuracy", "eval_size"):
        assert key in metrics


def test_trained_predictor_supplies_the_predictions_and_passes_gate(tmp_path):
    items = _eval_items(200)
    calls: list[str] = []
    predict_truth = _one_hot_predictor(items)

    def predictor(state: str) -> dict[str, float]:
        calls.append(state)
        return predict_truth(state)

    trainer = UnslothDecisionTrainer(trained_predictor=predictor)
    meta = trainer.train_and_export([], items, tmp_path)

    assert len(calls) == 200
    assert meta["prediction_source"] == "trained_model"
    metrics = meta["eval_metrics"]
    assert metrics["brier_score"] == pytest.approx(0.0)
    assert metrics["expected_calibration_error"] == pytest.approx(0.0)
    assert metrics["accuracy"] == pytest.approx(1.0)
    assert meta["gate"]["passed"] is True
    assert meta["gate"]["reasons"] == []
    assert meta["calibrated"] is True


def test_bad_trained_predictor_fails_on_brier(tmp_path):
    items = _eval_items(200)

    def always_store_task(state: str) -> dict[str, float]:
        return {
            "store_task": 1.0,
            "recall": 0.0,
            "update_or_forget": 0.0,
            "conversational": 0.0,
            "store_fact": 0.0,
        }

    meta = UnslothDecisionTrainer(trained_predictor=always_store_task).train_and_export(
        [], items, tmp_path
    )

    # Accuracy 0.25 clears the baseline of 0.0 plus the margin. Brier fails:
    # 0.75 of items score 2.0 (a wrong top class and a missed true class). ECE
    # fails too: every top probability is 1.0 and only a quarter are right.
    assert meta["eval_metrics"]["accuracy"] == pytest.approx(0.25)
    assert meta["eval_metrics"]["brier_score"] == pytest.approx(1.5)
    assert meta["eval_metrics"]["expected_calibration_error"] == pytest.approx(0.75)
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == [
        "brier_score 1.5000 above max 0.2000",
        "expected_calibration_error 0.7500 above max 0.1000",
    ]


def test_export_writes_gate_file_beside_metadata(tmp_path):
    items = _eval_items(200)
    predictor = _one_hot_predictor(items)
    meta = UnslothDecisionTrainer(trained_predictor=predictor).train_and_export(
        [], items, tmp_path
    )

    gate_path = Path(tmp_path) / DECISION_GATE_FILENAME
    assert gate_path.exists()
    gate_on_disk = json.loads(gate_path.read_text())
    assert gate_on_disk["passed"] is True
    assert gate_on_disk == meta["gate"]

    meta_on_disk = json.loads((Path(tmp_path) / "decision_model_meta.json").read_text())
    assert meta_on_disk["gate"]["passed"] is True


def test_failed_export_overwrites_a_passing_gate_file(tmp_path):
    items = _eval_items(200)
    UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert json.loads((tmp_path / DECISION_GATE_FILENAME).read_text())["passed"] is True

    # A CPU-path rerun into the same directory must not leave the old pass behind.
    UnslothDecisionTrainer().train_and_export([], items, tmp_path)
    assert (
        json.loads((tmp_path / DECISION_GATE_FILENAME).read_text())["passed"] is False
    )


def test_gate_file_is_removed_before_a_run_that_then_dies(tmp_path):
    items = _eval_items(200)
    UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert (tmp_path / DECISION_GATE_FILENAME).exists()

    def crashing_predictor(state: str) -> dict[str, float]:
        raise RuntimeError("training node went away")

    with pytest.raises(RuntimeError):
        UnslothDecisionTrainer(trained_predictor=crashing_predictor).train_and_export(
            [], items, tmp_path
        )
    assert not (tmp_path / DECISION_GATE_FILENAME).exists()


def test_small_eval_set_fails_with_eval_size_reason(tmp_path):
    items = _eval_items(10)
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["eval_size 10 below min 200"]


def test_items_without_a_known_intent_are_skipped_and_counted(tmp_path):
    items = [
        *_eval_items(200),
        {"state": "no label here", "answers": {}},
        {"state": "", "answers": {"intent": "store_task"}},
        {"state": "made-up intent", "answers": {"intent": "not_a_choice"}},
    ]
    meta = UnslothDecisionTrainer().train_and_export([], items, tmp_path)
    assert meta["eval_metrics"]["eval_size"] == 200
    gate = json.loads((tmp_path / DECISION_GATE_FILENAME).read_text())
    assert gate["eval_skipped"] == 3


def test_empty_eval_set_exports_missing_metrics_and_fails(tmp_path):
    meta = UnslothDecisionTrainer().train_and_export([], [], tmp_path)
    metrics = meta["eval_metrics"]
    assert metrics["brier_score"] is None
    assert metrics["expected_calibration_error"] is None
    assert metrics["accuracy"] is None
    assert metrics["eval_size"] == 0
    assert meta["gate"]["passed"] is False
    assert "brier_score missing" in meta["gate"]["reasons"]


def test_export_uses_settings_thresholds_when_none_are_given(tmp_path, monkeypatch):
    from ci.hbpe.config import settings

    monkeypatch.setattr(settings, "decision_gate_min_eval", 5)
    items = _eval_items(10)
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert meta["gate"]["thresholds"]["min_eval_size"] == 5
    assert meta["gate"]["passed"] is True


def test_explicit_thresholds_override_settings(tmp_path):
    items = _eval_items(10)
    strict = GateThresholds(min_eval_size=50)
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items), gate_thresholds=strict
    ).train_and_export([], items, tmp_path)
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["eval_size 10 below min 50"]
