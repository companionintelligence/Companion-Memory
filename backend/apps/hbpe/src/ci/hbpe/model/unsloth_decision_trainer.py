"""
Unsloth Decision Model Trainer & Dataset Builder for Companion Memory.

Provides training pipeline integration for non-autoregressive decision models
using Unsloth FastDecisionModel and DecisionTrainer:
  - Dataset synthesis from Companion Memory interaction traces
  - Multi-question decision formatting (choice, noul, score)
  - Calibration metrics (Brier score, Expected Calibration Error)
  - LoRA / QLoRA 4-bit configuration and checkpoint export
"""

from __future__ import annotations

import importlib.util
import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ci.hbpe.inference.decision_model import (
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

INTENT_QUESTION = "intent"
_INTENT_CHOICES: tuple[str, ...] = tuple(
    MEMORY_INGRESS_QUESTIONS[INTENT_QUESTION].criteria or {}
)

# Maps one state text to a distribution over intent choices. The GPU path passes
# the trained model's predictor. The CPU path leaves it unset and uses
# LocalDecisionEngine.
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
    """
    if not predictions or not ground_truth or len(predictions) != len(ground_truth):
        return 0.0

    total_error = 0.0
    for probs, true_class in zip(predictions, ground_truth, strict=True):
        for choice, prob in probs.items():
            target = 1.0 if choice == true_class else 0.0
            total_error += (prob - target) ** 2

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
    held-out eval items and writes the metrics and the promotion gate:
      - GPU path: when trained_predictor is given, the predictions come from it.
      - CPU path: otherwise the predictions come from LocalDecisionEngine.
    The gate result goes under "gate" in decision_model_meta.json and into
    decision_gate.json beside it. CPU-path exports always fail the gate: there is
    no trained model to promote, and the candidate is the baseline.
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

        # A gate file from an earlier export must not outlive this run. If this
        # run dies before it writes its own gate, the old pass would still be served.
        gate_file = out_path / DECISION_GATE_FILENAME
        gate_file.unlink(missing_ok=True)

        states, labels, skipped = intent_eval_items(eval_dataset)
        baseline_predictions = [local_intent_distribution(s) for s in states]
        baseline = compute_intent_metrics(baseline_predictions, labels)

        if self.trained_predictor is None:
            prediction_source = "local_engine"
            candidate = baseline
        else:
            prediction_source = "trained_model"
            candidate = compute_intent_metrics(
                [dict(self.trained_predictor(s)) for s in states], labels
            )

        from ci.hbpe.config import settings

        thresholds = self.gate_thresholds or GateThresholds.from_settings(settings)
        gate = evaluate_decision_gate(candidate, baseline, thresholds)
        if prediction_source == "local_engine":
            # Nothing was trained, so there is nothing to promote, whatever the
            # thresholds say. The metric reasons above are still reported.
            gate = GateResult(
                passed=False,
                reasons=[
                    *gate.reasons,
                    "no trained model: predictions come from LocalDecisionEngine",
                ],
            )
        gate_record: dict[str, Any] = {
            "passed": gate.passed,
            "reasons": list(gate.reasons),
            "thresholds": thresholds.to_dict(),
            "prediction_source": prediction_source,
            "metrics": candidate,
            "baseline": baseline,
            "eval_skipped": skipped,
        }

        ece = candidate["expected_calibration_error"]
        metadata = {
            "model_type": "decision-laya-unsloth",
            "base_model": self.config.base_model_name,
            "lora_rank": self.config.lora_r,
            "eval_metrics": {
                "brier_score": candidate["brier_score"],
                "expected_calibration_error": ece,
                "accuracy": candidate["accuracy"],
                # Kept for readers of the original key. It is the same accuracy.
                "top1_accuracy": candidate["accuracy"],
                "eval_size": candidate["eval_size"],
            },
            "prediction_source": prediction_source,
            "baseline_metrics": baseline,
            "calibrated": ece is not None and ece <= thresholds.ece_max,
            "gate": gate_record,
            "train_samples": len(train_dataset),
            "eval_samples": len(eval_dataset),
        }

        # Atomically write decision metadata, then the gate beside it
        meta_file = out_path / "decision_model_meta.json"
        atomic_write(
            meta_file, lambda tmp: tmp.write_text(json.dumps(metadata, indent=2))
        )
        atomic_write(
            gate_file, lambda tmp: tmp.write_text(json.dumps(gate_record, indent=2))
        )

        log.info(
            "Decision model export at %s: gate %s (%s)",
            out_path,
            "passed" if gate.passed else "failed",
            "; ".join(gate.reasons) or "all thresholds met",
        )
        return metadata
