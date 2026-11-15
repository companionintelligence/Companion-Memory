"""
Tests for held-out decision metrics and the gate written by the Unsloth export.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ci.hbpe.config import settings
from ci.hbpe.inference.decision_model import (
    MEMORY_INGRESS_QUESTIONS,
    LocalDecisionEngine,
)
from ci.hbpe.model import unsloth_decision_trainer
from ci.hbpe.model.decision_gate import DECISION_GATE_FILENAME, GateThresholds
from ci.hbpe.model.unsloth_decision_trainer import (
    UnslothDecisionTrainer,
    compute_brier_score,
    compute_calibration_error,
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


def _gate_on_disk(out_dir: Path) -> dict:
    return json.loads((out_dir / DECISION_GATE_FILENAME).read_text())


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


def test_brier_score_of_known_distributions_is_exact():
    # Item 1 (truth a): (0.75 - 1)^2 + (0.25 - 0)^2 = 0.0625 + 0.0625 = 0.125.
    # Item 2 (truth b): (1.0 - 0)^2 + (0.0 - 1)^2 = 2.0.
    # Mean over two items: (0.125 + 2.0) / 2 = 1.0625, exact in binary.
    predictions = [{"a": 0.75, "b": 0.25}, {"a": 1.0, "b": 0.0}]
    assert compute_brier_score(predictions, ["a", "b"]) == 1.0625


def test_brier_score_counts_a_missing_true_class_as_probability_zero():
    # The distribution leaves out the true class "recall", which has probability
    # 0. Its squared error is (0 - 1)^2 = 1, so it counts. Stating the classes
    # in full gives the same score.
    assert compute_brier_score([{"store_task": 1.0}], ["recall"]) == 2.0
    assert compute_brier_score([{"store_task": 1.0, "recall": 0.0}], ["recall"]) == 2.0


def test_classes_left_out_that_are_not_true_add_nothing():
    # The classes this distribution leaves out are not the truth, so they have
    # probability 0 and target 0, and contribute nothing.
    assert compute_brier_score([{"recall": 1.0}], ["recall"]) == 0.0


def test_calibration_error_of_known_bins_is_exact():
    # Bin [0.9, 1.0): two items, mean confidence 0.95, accuracy 0.5.
    #   |0.5 - 0.95| * 2/4 = 0.225
    # Bin [0.2, 0.3): two items, mean confidence 0.25, accuracy 0.5.
    #   |0.5 - 0.25| * 2/4 = 0.125
    ece = compute_calibration_error(
        [0.95, 0.95, 0.25, 0.25], [True, False, True, False]
    )
    assert ece == pytest.approx(0.35, abs=1e-12)


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


# ── Export without a trained model ───────────────────────────────────────────


def test_export_without_a_trained_model_reports_no_candidate_metrics(tmp_path):
    items = _eval_items(200)

    meta = UnslothDecisionTrainer().train_and_export([], items, tmp_path)

    assert meta["prediction_source"] == "none"
    assert meta["eval_metrics"] == {
        "brier_score": None,
        "expected_calibration_error": None,
        "accuracy": None,
        "top1_accuracy": None,
        "eval_size": None,
    }
    assert meta["calibrated"] is False
    assert meta["gate"]["metrics"] is None
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["no trained model"]
    assert _gate_on_disk(tmp_path) == meta["gate"]


def test_export_without_a_trained_model_reports_the_baseline_only(tmp_path):
    items = _eval_items(200)

    meta = UnslothDecisionTrainer().train_and_export([], items, tmp_path)

    # The rule engine ties every intent at 0.2 and picks store_fact, which these
    # labels never are. Each item's Brier is 0.64 + 4 * 0.04 = 0.8, and its
    # top probability 0.2 is always wrong, so ECE is 0.2.
    baseline = meta["baseline_metrics"]
    assert baseline["accuracy"] == 0.0
    assert baseline["eval_size"] == 200
    assert baseline["brier_score"] == pytest.approx(0.8, abs=1e-12)
    assert baseline["expected_calibration_error"] == pytest.approx(0.2, abs=1e-12)
    assert meta["gate"]["baseline"] == baseline


def test_cpu_path_export_cannot_pass_even_with_lenient_thresholds(tmp_path):
    items = _eval_items(200)
    lenient = GateThresholds(
        brier_max=1.0, ece_max=1.0, accuracy_margin=0.0, min_eval_size=1
    )
    meta = UnslothDecisionTrainer(gate_thresholds=lenient).train_and_export(
        [], items, tmp_path
    )
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["no trained model"]


def test_export_without_a_trained_model_and_no_items_still_fails_cleanly(tmp_path):
    meta = UnslothDecisionTrainer().train_and_export([], [], tmp_path)
    assert meta["eval_metrics"]["eval_size"] is None
    assert meta["gate"]["reasons"] == ["no trained model"]
    assert meta["gate"]["baseline"]["eval_size"] == 0


# ── Export with a trained predictor ──────────────────────────────────────────


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


def test_trained_predictor_metrics_are_exact_on_a_known_set(tmp_path):
    items = _eval_items(200)
    truth = {item["state"]: item["answers"]["intent"] for item in items}

    def confident_truth(state: str) -> dict[str, float]:
        # Truth 0.95, each of the four other choices 0.0125: the sum is 1.0.
        return {
            choice: 0.95 if choice == truth[state] else 0.0125
            for choice in ["store_fact", *INTENT_CYCLE]
        }

    meta = UnslothDecisionTrainer(trained_predictor=confident_truth).train_and_export(
        [], items, tmp_path
    )

    metrics = meta["eval_metrics"]
    assert metrics["eval_size"] == 200
    assert metrics["accuracy"] == 1.0
    assert metrics["top1_accuracy"] == 1.0
    # Each item: (0.95 - 1)^2 + 4 * 0.0125^2 = 0.0025 + 0.000625 = 0.003125.
    assert metrics["brier_score"] == pytest.approx(0.003125, abs=1e-12)
    # Every top probability is 0.95 and every top is right: |1.0 - 0.95| = 0.05.
    assert metrics["expected_calibration_error"] == pytest.approx(0.05, abs=1e-12)
    assert meta["gate"]["passed"] is True
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
    # The predictor only ever sees the 200 valid states.
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(_eval_items(200))
    ).train_and_export([], items, tmp_path)
    assert meta["eval_metrics"]["eval_size"] == 200
    assert _gate_on_disk(tmp_path)["eval_skipped"] == 3


def test_empty_eval_set_exports_missing_metrics_and_fails(tmp_path):
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor([])
    ).train_and_export([], [], tmp_path)
    metrics = meta["eval_metrics"]
    assert metrics["brier_score"] is None
    assert metrics["expected_calibration_error"] is None
    assert metrics["accuracy"] is None
    assert metrics["eval_size"] == 0
    assert meta["gate"]["passed"] is False
    assert "brier_score missing" in meta["gate"]["reasons"]


def test_export_uses_settings_thresholds_when_none_are_given(tmp_path, monkeypatch):
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


def test_invalid_threshold_fails_the_export_without_raising(tmp_path):
    items = _eval_items(200)
    bad = GateThresholds(ece_max=-0.1)
    meta = UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items), gate_thresholds=bad
    ).train_and_export([], items, tmp_path)
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == [
        "invalid threshold: ece_max -0.1 must be a number from 0 to 1"
    ]
    assert meta["gate"]["thresholds"]["ece_max"] == -0.1


# ── Trained predictor failures ───────────────────────────────────────────────


def test_predictor_that_raises_fails_the_gate_without_stopping_the_export(tmp_path):
    items = _eval_items(200)

    def crashing_predictor(state: str) -> dict[str, float]:
        raise RuntimeError("training node went away")

    meta = UnslothDecisionTrainer(
        trained_predictor=crashing_predictor
    ).train_and_export([], items, tmp_path)

    assert meta["prediction_source"] == "trained_model"
    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["predictor error"]
    assert meta["gate"]["predictor_error"] == "RuntimeError: training node went away"
    assert meta["eval_metrics"]["brier_score"] is None
    assert meta["calibrated"] is False
    assert _gate_on_disk(tmp_path)["reasons"] == ["predictor error"]


@pytest.mark.parametrize(
    "bad_distribution",
    [
        {},
        {"recall": float("nan")},
        {"recall": -0.5, "store_task": 1.5},
        {"recall": 0.5},
        {"not_a_choice": 1.0},
        {"recall": True},
    ],
    ids=["empty", "nan", "out-of-range", "not-summing-to-one", "unknown-label", "bool"],
)
def test_malformed_distribution_fails_the_gate_with_predictor_error(
    tmp_path, bad_distribution
):
    items = _eval_items(200)

    meta = UnslothDecisionTrainer(
        trained_predictor=lambda state: bad_distribution
    ).train_and_export([], items, tmp_path)

    assert meta["gate"]["passed"] is False
    assert meta["gate"]["reasons"] == ["predictor error"]
    assert meta["eval_metrics"]["accuracy"] is None


# ── Gate file is always replaced ─────────────────────────────────────────────


def test_failed_export_replaces_a_passing_gate_file(tmp_path):
    items = _eval_items(200)
    UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert _gate_on_disk(tmp_path)["passed"] is True

    def failing_predictor(state: str) -> dict[str, float]:
        raise RuntimeError("bad checkpoint")

    UnslothDecisionTrainer(trained_predictor=failing_predictor).train_and_export(
        [], items, tmp_path
    )
    failed = _gate_on_disk(tmp_path)
    assert failed["passed"] is False
    assert failed["reasons"] == ["predictor error"]

    # A later pass replaces that failure, and a CPU-path rerun replaces it again.
    UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert _gate_on_disk(tmp_path)["passed"] is True
    UnslothDecisionTrainer().train_and_export([], items, tmp_path)
    gate = _gate_on_disk(tmp_path)
    assert gate["passed"] is False
    assert gate["reasons"] == ["no trained model"]


def test_run_that_dies_part_way_leaves_a_failed_gate_not_the_old_pass(
    tmp_path, monkeypatch
):
    items = _eval_items(200)
    UnslothDecisionTrainer(
        trained_predictor=_one_hot_predictor(items)
    ).train_and_export([], items, tmp_path)
    assert _gate_on_disk(tmp_path)["passed"] is True

    def engine_went_away(state, engine=None):
        raise RuntimeError("engine went away")

    monkeypatch.setattr(
        unsloth_decision_trainer, "local_intent_distribution", engine_went_away
    )
    with pytest.raises(RuntimeError, match="engine went away"):
        UnslothDecisionTrainer(
            trained_predictor=_one_hot_predictor(items)
        ).train_and_export([], items, tmp_path)

    assert _gate_on_disk(tmp_path) == {
        "passed": False,
        "reasons": ["export did not finish"],
    }
