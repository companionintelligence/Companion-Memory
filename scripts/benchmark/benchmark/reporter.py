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

from typing import Any, Dict, List, Sequence

from .schema import SystemResult


def _ordered_categories(persona: Dict[str, Any]) -> List[str]:
    """Preserve first-seen order so new categories appear without code edits."""
    seen: List[str] = []
    for q in persona.get("eval_questions", []):
        cat = q.get("category")
        if cat and cat not in seen:
            seen.append(cat)
    return seen


def _fmt_score(hit: int, total: int) -> str:
    return f"{hit}/{total}" if total else "—"


def build_markdown_report(
    persona: Dict[str, Any],
    results: Sequence[SystemResult],
    *,
    scorer_label: str = "keyword",
    include_question_detail: bool = True,
) -> str:
    p = persona
    categories = _ordered_categories(p)

    scoring_desc = {
        "keyword": "keyword match (hit if ≥1 keyword found in retrieved context)",
        "llm": "LLM judge (hit if retrieved context supports the gold answer)",
    }.get(scorer_label, scorer_label)

    lines: List[str] = [
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
            lines += ["| Q | Category | Hit | Latency | Reason |", "|---|---|---|---|---|"]
            for q in r.question_results:
                reason = (q.reason or "").replace("\n", " ").replace("|", "\\|")
                lines.append(
                    f"| {q.question_id} | {q.category} | {'✓' if q.hit else '✗'} | "
                    f"{q.latency_ms:.0f} ms | {reason} |"
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def build_json_report(persona: Dict[str, Any], results: Sequence[SystemResult]) -> Dict[str, Any]:
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
