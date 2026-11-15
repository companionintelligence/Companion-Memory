"""
Promotion gate for Unsloth decision-model exports.

The gate measures the intent head only. The trainer scores held-out intent
labels against a baseline (the rule-based LocalDecisionEngine) and evaluates
them with ``evaluate_decision_gate``. The result goes under ``gate`` in
``decision_model_meta.json`` and into ``decision_gate.json`` next to the model.
DecisionModelClient reads that file from HBPE_DECISION_GATE_FILE via
``check_gate_file``.

When HBPE_DECISION_GATE_ENFORCE is on, the client sends the intent question to
the endpoint only while the gate passed, and answers every other question
locally, because the gate does not measure them. A missing, malformed or failed
gate then means the client does not use the endpoint. When enforcement is off,
the client ignores the gate and only records its status.

Default thresholds:
  brier_score                  <= 0.20
  expected_calibration_error   <= 0.10
  accuracy                     >= baseline accuracy + 0.02
  eval_size                    >= 200

Every threshold is overridable through Settings (HBPE_DECISION_GATE_*). An
invalid threshold fails the gate with an "invalid threshold" reason.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DECISION_GATE_FILENAME = "decision_gate.json"

# Slack for the threshold comparisons. Float sums are not exact: 0.1 + 0.2 is
# 0.30000000000000004, so an accuracy of 0.3 against a baseline of 0.1 and a
# margin of 0.2 would miss by one ulp without this slack. Some sums are exact,
# such as 0.5 + 0.02 == 0.52, and need none.
_EPS = 1e-9


@dataclass(frozen=True)
class GateThresholds:
    brier_max: float = 0.20
    ece_max: float = 0.10
    accuracy_margin: float = 0.02
    min_eval_size: int = 200

    @classmethod
    def from_settings(cls, cfg: Any) -> GateThresholds:
        """Build thresholds from a Settings object (duck-typed, no import here)."""
        return cls(
            brier_max=float(cfg.decision_gate_brier_max),
            ece_max=float(cfg.decision_gate_ece_max),
            accuracy_margin=float(cfg.decision_gate_accuracy_margin),
            min_eval_size=int(cfg.decision_gate_min_eval),
        )

    def to_dict(self) -> dict[str, float | int]:
        return {
            "brier_max": self.brier_max,
            "ece_max": self.ece_max,
            "accuracy_margin": self.accuracy_margin,
            "min_eval_size": self.min_eval_size,
        }


@dataclass
class GateResult:
    passed: bool
    reasons: list[str] = field(default_factory=list)


def _metric(source: Mapping[str, Any] | None, key: str) -> float | None:
    """A finite real number from *source[key]*, or None when absent or invalid."""
    if source is None:
        return None
    value = source.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _threshold_problems(t: GateThresholds) -> list[str]:
    """Why a threshold cannot be used, one message each. Empty when all are usable."""
    problems: list[str] = []
    for name, value in (
        ("brier_max", t.brier_max),
        ("ece_max", t.ece_max),
        ("accuracy_margin", t.accuracy_margin),
    ):
        if not _is_real(value) or not 0.0 <= value <= 1.0:
            problems.append(f"{name} {value!r} must be a number from 0 to 1")
    if (
        isinstance(t.min_eval_size, bool)
        or not isinstance(t.min_eval_size, int)
        or t.min_eval_size < 0
    ):
        problems.append(
            f"min_eval_size {t.min_eval_size!r} must be a whole number of 0 or more"
        )
    return problems


def _is_real(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def evaluate_decision_gate(
    metrics: Mapping[str, Any],
    baseline: Mapping[str, Any] | None,
    thresholds: GateThresholds | None = None,
) -> GateResult:
    """
    Check held-out metrics against the promotion thresholds.

    Every failed check adds one reason, so a result lists all failures. A metric
    that is missing, null, non-finite or boolean fails its check and is reported
    as missing. A missing baseline accuracy fails the accuracy check. Thresholds
    that are not usable fail the gate before any metric is read.
    """
    t = thresholds or GateThresholds()
    problems = _threshold_problems(t)
    if problems:
        return GateResult(
            passed=False, reasons=[f"invalid threshold: {p}" for p in problems]
        )

    reasons: list[str] = []

    brier = _metric(metrics, "brier_score")
    if brier is None:
        reasons.append("brier_score missing")
    elif brier > t.brier_max + _EPS:
        reasons.append(f"brier_score {brier:.4f} above max {t.brier_max:.4f}")

    ece = _metric(metrics, "expected_calibration_error")
    if ece is None:
        reasons.append("expected_calibration_error missing")
    elif ece > t.ece_max + _EPS:
        reasons.append(
            f"expected_calibration_error {ece:.4f} above max {t.ece_max:.4f}"
        )

    accuracy = _metric(metrics, "accuracy")
    baseline_accuracy = _metric(baseline, "accuracy")
    if accuracy is None:
        reasons.append("accuracy missing")
    if baseline_accuracy is None:
        reasons.append("baseline accuracy missing")
    if accuracy is not None and baseline_accuracy is not None:
        required = baseline_accuracy + t.accuracy_margin
        if accuracy + _EPS < required:
            reasons.append(
                f"accuracy {accuracy:.4f} below baseline {baseline_accuracy:.4f}"
                f" + margin {t.accuracy_margin:.4f}"
            )

    eval_size = _metric(metrics, "eval_size")
    if eval_size is None:
        reasons.append("eval_size missing")
    elif eval_size < t.min_eval_size:
        reasons.append(f"eval_size {int(eval_size)} below min {t.min_eval_size}")

    return GateResult(passed=not reasons, reasons=reasons)


def gate_result_from_record(record: Any) -> GateResult:
    """
    Read a gate result from a parsed JSON value.

    Accepts the gate object itself (``{"passed": ...}``) or a metadata object
    that holds it under ``gate``. Only a boolean ``true`` passes.
    """
    if not isinstance(record, dict):
        return GateResult(False, ["decision gate record is not a JSON object"])
    nested = record.get("gate")
    if "passed" not in record and isinstance(nested, dict):
        record = nested
    passed = record.get("passed")
    if not isinstance(passed, bool):
        return GateResult(False, ["decision gate record has no boolean 'passed'"])
    if passed:
        return GateResult(True, [])
    reasons = record.get("reasons")
    if isinstance(reasons, list) and reasons:
        return GateResult(False, [str(reason) for reason in reasons])
    return GateResult(False, ["decision gate did not pass"])


def check_gate_file(path: str | Path | None) -> GateResult:
    """
    Read the gate file the export wrote. Only a file that exists, parses and
    says ``passed: true`` passes. Anything else is a failed gate with the reason.
    """
    if not path:
        return GateResult(
            False, ["decision gate file not configured (HBPE_DECISION_GATE_FILE)"]
        )
    gate_path = Path(path)
    try:
        raw = gate_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return GateResult(False, [f"decision gate file not found: {gate_path}"])
    except (OSError, UnicodeDecodeError) as err:
        return GateResult(
            False, [f"decision gate file unreadable: {gate_path} ({err})"]
        )
    try:
        record = json.loads(raw)
    except ValueError:
        return GateResult(False, [f"decision gate file is not valid JSON: {gate_path}"])
    return gate_result_from_record(record)
