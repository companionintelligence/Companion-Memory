"""Render benchmark results as Markdown or machine-readable JSON.

Two outputs:

- :func:`build_markdown_report` — human-readable comparison table grouped by
  the categories the persona itself declares (no hard-coded list), plus a
  per-question detail section.

- :func:`build_json_report` — same data as plain dicts, ready for assertions in
  tests or diffing across CI runs.

Both functions take the persona + the list of :class:`SystemResult` only — they
never re-execute anything, so a saved JSON report can be re-rendered as Markdown
without re-running the benchmark.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .aggregation import (
    AggregatedSystemResult,
    aggregate_runs,
    aggregated_questions,
    aggregated_to_json,
)
from .schema import SystemResult
from .stats import describe

# A "results" argument is either a list of SystemResult (single-run, the
# legacy shape we MUST keep byte-identical) or a list-of-lists of SystemResult
# (multi-run, one inner list per adapter). The reporter detects which shape
# it has by peeking at the first non-empty element.
ResultsArg = Sequence[SystemResult] | Sequence[Sequence[SystemResult]]


def _is_multi_run(results: ResultsArg) -> bool:
    """Detect the multi-run shape (list-of-lists) without importing anything.

    We check the first element only — mixing shapes inside a single call is
    a programming error the caller is responsible for avoiding, and exploding
    on it here would be louder than silently treating it as single-run.
    """
    for r in results:
        return isinstance(r, (list, tuple))
    return False


def _ordered_categories(persona: dict[str, Any]) -> list[str]:
    """Preserve first-seen order so new categories appear without code edits."""
    seen: list[str] = []
    for q in persona.get("eval_questions", []):
        cat = q.get("category")
        if cat and cat not in seen:
            seen.append(cat)
    return seen


def _fmt_score(hit: int, total: int) -> str:
    return f"{hit}/{total}" if total else "—"


def build_markdown_report(
    persona: dict[str, Any],
    results: ResultsArg,
    *,
    scorer_label: str = "keyword",
    include_question_detail: bool = True,
) -> str:
    if _is_multi_run(results):
        return _build_markdown_multirun(
            persona,
            results,
            scorer_label=scorer_label,
            include_question_detail=include_question_detail,
        )
    p = persona
    categories = _ordered_categories(p)

    scoring_desc = {
        "keyword": "keyword match (hit if ≥1 keyword found in retrieved context)",
        "llm": "LLM judge (hit if retrieved context supports the gold answer)",
    }.get(scorer_label, scorer_label)

    lines: list[str] = [
        f"# Memory System Benchmark — {p.get('name', p.get('persona_id', '?'))}",
        "",
        f"> Persona: **{p.get('name', '?')}** — {p.get('description', '')}  ",
        f"> Questions: {len(p.get('eval_questions', []))} across {len(categories)} categories  ",
        f"> Scoring: {scoring_desc}  ",
        "",
        "## Overall Scores",
        "",
    ]
    headers = ["System", "Score", *categories, "Ingest", "Flush", "Avg search"]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("|" + "|".join(["---"] * len(headers)) + "|")

    for r in results:
        if r.error:
            cells = [r.system_name, "ERROR"] + ["—"] * len(categories) + ["—", "—", "—"]
            lines.append("| " + " | ".join(cells) + f" | _{r.error}_")
            continue
        cat_cells = [_fmt_score(*r.score_for_category(c)) for c in categories]
        lines.append(
            "| "
            + " | ".join(
                [
                    r.system_name,
                    f"{r.questions_answered}/{r.total_questions} ({r.overall_score:.0%})",
                    *cat_cells,
                    f"{r.ingest_total_ms:.0f} ms",
                    f"{r.flush_total_ms:.0f} ms",
                    f"{r.avg_search_latency_ms:.0f} ms",
                ]
            )
            + " |"
        )

    if include_question_detail:
        lines += ["", "## Per-question detail", ""]
        for r in results:
            if r.error:
                continue
            lines += [f"### {r.system_name}", ""]
            lines += [
                "| Q | Category | Hit | Latency | Reason |",
                "|---|---|---|---|---|",
            ]
            for q in r.question_results:
                reason = (q.reason or "").replace("\n", " ").replace("|", "\\|")
                lines.append(
                    f"| {q.question_id} | {q.category} | {'✓' if q.hit else '✗'} | "
                    f"{q.latency_ms:.0f} ms | {reason} |"
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def build_json_report(persona: dict[str, Any], results: ResultsArg) -> dict[str, Any]:
    if _is_multi_run(results):
        return _build_json_multirun(persona, results)
    categories = _ordered_categories(persona)
    return {
        "persona": {
            "id": persona.get("persona_id"),
            "name": persona.get("name"),
            "questions": len(persona.get("eval_questions", [])),
            "categories": categories,
        },
        "systems": [
            {
                "name": r.system_name,
                "error": r.error or None,
                "score": {
                    "hit": r.questions_answered,
                    "total": r.total_questions,
                    "ratio": r.overall_score,
                },
                "categories": {c: list(r.score_for_category(c)) for c in categories},
                "timings_ms": {
                    "ingest_total": r.ingest_total_ms,
                    "flush_total": r.flush_total_ms,
                    "avg_search": r.avg_search_latency_ms,
                },
                "questions": [
                    {
                        "id": q.question_id,
                        "category": q.category,
                        "hit": q.hit,
                        "latency_ms": q.latency_ms,
                        "reason": q.reason,
                    }
                    for q in r.question_results
                ],
            }
            for r in results
        ],
    }


# ---------------------------------------------------------------------------
# Multi-run helpers
# ---------------------------------------------------------------------------


def _build_json_multirun(
    persona: dict[str, Any],
    results: Sequence[Sequence[SystemResult]],
) -> dict[str, Any]:
    """Emit the multi-run JSON shape locked by the orchestrator.

    The persona block is identical to the single-run shape; only the
    ``systems`` entries grow extra fields. See ``aggregation.py`` for the
    exact contract.
    """
    categories = _ordered_categories(persona)
    systems: list[dict[str, Any]] = []
    for runs in results:
        if not runs:
            continue
        agg = aggregate_runs(runs, categories=categories)
        systems.append(aggregated_to_json(agg, categories=categories))
    return {
        "persona": {
            "id": persona.get("persona_id"),
            "name": persona.get("name"),
            "questions": len(persona.get("eval_questions", [])),
            "categories": categories,
        },
        "systems": systems,
    }


def _fmt_pp(ratio: float) -> str:
    """Render a [0, 1] ratio as a "Npp" (percentage-points) string for IQR.

    Used by the multi-run markdown header — "65% ±5pp" reads as "65 percent
    with a 5 percentage-point inter-quartile range" without confusing
    percent-OF-percent units.
    """
    return f"{ratio * 100:.0f}pp"


def _build_markdown_multirun(
    persona: dict[str, Any],
    results: Sequence[Sequence[SystemResult]],
    *,
    scorer_label: str,
    include_question_detail: bool,
) -> str:
    """Multi-run markdown table.

    The overall-score column shows "median% ±IQRpp"; the trailing "Runs OK"
    column shows how many of the attempted runs actually produced data, and
    any failures are named underneath the table. Without that column a system
    that fell over in four runs out of five renders as whatever the surviving
    run scored, with nothing on the page to say so.

    Category cells and the per-question detail pool every completed run, so
    they agree with the JSON rather than reporting run 0 alone.
    """
    p = persona
    categories = _ordered_categories(p)

    scoring_desc = {
        "keyword": "keyword match (hit if ≥1 keyword found in retrieved context)",
        "llm": "LLM judge (hit if retrieved context supports the gold answer)",
    }.get(scorer_label, scorer_label)

    # Use the run count from the first non-empty system; if every system is
    # empty the report degenerates to "no data" rather than crashing.
    n_runs = next((len(rs) for rs in results if rs), 0)

    lines: list[str] = [
        f"# Memory System Benchmark — {p.get('name', p.get('persona_id', '?'))}",
        "",
        f"> Persona: **{p.get('name', '?')}** — {p.get('description', '')}  ",
        f"> Questions: {len(p.get('eval_questions', []))} across {len(categories)} categories  ",
        f"> Scoring: {scoring_desc}  ",
        f"> Runs per system: **{n_runs}** (overall column shows median ± IQR)  ",
        "",
        "## Overall Scores",
        "",
    ]
    headers = [
        "System",
        "Score",
        *categories,
        "Ingest",
        "Flush",
        "Avg search",
        "Runs OK",
    ]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("|" + "|".join(["---"] * len(headers)) + "|")

    aggregates: list[AggregatedSystemResult] = []
    for runs in results:
        if not runs:
            continue
        agg = aggregate_runs(runs, categories=categories)
        aggregates.append(agg)
        runs_cell = f"{agg.n_ok}/{agg.n_runs}"
        if agg.all_errored:
            cells = (
                [agg.representative.system_name, "ERROR"]
                + ["—"] * len(categories)
                + ["—", "—", "—", runs_cell]
            )
            lines.append("| " + " | ".join(cells) + f" | _{agg.representative.error}_")
            continue
        overall = describe(agg.overall_ratios)
        ingest = describe(agg.ingest_ms)
        flush = describe(agg.flush_ms)
        search = describe(agg.search_ms)
        cat_cells = [_fmt_score(*agg.score_for_category(c)) for c in categories]
        lines.append(
            "| "
            + " | ".join(
                [
                    agg.representative.system_name,
                    f"{overall['median']:.0%} ±{_fmt_pp(overall['iqr'])} (median ±IQR)",
                    *cat_cells,
                    f"{ingest['median']:.0f} ms",
                    f"{flush['median']:.0f} ms",
                    f"{search['median']:.0f} ms",
                    runs_cell,
                ]
            )
            + " |"
        )

    # Name every run that fell over. These runs are excluded from the medians
    # above, so this is the only place their existence is visible.
    partial = [a for a in aggregates if a.n_errored and not a.all_errored]
    if partial:
        lines += ["", "**Failed runs (excluded from the statistics above)**", ""]
        for agg in partial:
            for i, run in enumerate(agg.errored_runs, start=1):
                lines.append(
                    f"- {agg.representative.system_name} — failure {i} of "
                    f"{agg.n_errored}: {run.error}"
                )

    if include_question_detail:
        lines += ["", "## Per-question detail", ""]
        for agg in aggregates:
            if agg.all_errored:
                continue
            lines += [f"### {agg.representative.system_name}", ""]
            lines += [
                "| Q | Category | Hits | Median latency | Reason |",
                "|---|---|---|---|---|",
            ]
            for q in aggregated_questions(agg):
                reason = (q["reason"] or "").replace("\n", " ").replace("|", "\\|")
                lines.append(
                    f"| {q['id']} | {q['category']} | {q['hits']}/{q['runs']} | "
                    f"{q['latency_ms']:.0f} ms | {reason} |"
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"
