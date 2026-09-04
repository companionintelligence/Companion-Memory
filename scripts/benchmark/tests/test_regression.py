"""Regression detection — comparing two JSON reports.

The dataclasses match what :func:`benchmark.build_json_report` produces, so
these tests double-check the contract too.
"""

from __future__ import annotations

from typing import Any

from benchmark.regression import compare, format_summary


def _system(
    name: str,
    hit: int,
    total: int,
    cats: dict[str, list] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "error": error,
        "score": {"hit": hit, "total": total, "ratio": (hit / total) if total else 0.0},
        "categories": dict(cats or {}),
        "timings_ms": {"ingest_total": 0, "flush_total": 0, "avg_search": 0},
        "questions": [],
    }


def _report(systems: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "persona": {"id": "p", "name": "P", "questions": 0, "categories": []},
        "systems": systems,
    }


# ── overall + per-category classification ────────────────────────────────────


def test_within_tolerance_is_stable_and_passes():
    base = _report([_system("ci_server", 10, 20, {"flat-recall": [5, 10]})])
    cur = _report([_system("ci_server", 11, 20, {"flat-recall": [6, 10]})])
    r = compare(base, cur, tolerance=0.10)
    kinds = {(c.system, c.category): c.kind for c in r.changes}
    assert kinds[("ci_server", "overall")] == "stable"
    assert kinds[("ci_server", "flat-recall")] == "stable"
    assert r.passed


def test_drop_beyond_tolerance_is_a_regression_and_fails_the_gate():
    base = _report([_system("ci_server", 20, 20)])
    cur = _report([_system("ci_server", 15, 20)])
    r = compare(base, cur, tolerance=0.05)
    overall = next(c for c in r.changes if c.category == "overall")
    assert overall.kind == "regression"
    assert overall.delta == -0.25
    assert not r.passed
    assert overall in r.failures


def test_gain_beyond_tolerance_is_an_improvement_and_does_not_fail():
    base = _report([_system("ci_server", 10, 20)])
    cur = _report([_system("ci_server", 18, 20)])
    r = compare(base, cur, tolerance=0.05)
    overall = next(c for c in r.changes if c.category == "overall")
    assert overall.kind == "improvement"
    assert r.passed


def test_only_categories_present_in_both_reports_are_compared():
    base = _report(
        [_system("ci_server", 5, 10, {"flat-recall": [3, 5], "temporal": [2, 5]})]
    )
    cur = _report(
        [_system("ci_server", 5, 10, {"flat-recall": [3, 5], "new-cat": [2, 5]})]
    )
    r = compare(base, cur)
    cats = {c.category for c in r.changes if c.system == "ci_server"}
    assert "flat-recall" in cats
    assert "temporal" not in cats and "new-cat" not in cats


# ── error transitions ───────────────────────────────────────────────────────


def test_error_introduced_fails_the_gate():
    base = _report([_system("ci_server", 12, 20)])
    cur = _report([_system("ci_server", 0, 0, error="ingest failed: boom")])
    r = compare(base, cur)
    overall = next(c for c in r.changes if c.system == "ci_server")
    assert overall.kind == "error_introduced"
    assert not r.passed


def test_error_resolved_is_a_clean_change_that_does_not_fail():
    base = _report([_system("ci_server", 0, 0, error="ingest failed: boom")])
    cur = _report([_system("ci_server", 12, 20)])
    r = compare(base, cur)
    overall = next(c for c in r.changes if c.system == "ci_server")
    assert overall.kind == "error_resolved"
    assert r.passed


def test_both_errored_is_stable_not_a_failure():
    base = _report([_system("ci_server", 0, 0, error="boom")])
    cur = _report([_system("ci_server", 0, 0, error="boom again")])
    r = compare(base, cur)
    assert r.passed
    assert r.changes[0].kind == "stable"


# ── missing systems ─────────────────────────────────────────────────────────


def test_missing_system_in_current_fails_the_gate():
    base = _report([_system("ci_server", 10, 20), _system("naive", 5, 20)])
    cur = _report([_system("ci_server", 10, 20)])
    r = compare(base, cur)
    missing = next(c for c in r.changes if c.system == "naive")
    assert missing.kind == "missing"
    assert not r.passed


def test_missing_system_in_baseline_also_fails_so_you_refresh_the_baseline():
    base = _report([_system("ci_server", 10, 20)])
    cur = _report([_system("ci_server", 10, 20), _system("mem0", 6, 20)])
    r = compare(base, cur)
    missing = next(c for c in r.changes if c.system == "mem0")
    assert missing.kind == "missing"
    assert not r.passed


# ── tolerance is per-category, not global ────────────────────────────────────


def test_one_category_regression_under_a_stable_overall_still_fails():
    base = _report(
        [_system("ci_server", 10, 20, {"flat-recall": [9, 10], "absence": [1, 10]})]
    )
    cur = _report(
        [_system("ci_server", 10, 20, {"flat-recall": [3, 10], "absence": [7, 10]})]
    )
    r = compare(base, cur, tolerance=0.05)
    flat = next(c for c in r.changes if c.category == "flat-recall")
    overall = next(c for c in r.changes if c.category == "overall")
    assert flat.kind == "regression" and overall.kind == "stable"
    assert not r.passed


# ── summary ─────────────────────────────────────────────────────────────────


def test_summary_lists_failures_with_pct_deltas():
    base = _report([_system("ci_server", 20, 20)])
    cur = _report([_system("ci_server", 14, 20)])
    text = format_summary(compare(base, cur, tolerance=0.05))
    assert "regression" in text
    assert "ci_server" in text
    assert "-30%" in text  # 70% - 100% = -30pp


def test_summary_announces_pass_when_within_tolerance():
    base = _report([_system("ci_server", 10, 20)])
    cur = _report([_system("ci_server", 10, 20)])
    text = format_summary(compare(base, cur))
    assert "within tolerance" in text
