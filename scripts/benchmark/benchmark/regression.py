"""Regression detection — compare a fresh run against a saved baseline.

The benchmark prints reports, but a Markdown table is not a CI gate. This
module compares two JSON reports (produced by :func:`benchmark.build_json_report`)
and flags any score that dropped by more than a tolerance, so the runner can
exit non-zero when a regression sneaks into a PR.

A "score" can move three ways relative to baseline:

- ``regression``   — current ratio < baseline ratio - tolerance
- ``improvement``  — current ratio > baseline ratio + tolerance
- ``stable``       — within ±tolerance

A system that errored in baseline-but-not-current (or vice versa) is reported as
its own kind of change: ``error_introduced`` / ``error_resolved``. A system or
category that exists in one report but not the other is ``missing`` — that
usually means the persona changed and the baseline needs refreshing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RegressionChange:
    """One per-system-per-category line of the comparison."""

    system: str
    category: str  # "overall" for the system-level score
    baseline: float | None  # ratio in [0, 1], or None for missing/error rows
    current: float | None
    delta: float | None  # current - baseline; None if either side missing
    kind: str  # "regression" | "improvement" | "stable"
    #   | "error_introduced" | "error_resolved"
    #   | "missing"

    @property
    def is_failure(self) -> bool:
        """True if this change should fail the CI gate."""
        return self.kind in ("regression", "error_introduced", "missing")


@dataclass
class RegressionReport:
    tolerance: float
    changes: list[RegressionChange] = field(default_factory=list)

    @property
    def failures(self) -> list[RegressionChange]:
        return [c for c in self.changes if c.is_failure]

    @property
    def passed(self) -> bool:
        return not self.failures


def _ratio(hit: int, total: int) -> float | None:
    if not total:
        return None
    return hit / total


def _index_by_name(systems: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {s["name"]: s for s in systems}


def compare(
    baseline: dict[str, Any],
    current: dict[str, Any],
    *,
    tolerance: float = 0.05,
) -> RegressionReport:
    """Compare two JSON reports and return a :class:`RegressionReport`.

    Tolerance is in score-ratio units, e.g. ``0.05`` means "fail if a category
    drops by more than 5 percentage points".
    """
    report = RegressionReport(tolerance=tolerance)
    base_systems = _index_by_name(baseline.get("systems", []))
    cur_systems = _index_by_name(current.get("systems", []))

    # System universe = union; anything in only one side is reported as missing.
    all_systems = sorted(set(base_systems) | set(cur_systems))

    for name in all_systems:
        b = base_systems.get(name)
        c = cur_systems.get(name)

        if b is None or c is None:
            report.changes.append(
                RegressionChange(
                    system=name,
                    category="overall",
                    baseline=None
                    if b is None
                    else _ratio(b["score"]["hit"], b["score"]["total"]),
                    current=None
                    if c is None
                    else _ratio(c["score"]["hit"], c["score"]["total"]),
                    delta=None,
                    kind="missing",
                )
            )
            continue

        # Errors are first-class events, not a -100% regression.
        if b.get("error") and not c.get("error"):
            report.changes.append(
                RegressionChange(
                    system=name,
                    category="overall",
                    baseline=None,
                    current=_ratio(c["score"]["hit"], c["score"]["total"]),
                    delta=None,
                    kind="error_resolved",
                )
            )
            continue
        if c.get("error") and not b.get("error"):
            report.changes.append(
                RegressionChange(
                    system=name,
                    category="overall",
                    baseline=_ratio(b["score"]["hit"], b["score"]["total"]),
                    current=None,
                    delta=None,
                    kind="error_introduced",
                )
            )
            continue
        if c.get("error") and b.get("error"):
            # Both errored — uninteresting for the gate; record as stable.
            report.changes.append(
                RegressionChange(
                    system=name,
                    category="overall",
                    baseline=None,
                    current=None,
                    delta=None,
                    kind="stable",
                )
            )
            continue

        # Overall.
        br = _ratio(b["score"]["hit"], b["score"]["total"])
        cr = _ratio(c["score"]["hit"], c["score"]["total"])
        report.changes.append(_classify(name, "overall", br, cr, tolerance))

        # Per-category (intersection — categories that exist in both reports).
        cats = sorted(set(b.get("categories", {})) & set(c.get("categories", {})))
        for cat in cats:
            bh, bt = b["categories"][cat]
            ch, ct = c["categories"][cat]
            report.changes.append(
                _classify(name, cat, _ratio(bh, bt), _ratio(ch, ct), tolerance)
            )

    return report


def _classify(
    system: str,
    category: str,
    baseline: float | None,
    current: float | None,
    tolerance: float,
) -> RegressionChange:
    if baseline is None or current is None:
        return RegressionChange(
            system=system,
            category=category,
            baseline=baseline,
            current=current,
            delta=None,
            kind="missing",
        )
    delta = current - baseline
    if delta < -tolerance:
        kind = "regression"
    elif delta > tolerance:
        kind = "improvement"
    else:
        kind = "stable"
    return RegressionChange(
        system=system,
        category=category,
        baseline=baseline,
        current=current,
        delta=delta,
        kind=kind,
    )


# ---------------------------------------------------------------------------
# Human-readable summary
# ---------------------------------------------------------------------------


def format_summary(report: RegressionReport) -> str:
    lines: list[str] = [f"## Regression report (tolerance ±{report.tolerance:.0%})", ""]
    if not report.changes:
        return "## Regression report\n\n(no systems compared)\n"

    # Always lead with failures.
    fails = report.failures
    if fails:
        lines += ["**Failures**", ""]
        for c in fails:
            lines.append(f"- {_format_change(c)}")
        lines.append("")
    else:
        lines += ["All categories within tolerance. ✅", ""]

    others = [c for c in report.changes if c not in fails]
    if others:
        lines += ["**Other changes**", ""]
        for c in others:
            lines.append(f"- {_format_change(c)}")
    return "\n".join(lines).rstrip() + "\n"


def _format_change(c: RegressionChange) -> str:
    def _pct(x: float | None) -> str:
        return f"{x:.0%}" if x is not None else "—"

    delta = f" Δ {c.delta:+.0%}" if c.delta is not None else ""
    return (
        f"[{c.kind}] {c.system} / {c.category}: "
        f"{_pct(c.baseline)} → {_pct(c.current)}{delta}"
    )
