"""
D3 serve gate: the candidate must beat the best baseline on Brier without being
materially worse calibrated.

Top-1 used to be the primary branch — serve the candidate if it beat B1's
accuracy by five points. On a skewed multiclass corpus that rewards exactly the
wrong thing. ``scoring.argmax_class`` breaks ties by ``L0_CLASSES`` order and
WORK is first, so a model that collapses to the plurality class collects its
base rate for free; B2 was measured scoring 0.4062 top-1, identical to a
uniform forecaster to four decimals, with recall 1.000 on WORK and 0.000 on
every other class. Accuracy could not tell that apart from a model that had
learned the day.

Brier is a proper scoring rule: it is minimised only by reporting the true
distribution, so it cannot be gamed by collapsing onto the majority class. It
is the primary criterion here, with ECE as a constraint rather than a second
way to pass — a candidate that improves Brier while becoming badly calibrated
is not safe to serve, and one that improves calibration while forecasting worse
should not displace the baseline.

Top-1 is still computed and stored. It is a diagnostic, not a gate.

If the candidate misses, serve whichever baseline scores better rather than
always falling back to B2. Missing scores degrade to the candidate when a
checkpoint exists, else B1.
"""

from __future__ import annotations

from typing import Any

# Absolute Brier improvement the candidate must show over the best baseline.
# Brier on 8 classes spans [0, 2]; 0.02 is comfortably outside the run-to-run
# noise of a few hundred scored buckets and well inside a real modelling gain.
BRIER_MARGIN = 0.02

# How much worse-calibrated than the best baseline the candidate may be and
# still serve. Not zero: ECE is a binned estimate and noisy on small windows,
# so an exact comparison would bench a candidate over sampling error.
ECE_TOLERANCE = 0.02

# Retained for callers and dashboards that still report the old accuracy
# margin. Nothing in the gate reads it.
TOP1_MARGIN = 0.05

MODEL_HMT = "hmt"
MODEL_B0 = "b0"
MODEL_B1 = "b1"
MODEL_B2 = "b2"
MODEL_LOGIT = "logit"


def _f(row: dict[str, Any] | None, key: str) -> float | None:
    if not row:
        return None
    val = row.get(key)
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _better_baseline(b1: dict[str, Any] | None, b2: dict[str, Any] | None) -> str:
    """Whichever baseline scores better on Brier, defaulting to B2 as before."""
    b1_brier, b2_brier = _f(b1, "brier"), _f(b2, "brier")
    if b1_brier is None:
        return MODEL_B2
    if b2_brier is None:
        return MODEL_B1
    return MODEL_B1 if b1_brier < b2_brier else MODEL_B2


def pick_served_model(
    hmt: dict[str, Any] | None,
    b1: dict[str, Any] | None,
    b2: dict[str, Any] | None,
    *,
    has_checkpoint: bool,
) -> str:
    """
    Serve the candidate only if it forecasts better than every baseline and is
    not materially worse calibrated than the best of them.
    """
    hmt_brier = _f(hmt, "brier")
    baseline_briers = [
        value for value in (_f(b1, "brier"), _f(b2, "brier")) if value is not None
    ]
    if hmt_brier is None or not baseline_briers:
        return MODEL_HMT if has_checkpoint else MODEL_B1

    if hmt_brier > min(baseline_briers) - BRIER_MARGIN:
        return _better_baseline(b1, b2)

    hmt_ece = _f(hmt, "ece")
    baseline_eces = [
        value for value in (_f(b1, "ece"), _f(b2, "ece")) if value is not None
    ]
    if (
        hmt_ece is not None
        and baseline_eces
        and hmt_ece > min(baseline_eces) + ECE_TOLERANCE
    ):
        return _better_baseline(b1, b2)

    return MODEL_HMT


def normalize_logged_version(version: str | None) -> str:
    """Map ``hmt_int8.onnx@mtime`` (and friends) to the D3 short name."""
    if not version:
        return MODEL_HMT
    v = version.lower()
    for name in (MODEL_B0, MODEL_B1, MODEL_B2, MODEL_HMT):
        if v == name or v.startswith(f"{name}@") or v.startswith(f"{name}_"):
            return name
    if "hmt" in v or v.endswith(".onnx") or v.endswith(".pt"):
        return MODEL_HMT
    return v
