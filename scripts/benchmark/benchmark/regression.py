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
usually means the persona changed and the baseline needs refreshing. A system
with more failed runs than its baseline is ``runs_errored``, also a failure:
a system that fell over in four runs out of five has not passed, however good
the run that survived looked.

Multi-run reports (``--runs N``) carry a ``median`` alongside ``hit``/``total``.
The gate compares the **median** whenever one is present, so ``--runs N``
actually changes the pass/fail decision instead of only decorating the report.
Single-run reports have no median and fall back to ``hit``/``total``, so old
baselines keep working unchanged.
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
    #   | "error_introduced" | "error_resolved" | "runs_errored"
    #   | "missing"

    @property
    def is_failure(self) -> bool:
        """True if this change should fail the CI gate."""
        return self.kind in (
            "regression",
            "error_introduced",
            "runs_errored",
            "missing",
        )


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


def _overall_ratio(system: dict[str, Any]) -> float | None:
    """The system's headline score, as the gate should read it.

    Multi-run reports get their ``score.median`` — the statistic the report
    itself headlines, and the one that is robust to a single lucky run.
    Single-run reports have no median, so this is ``hit/total`` for them.
    ``None`` means "no data", which the caller renders as ``missing``.
    """
    score = system.get("score") or {}
    if not score.get("total"):
        return None
    if "median" in score:
        return float(score["median"])
    return _ratio(int(score["hit"]), int(score["total"]))


def _category_ratio(system: dict[str, Any], category: str) -> float | None:
    """One category's score, preferring the multi-run median (see above).

    The ``[hit, total]`` cell is still consulted first: a category with no
    questions at all has a zero denominator and must read as "no data", not
    as a 0% median.
    """
    cell = (system.get("categories") or {}).get(category)
    if not cell or not cell[1]:
        return None
    stats = (system.get("category_stats") or {}).get(category) or {}
    if "median" in stats:
        return float(stats["median"])
    return _ratio(int(cell[0]), int(cell[1]))


def _errored_runs(system: dict[str, Any]) -> int:
    """Failed-run count; 0 for single-run reports, which have no such field."""
    return int(system.get("runs_errored") or 0)


def _errored_fraction(system: dict[str, Any]) -> float:
    total = int(system.get("runs") or 0)
    return _errored_runs(system) / total if total else 0.0


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
                    baseline=None if b is None else _overall_ratio(b),
                    current=None if c is None else _overall_ratio(c),
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
                    current=_overall_ratio(c),
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
                    baseline=_overall_ratio(b),
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
        report.changes.append(
            _classify(name, "overall", _overall_ratio(b), _overall_ratio(c), tolerance)
        )

        # Runs that fell over. A partially-failing system still has a score,
        # so this is a separate row rather than a replacement for the one
        # above — but it fails the gate on its own.
        if _errored_runs(c) > _errored_runs(b):
            report.changes.append(
                RegressionChange(
                    system=name,
                    category="runs",
                    baseline=_errored_fraction(b),
                    current=_errored_fraction(c),
                    delta=_errored_fraction(c) - _errored_fraction(b),
                    kind="runs_errored",
                )
            )

        # Per-category (intersection — categories that exist in both reports).
        cats = sorted(set(b.get("categories", {})) & set(c.get("categories", {})))
        for cat in cats:
            report.changes.append(
                _classify(
                    name,
                    cat,
                    _category_ratio(b, cat),
                    _category_ratio(c, cat),
                    tolerance,
                )
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

    if c.kind == "runs_errored":
        # These two percentages are failed-run shares, not scores, and the
        # arrow points the wrong way round for a reader skimming the list.
        return (
            f"[{c.kind}] {c.system}: {_pct(c.current)} of runs failed "
            f"(baseline {_pct(c.baseline)})"
        )
    delta = f" Δ {c.delta:+.0%}" if c.delta is not None else ""
    return (
        f"[{c.kind}] {c.system} / {c.category}: "
        f"{_pct(c.baseline)} → {_pct(c.current)}{delta}"
    )
