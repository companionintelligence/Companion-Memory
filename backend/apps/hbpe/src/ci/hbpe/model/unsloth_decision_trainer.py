"""
Unsloth Decision Model Trainer & Dataset Builder for Companion Memory.

Provides training pipeline integration for non-autoregressive decision models
using Unsloth FastDecisionModel and DecisionTrainer:
  - Dataset synthesis from Companion Memory interaction traces
  - Multi-question decision formatting (choice, noul, score)
  - Calibration metrics (Brier score, Expected Calibration Error)
  - LoRA / QLoRA 4-bit configuration and checkpoint export
  - Held-out intent evaluation and the promotion gate written with each export
"""

from __future__ import annotations

import importlib.util
import json
import logging
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ci.hbpe.inference.decision_model import (
    GATED_QUESTION,
    MEMORY_INGRESS_QUESTIONS,
    LocalDecisionEngine,
)
from ci.hbpe.model.decision_gate import (
    DECISION_GATE_FILENAME,
    GateResult,
    GateThresholds,
    evaluate_decision_gate,
)
from ci.hbpe.model.train_io import atomic_write, seed_everything

log = logging.getLogger(__name__)

INTENT_QUESTION = GATED_QUESTION
_INTENT_CHOICES: tuple[str, ...] = tuple(
    MEMORY_INGRESS_QUESTIONS[INTENT_QUESTION].criteria or {}
)

# Maps one state text to a distribution over intent choices. The GPU path passes
# the trained model's predictor. The CPU path leaves it unset: there is no trained
# model, so the export reports no candidate metrics.
TrainedPredictor = Callable[[str], Mapping[str, float]]


@dataclass
class DecisionDatasetItem:
    state: str
    questions: dict[str, dict[str, Any]]
    answers: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "questions": self.questions,
            "answers": self.answers,
        }


def format_memory_event_to_decision_item(
    text: str,
    intent_label: str,
    is_commitment: bool = False,
    sensitivity_score: int = 0,
) -> DecisionDatasetItem:
    """Format a memory text and ground-truth labels into an Unsloth decision item."""
    questions_dict = {k: q.to_dict() for k, q in MEMORY_INGRESS_QUESTIONS.items()}
    answers_dict = {
        "intent": intent_label,
        "is_commitment": is_commitment,
        "sensitivity": sensitivity_score,
    }
    return DecisionDatasetItem(
        state=text,
        questions=questions_dict,
        answers=answers_dict,
    )


def build_decision_dataset_from_events(
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert raw Companion Memory event dictionaries into Unsloth decision dataset items."""
    dataset: list[dict[str, Any]] = []

    for ev in events:
        text = ev.get("text", "") or ev.get("content", "")
        if not text:
            continue

        raw_intent = ev.get("intent", "conversational")
        if raw_intent not in MEMORY_INGRESS_QUESTIONS["intent"].criteria:  # type: ignore
            raw_intent = "conversational"

        commitment = bool(ev.get("is_commitment", False) or ev.get("actionable", False))
        sensitivity = int(ev.get("sensitivity", 0))

        item = format_memory_event_to_decision_item(
            text=text,
            intent_label=raw_intent,
            is_commitment=commitment,
            sensitivity_score=sensitivity,
        )
        dataset.append(item.to_dict())

    return dataset


def compute_brier_score(
    predictions: list[dict[str, float]],
    ground_truth: list[str],
) -> float:
    """
    Compute multi-class Brier score.
    BS = (1/N) * sum_i sum_k (p_{ik} - y_{ik})^2
    Lower is better (0.0 = perfect calibrated confidence, 1.0+ = severe miscalibration).
    A class that a distribution leaves out has probability 0. When it is the true
    class, its full squared error of 1 still counts.
    """
    if not predictions or not ground_truth or len(predictions) != len(ground_truth):
        return 0.0

    total_error = 0.0
    for probs, true_class in zip(predictions, ground_truth, strict=True):
        for choice, prob in probs.items():
            target = 1.0 if choice == true_class else 0.0
            total_error += (prob - target) ** 2
        if true_class not in probs:
            # The true class has probability 0, so its error is (0 - 1)^2 = 1.
            total_error += 1.0

    return total_error / len(predictions)


def compute_calibration_error(
    predicted_probs: list[float],
    true_labels: list[bool],
    num_bins: int = 10,
) -> float:
    """
    Compute Expected Calibration Error (ECE) for binary / confidence estimates.
    ECE = sum_{b=1}^B (|B_m| / N) * |acc(B_m) - conf(B_m)|
    """
    if not predicted_probs or len(predicted_probs) != len(true_labels):
        return 0.0

    n = len(predicted_probs)
    bin_size = 1.0 / num_bins
    ece = 0.0

    for b in range(num_bins):
        bin_lower = b * bin_size
        bin_upper = (b + 1) * bin_size

        indices = [
            i
            for i, p in enumerate(predicted_probs)
            if bin_lower <= p < bin_upper or (b == num_bins - 1 and p == 1.0)
        ]

        if not indices:
            continue

        bin_conf = sum(predicted_probs[i] for i in indices) / len(indices)
        bin_acc = sum(1.0 for i in indices if true_labels[i]) / len(indices)

        ece += (len(indices) / n) * abs(bin_acc - bin_conf)

    return ece


def local_intent_distribution(
    state: str, engine: LocalDecisionEngine | None = None
) -> dict[str, float]:
    """Intent distribution from the rule-based LocalDecisionEngine (CPU path)."""
    scorer = engine or LocalDecisionEngine()
    results = scorer.evaluate(
        state, {INTENT_QUESTION: MEMORY_INGRESS_QUESTIONS[INTENT_QUESTION]}
    )
    return dict(results[INTENT_QUESTION].distribution)


def compute_intent_metrics(
    predictions: list[Mapping[str, float]],
    labels: list[str],
) -> dict[str, float | int | None]:
    """
    Brier score, ECE and top-1 accuracy of intent distributions on held-out items.

    With no items every metric is None, not 0.0. compute_brier_score returns 0.0
    for empty input, which would read as a perfect score.
    """
    n = len(labels)
    if len(predictions) != n:
        raise ValueError(
            f"{len(predictions)} predictions for {n} held-out labels; they must match"
        )
    if n == 0:
        return {
            "brier_score": None,
            "expected_calibration_error": None,
            "accuracy": None,
            "eval_size": 0,
        }

    dists = [dict(p) for p in predictions]
    for i, dist in enumerate(dists):
        if not dist:
            raise ValueError(f"predictor returned no intent distribution for item {i}")

    tops = [max(dist.items(), key=lambda kv: kv[1]) for dist in dists]
    correct = [
        top_label == truth for (top_label, _), truth in zip(tops, labels, strict=True)
    ]
    return {
        "brier_score": compute_brier_score(dists, labels),
        "expected_calibration_error": compute_calibration_error(
            [prob for _, prob in tops], correct
        ),
        "accuracy": sum(correct) / n,
        "eval_size": n,
    }


def intent_eval_items(
    eval_dataset: list[dict[str, Any]],
) -> tuple[list[str], list[str], int]:
    """
    Held-out (state, intent label) pairs from eval items, plus the count skipped.

    An item is skipped when it has no state or its intent is not a known choice.
    """
    states: list[str] = []
    labels: list[str] = []
    skipped = 0
    for item in eval_dataset:
        state = item.get("state")
        answers = item.get("answers") or {}
        label = answers.get(INTENT_QUESTION)
        if not isinstance(state, str) or not state or label not in _INTENT_CHOICES:
            skipped += 1
            continue
        states.append(state)
        labels.append(str(label))
    return states, labels, skipped


def _checked_distribution(raw: Any) -> dict[str, float]:
    """
    A predictor's distribution over the intent choices. Raises ValueError with the
    reason when it is not one: empty, an unknown choice, a probability that is not
    a finite number in [0, 1], or probabilities that do not sum to 1.
    """
    dist = dict(raw)
    if not dist:
        raise ValueError("empty intent distribution")
    for choice, prob in dist.items():
        if choice not in _INTENT_CHOICES:
            raise ValueError(f"unknown intent {choice!r}")
        if (
            isinstance(prob, bool)
            or not isinstance(prob, int | float)
            or not math.isfinite(prob)
            or not 0.0 <= prob <= 1.0
        ):
            raise ValueError(f"probability {prob!r} for {choice!r} is not in [0, 1]")
    total = sum(dist.values())
    if not math.isclose(total, 1.0, abs_tol=1e-6):
        raise ValueError(f"probabilities sum to {total!r}, not 1")
    return {str(choice): float(prob) for choice, prob in dist.items()}


def _score_trained_predictor(
    predictor: TrainedPredictor,
    states: list[str],
    labels: list[str],
) -> tuple[dict[str, Any] | None, str | None]:
    """
    Held-out metrics for a trained predictor, or None and the reason it failed.

    The predictor is caller code. A call that raises, or a distribution that is not
    one, fails the gate. It does not stop the export.
    """
    try:
        predictions = [_checked_distribution(predictor(state)) for state in states]
        return compute_intent_metrics(predictions, labels), None
    except Exception as err:
        log.warning(
            "Trained predictor failed on held-out items: %s: %s",
            type(err).__name__,
            err,
        )
        return None, f"{type(err).__name__}: {err}"


def _json_safe(value: Any) -> Any:
    """A copy of *value* with each non-finite float replaced by None (strict JSON)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(item) for item in value]
    return value


def _write_gate_file(path: Path, record: Mapping[str, Any]) -> None:
    """Replace the gate file atomically, so an earlier pass never outlives this run."""
    body = json.dumps(record, indent=2, allow_nan=False)
    atomic_write(path, lambda tmp: tmp.write_text(body, encoding="utf-8"))


@dataclass
class UnslothDecisionTrainConfig:
    base_model_name: str = "Qwen/Qwen3.5-0.8B"
    max_seq_length: int = 2048
    lora_r: int = 16
    lora_alpha: int = 16
    lora_dropout: float = 0.0
    batch_size: int = 4
    gradient_accumulation_steps: int = 2
    epochs: int = 3
    learning_rate: float = 2e-4
    load_in_4bit: bool = True
    seed: int = 1337


class UnslothDecisionTrainer:
    """
    Trainer coordinator for Decision Models.

    No Unsloth training runs in this class yet. train_and_export scores the
    held-out intent items and writes the metrics and the promotion gate.
      - With trained_predictor, the predictions come from it and are measured
        against the baseline.
      - Without it there is no trained model, so no candidate metrics exist:
        eval_metrics are null, prediction_source is "none", and the gate fails
        with "no trained model". The baseline (LocalDecisionEngine) is still
        reported under baseline_metrics.
    The gate result goes under "gate" in decision_model_meta.json and into
    decision_gate.json beside it. Every export replaces that file, pass or fail.
    """

    def __init__(
        self,
        config: UnslothDecisionTrainConfig | None = None,
        *,
        trained_predictor: TrainedPredictor | None = None,
        gate_thresholds: GateThresholds | None = None,
    ) -> None:
        self.config = config or UnslothDecisionTrainConfig()
        self.trained_predictor = trained_predictor
        self.gate_thresholds = gate_thresholds

    def train_and_export(
        self,
        train_dataset: list[dict[str, Any]],
        eval_dataset: list[dict[str, Any]],
        output_dir: str | Path,
    ) -> dict[str, Any]:
        seed_everything(self.config.seed)
        out_path = Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        gate_file = out_path / DECISION_GATE_FILENAME

        log.info(
            "Starting Unsloth decision model training: %d train, %d eval items (base=%s, 4bit=%s)",
            len(train_dataset),
            len(eval_dataset),
            self.config.base_model_name,
            self.config.load_in_4bit,
        )

        # Check for the native unsloth library without importing it
        if importlib.util.find_spec("unsloth") is None:
            log.info(
                "Unsloth library not present in environment; running CPU verification pipeline"
            )

        # Until this run finishes, the gate file says so. Replacing it now, rather
        # than deleting it, means a run that dies part way cannot leave an earlier
        # pass in place.
        _write_gate_file(
            gate_file, {"passed": False, "reasons": ["export did not finish"]}
        )

        from ci.hbpe.config import settings

        thresholds = self.gate_thresholds or GateThresholds.from_settings(settings)
        states, labels, skipped = intent_eval_items(eval_dataset)
        baseline = compute_intent_metrics(
            [local_intent_distribution(s) for s in states], labels
        )

        candidate: dict[str, Any] | None
        predictor_error: str | None = None
        if self.trained_predictor is None:
            prediction_source = "none"
            candidate = None
            gate = GateResult(passed=False, reasons=["no trained model"])
        else:
            prediction_source = "trained_model"
            candidate, predictor_error = _score_trained_predictor(
                self.trained_predictor, states, labels
            )
            if candidate is None:
                gate = GateResult(passed=False, reasons=["predictor error"])
            else:
                gate = evaluate_decision_gate(candidate, baseline, thresholds)

        gate_record: dict[str, Any] = {
            "passed": gate.passed,
            "reasons": list(gate.reasons),
            "thresholds": thresholds.to_dict(),
            "prediction_source": prediction_source,
            "metrics": candidate,
            "baseline": baseline,
            "eval_skipped": skipped,
        }
        if predictor_error is not None:
            gate_record["predictor_error"] = predictor_error

        reported = candidate or dict.fromkeys(
            ("brier_score", "expected_calibration_error", "accuracy", "eval_size")
        )
        ece = reported["expected_calibration_error"]
        metadata = {
            "model_type": "decision-laya-unsloth",
            "base_model": self.config.base_model_name,
            "lora_rank": self.config.lora_r,
            "eval_metrics": {
                "brier_score": reported["brier_score"],
                "expected_calibration_error": ece,
                "accuracy": reported["accuracy"],
                # Kept for readers of the original key. It is the same accuracy.
                "top1_accuracy": reported["accuracy"],
                "eval_size": reported["eval_size"],
            },
            "prediction_source": prediction_source,
            "baseline_metrics": baseline,
            "calibrated": ece is not None and ece <= thresholds.ece_max,
            "gate": gate_record,
            "train_samples": len(train_dataset),
            "eval_samples": len(eval_dataset),
        }
        metadata = _json_safe(metadata)

        # Atomically write decision metadata, then the gate beside it
        meta_file = out_path / "decision_model_meta.json"
        meta_body = json.dumps(metadata, indent=2, allow_nan=False)
        atomic_write(meta_file, lambda tmp: tmp.write_text(meta_body, encoding="utf-8"))
        _write_gate_file(gate_file, metadata["gate"])

        log.info(
            "Decision model export at %s: gate %s (%s)",
            out_path,
            "passed" if gate.passed else "failed",
            "; ".join(gate.reasons) or "all thresholds met",
        )
        return metadata
