"""
Unit tests for the decision-model promotion gate and its Settings.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ci.hbpe.config import Settings
from ci.hbpe.model.decision_gate import (
    DECISION_GATE_FILENAME,
    GateResult,
    GateThresholds,
    check_gate_file,
    evaluate_decision_gate,
    gate_result_from_record,
)

PASSING_METRICS = {
    "brier_score": 0.10,
    "expected_calibration_error": 0.05,
    "accuracy": 0.90,
    "eval_size": 500,
}
BASELINE = {"accuracy": 0.80}


def test_gate_passes_when_every_threshold_is_met():
    result = evaluate_decision_gate(PASSING_METRICS, BASELINE)
    assert result == GateResult(passed=True, reasons=[])


def test_gate_fails_brier_above_max():
    metrics = {**PASSING_METRICS, "brier_score": 0.25}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == ["brier_score 0.2500 above max 0.2000"]


def test_gate_brier_at_max_passes():
    metrics = {**PASSING_METRICS, "brier_score": 0.20}
    assert evaluate_decision_gate(metrics, BASELINE).passed is True


def test_gate_fails_ece_above_max():
    metrics = {**PASSING_METRICS, "expected_calibration_error": 0.12}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == ["expected_calibration_error 0.1200 above max 0.1000"]


def test_gate_fails_accuracy_without_the_margin():
    metrics = {**PASSING_METRICS, "accuracy": 0.81}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == ["accuracy 0.8100 below baseline 0.8000 + margin 0.0200"]


def test_gate_accuracy_exactly_at_baseline_plus_margin_passes():
    # 0.5 + 0.02 is exactly 0.52 in binary floating point, so this is a plain
    # boundary case. The next test covers a sum that is not exact.
    metrics = {**PASSING_METRICS, "accuracy": 0.52}
    assert evaluate_decision_gate(metrics, {"accuracy": 0.50}).passed is True


def test_gate_margin_slack_absorbs_an_inexact_float_sum():
    # 0.1 + 0.2 is 0.30000000000000004, so an accuracy of 0.3 is one ulp short of
    # the required value. evaluate_decision_gate's slack must still count it as met.
    assert 0.3 < 0.1 + 0.2  # the naive comparison fails on these numbers
    metrics = {**PASSING_METRICS, "accuracy": 0.3}
    result = evaluate_decision_gate(
        metrics, {"accuracy": 0.1}, GateThresholds(accuracy_margin=0.2)
    )
    assert result == GateResult(passed=True, reasons=[])


def test_gate_brier_slack_absorbs_an_inexact_float_sum():
    assert 0.1 + 0.2 > 0.3  # the naive comparison fails on these numbers
    metrics = {**PASSING_METRICS, "brier_score": 0.1 + 0.2}
    result = evaluate_decision_gate(metrics, BASELINE, GateThresholds(brier_max=0.3))
    assert result == GateResult(passed=True, reasons=[])


def test_gate_fails_eval_size_below_minimum():
    metrics = {**PASSING_METRICS, "eval_size": 199}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == ["eval_size 199 below min 200"]


def test_gate_eval_size_at_minimum_passes():
    metrics = {**PASSING_METRICS, "eval_size": 200}
    assert evaluate_decision_gate(metrics, BASELINE).passed is True


def test_gate_reports_every_failure():
    metrics = {
        "brier_score": 0.5,
        "expected_calibration_error": 0.5,
        "accuracy": 0.1,
        "eval_size": 3,
    }
    result = evaluate_decision_gate(metrics, {"accuracy": 0.9})
    assert result.passed is False
    assert len(result.reasons) == 4
    assert [r.split(" ")[0] for r in result.reasons] == [
        "brier_score",
        "expected_calibration_error",
        "accuracy",
        "eval_size",
    ]


@pytest.mark.parametrize(
    "missing_key",
    ["brier_score", "expected_calibration_error", "accuracy", "eval_size"],
)
def test_gate_fails_when_a_metric_is_missing(missing_key):
    metrics = {k: v for k, v in PASSING_METRICS.items() if k != missing_key}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == [f"{missing_key} missing"]


@pytest.mark.parametrize("bad_value", [None, float("nan"), float("inf"), True, "0.1"])
def test_gate_treats_null_nonfinite_boolean_or_text_metrics_as_missing(bad_value):
    metrics = {**PASSING_METRICS, "brier_score": bad_value}
    result = evaluate_decision_gate(metrics, BASELINE)
    assert result.passed is False
    assert result.reasons == ["brier_score missing"]


def test_gate_fails_without_baseline():
    result = evaluate_decision_gate(PASSING_METRICS, None)
    assert result.passed is False
    assert result.reasons == ["baseline accuracy missing"]


def test_gate_fails_when_baseline_has_no_accuracy():
    result = evaluate_decision_gate(PASSING_METRICS, {"brier_score": 0.1})
    assert result.passed is False
    assert result.reasons == ["baseline accuracy missing"]


def test_gate_thresholds_are_overridable():
    metrics = {
        "brier_score": 0.30,
        "expected_calibration_error": 0.15,
        "accuracy": 0.60,
        "eval_size": 50,
    }
    baseline = {"accuracy": 0.59}
    # Default: Brier, ECE, the 0.02 margin and eval size all fail.
    default_reasons = evaluate_decision_gate(metrics, baseline).reasons
    assert len(default_reasons) == 4
    relaxed = GateThresholds(
        brier_max=0.35,
        ece_max=0.20,
        accuracy_margin=0.0,
        min_eval_size=50,
    )
    assert evaluate_decision_gate(metrics, baseline, relaxed).passed is True


@pytest.mark.parametrize(
    "thresholds",
    [
        GateThresholds(brier_max=-0.1),
        GateThresholds(brier_max=1.5),
        GateThresholds(brier_max=float("nan")),
        GateThresholds(ece_max=float("inf")),
        GateThresholds(accuracy_margin=-0.02),
        GateThresholds(min_eval_size=-1),
        GateThresholds(min_eval_size=True),
    ],
)
def test_invalid_threshold_fails_the_gate_with_a_reason(thresholds):
    # The metrics pass every usable threshold, so only the bad value can fail it.
    result = evaluate_decision_gate(PASSING_METRICS, BASELINE, thresholds)
    assert result.passed is False
    assert len(result.reasons) == 1
    assert result.reasons[0].startswith("invalid threshold: ")


def test_thresholds_default_to_the_documented_values():
    assert GateThresholds() == GateThresholds(
        brier_max=0.20, ece_max=0.10, accuracy_margin=0.02, min_eval_size=200
    )


# ── Gate file ────────────────────────────────────────────────────────────────


def _write(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload))
    return path


def test_gate_file_passed_true_passes(tmp_path):
    path = _write(tmp_path / DECISION_GATE_FILENAME, {"passed": True, "reasons": []})
    assert check_gate_file(path).passed is True


def test_gate_file_passed_false_reports_its_reasons(tmp_path):
    path = _write(
        tmp_path / DECISION_GATE_FILENAME,
        {"passed": False, "reasons": ["eval_size 3 below min 200"]},
    )
    result = check_gate_file(path)
    assert result == GateResult(passed=False, reasons=["eval_size 3 below min 200"])


def test_gate_file_missing_fails_with_reason(tmp_path):
    result = check_gate_file(tmp_path / "absent.json")
    assert result.passed is False
    assert result.reasons[0].startswith("decision gate file not found")


def test_gate_file_unconfigured_fails_with_reason():
    for empty in (None, ""):
        result = check_gate_file(empty)
        assert result.passed is False
        assert "not configured" in result.reasons[0]


def test_gate_file_malformed_json_fails(tmp_path):
    path = tmp_path / DECISION_GATE_FILENAME
    path.write_text("{not json")
    result = check_gate_file(path)
    assert result.passed is False
    assert "not valid JSON" in result.reasons[0]


def test_gate_file_that_is_not_utf8_fails_instead_of_raising(tmp_path):
    path = tmp_path / DECISION_GATE_FILENAME
    path.write_bytes(b"\xff\xfe\x00 not text")
    result = check_gate_file(path)
    assert result.passed is False
    assert "unreadable" in result.reasons[0]


def test_gate_file_is_a_directory_fails_instead_of_raising(tmp_path):
    result = check_gate_file(tmp_path)
    assert result.passed is False
    assert "unreadable" in result.reasons[0]


def test_gate_file_passed_must_be_boolean_true(tmp_path):
    # The string "true" and the number 1 are not a passing gate.
    for value in ("true", 1, None):
        path = _write(tmp_path / DECISION_GATE_FILENAME, {"passed": value})
        result = check_gate_file(path)
        assert result.passed is False
        assert "no boolean 'passed'" in result.reasons[0]


def test_gate_record_nested_under_gate_key_is_read():
    assert gate_result_from_record({"gate": {"passed": True, "reasons": []}}).passed
    nested_fail = gate_result_from_record(
        {
            "model_type": "x",
            "gate": {"passed": False, "reasons": ["brier_score missing"]},
        }
    )
    assert nested_fail.passed is False
    assert nested_fail.reasons == ["brier_score missing"]


def test_gate_record_that_is_not_an_object_fails():
    result = gate_result_from_record(["passed"])
    assert result.passed is False


# ── Settings ─────────────────────────────────────────────────────────────────

_GATE_ENV_NAMES = [
    "HBPE_DECISION_GATE_FILE",
    "HBPE_DECISION_GATE_ENFORCE",
    "HBPE_DECISION_GATE_BRIER_MAX",
    "HBPE_DECISION_GATE_ECE_MAX",
    "HBPE_DECISION_GATE_ACCURACY_MARGIN",
    "HBPE_DECISION_GATE_MIN_EVAL",
]


def test_gate_settings_defaults(monkeypatch):
    for name in _GATE_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    s = Settings()
    assert s.decision_gate_file == ""
    assert s.decision_gate_enforce is False
    assert s.decision_gate_brier_max == 0.20
    assert s.decision_gate_ece_max == 0.10
    assert s.decision_gate_accuracy_margin == 0.02
    assert s.decision_gate_min_eval == 200


def test_gate_settings_read_their_hbpe_names(monkeypatch):
    monkeypatch.setenv("HBPE_DECISION_GATE_FILE", "/models/decision_gate.json")
    monkeypatch.setenv("HBPE_DECISION_GATE_ENFORCE", "true")
    monkeypatch.setenv("HBPE_DECISION_GATE_BRIER_MAX", "0.30")
    monkeypatch.setenv("HBPE_DECISION_GATE_ECE_MAX", "0.05")
    monkeypatch.setenv("HBPE_DECISION_GATE_ACCURACY_MARGIN", "0.10")
    monkeypatch.setenv("HBPE_DECISION_GATE_MIN_EVAL", "50")
    s = Settings()
    assert s.decision_gate_file == "/models/decision_gate.json"
    assert s.decision_gate_enforce is True
    assert s.decision_gate_brier_max == 0.30
    assert s.decision_gate_ece_max == 0.05
    assert s.decision_gate_accuracy_margin == 0.10
    assert s.decision_gate_min_eval == 50


@pytest.mark.parametrize("raw", ["0", "false", "False", "no", "off", ""])
def test_gate_enforce_explicit_false_spellings_turn_it_off(monkeypatch, raw):
    monkeypatch.setenv("HBPE_DECISION_GATE_ENFORCE", raw)
    assert Settings().decision_gate_enforce is False


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on"])
def test_gate_enforce_true_spellings_turn_it_on(monkeypatch, raw):
    monkeypatch.setenv("HBPE_DECISION_GATE_ENFORCE", raw)
    assert Settings().decision_gate_enforce is True


@pytest.mark.parametrize("raw", ["maybe", "disabled", "ture"])
def test_gate_enforce_unrecognised_value_turns_enforcement_on(monkeypatch, raw):
    # Fail closed: a typo must not switch the gate off.
    monkeypatch.setenv("HBPE_DECISION_GATE_ENFORCE", raw)
    assert Settings().decision_gate_enforce is True


def test_generic_gate_variable_names_do_not_change_the_gate(monkeypatch):
    # A shared env file may set these names for another service. The gate reads
    # only its HBPE_ names (see the enable_admin_routes note in config.py).
    for name in _GATE_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DECISION_GATE_FILE", "/nonexistent/other-service.json")
    monkeypatch.setenv("DECISION_GATE_ENFORCE", "true")
    monkeypatch.setenv("DECISION_GATE_MIN_EVAL", "1")
    s = Settings()
    assert s.decision_gate_file == ""
    assert s.decision_gate_enforce is False
    assert s.decision_gate_min_eval == 200


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("HBPE_DECISION_GATE_BRIER_MAX", "1.5"),
        ("HBPE_DECISION_GATE_BRIER_MAX", "not a number"),
        ("HBPE_DECISION_GATE_ECE_MAX", "-0.1"),
        # A negative margin would let a model worse than the baseline pass.
        ("HBPE_DECISION_GATE_ACCURACY_MARGIN", "-0.02"),
        ("HBPE_DECISION_GATE_MIN_EVAL", "-1"),
        ("HBPE_DECISION_GATE_MIN_EVAL", "two hundred"),
    ],
)
def test_out_of_range_gate_values_import_and_fail_the_gate(monkeypatch, name, value):
    # A bad value must not stop the service from importing. It fails the gate.
    monkeypatch.setenv(name, value)
    s = Settings()
    result = evaluate_decision_gate(
        PASSING_METRICS, BASELINE, GateThresholds.from_settings(s)
    )
    assert result.passed is False
    assert len(result.reasons) == 1
    assert result.reasons[0].startswith("invalid threshold: ")
