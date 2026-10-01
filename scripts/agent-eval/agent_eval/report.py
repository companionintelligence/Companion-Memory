"""Write a report that keeps each metric on its own line.

A single pass rate would hide a model that answers well and calls the
wrong tool. The markdown lists every metric, then the failing checks.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from .runner import CaseRun

METRICS = (
    "tool_selection",
    "tool_avoidance",
    "tool_arguments",
    "retrieval",
    "answer",
    "hallucination",
    "run",
)


def summarize(runs: list[CaseRun]) -> dict:
    by_metric: dict[str, dict[str, int]] = {
        metric: {"passed": 0, "failed": 0} for metric in METRICS
    }
    by_capability: dict[str, dict[str, int]] = defaultdict(
        lambda: {"passed_cases": 0, "failed_cases": 0, "skipped": 0}
    )
    cases: list[dict] = []
    for run in runs:
        bucket = by_capability[run.case.capability]
        if run.skipped:
            bucket["skipped"] += 1
        elif run.failed():
            bucket["failed_cases"] += 1
        else:
            bucket["passed_cases"] += 1
        for check in run.checks:
            slot = by_metric.setdefault(check.metric, {"passed": 0, "failed": 0})
            slot["passed" if check.passed else "failed"] += 1
        cases.append(
            {
                "id": run.case.id,
                "capability": run.case.capability,
                "title": run.case.title,
                "skipped": run.skipped,
                "thread_id": run.trace.thread_id,
                "error": run.trace.error,
                "checks": [check.to_dict() for check in run.checks],
                "trace": run.trace.to_dict(),
            }
        )
    return {
        "metrics": by_metric,
        "capabilities": dict(by_capability),
        "cases": cases,
    }


def render_markdown(summary: dict) -> str:
    lines = ["# Chat agent eval", ""]
    lines.append("## Metrics")
    lines.append("")
    lines.append("| Metric | Passed | Failed |")
    lines.append("| --- | ---: | ---: |")
    for metric, counts in summary["metrics"].items():
        if counts["passed"] == 0 and counts["failed"] == 0:
            continue
        lines.append(f"| {metric} | {counts['passed']} | {counts['failed']} |")
    lines.append("")
    lines.append("## Capabilities")
    lines.append("")
    lines.append("| Capability | Passed | Failed | Skipped |")
    lines.append("| --- | ---: | ---: | ---: |")
    for capability, counts in sorted(summary["capabilities"].items()):
        lines.append(
            f"| {capability} | {counts['passed_cases']} | "
            f"{counts['failed_cases']} | {counts['skipped']} |"
        )
    lines.append("")
    failures = [
        case
        for case in summary["cases"]
        if any(not check["passed"] for check in case["checks"]) or case["error"]
    ]
    lines.append("## Failures")
    lines.append("")
    if not failures:
        lines.append("No failing checks.")
    for case in failures:
        lines.append(f"### {case['id']}")
        lines.append("")
        if case["error"]:
            lines.append(f"Run error: {case['error']}")
            lines.append("")
        for check in case["checks"]:
            if check["passed"]:
                continue
            turn = (
                ""
                if check["turn_index"] is None
                else f"turn {check['turn_index'] + 1}: "
            )
            lines.append(f"- {check['metric']}: {turn}{check['detail']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_report(summary: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_markdown(summary), encoding="utf-8")
    path.with_suffix(".json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
