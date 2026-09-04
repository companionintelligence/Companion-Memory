"""Aggregate a list of per-run :class:`SystemResult` into report-shaped dicts.

The orchestrator has locked the multi-run JSON contract — see the top of this
module for the exact shape we must emit. This module is the single place that
contract is materialised so the reporter doesn't have to know about
:mod:`statistics` or about run-0 being the "representative" run.

JSON contract (mirrored from the orchestrator brief, kept here so the test
suite and the reporter agree on a single source of truth):

* ``runs`` — int, count of runs included
* ``score`` — dict ``{hit, total, ratio, median, mean, min, max, iqr, stddev}``
  where ratio-shaped fields are floats in ``[0, 1]``
* ``categories[c]`` — ``[hit, total]`` from run 0 only (unchanged across modes)
* ``category_stats[c]`` — ``{median, mean, min, max, iqr, stddev}`` of the
  per-run hit ratio for category ``c``
* ``timings_ms.{ingest,flush,search}`` — each ``{median, mean, min, max, iqr,
  stddev}`` over the runs
* ``questions`` — from run 0 only (unchanged)
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .schema import SystemResult
from .stats import describe


@dataclass
class AggregatedSystemResult:
    """In-memory container for an N-run aggregation of one adapter.

    Kept as a dataclass (not a dict) so the reporter has a typed surface and
    static checkers can catch missing fields. The ``to_dict`` method is what
    flows into the JSON report.

    ``representative`` is always run 0 — the orchestrator's JSON contract
    pins category cells and the questions list to "from run 0", so we expose
    that single :class:`SystemResult` instead of re-deriving it everywhere.
    """

    representative: SystemResult
    runs: list[SystemResult]
    overall_ratios: list[float]
    category_ratios: dict[str, list[float]]
    ingest_ms: list[float]
    flush_ms: list[float]
    search_ms: list[float]

    @property
    def n_runs(self) -> int:
        return len(self.runs)


def _category_ratios(
    runs: Sequence[SystemResult], categories: Sequence[str]
) -> dict[str, list[float]]:
    """Per-category hit-ratio across runs.

    A category with zero questions in a given run contributes ``0.0`` so the
    list length always matches ``len(runs)`` — that keeps the downstream
    :func:`describe` call honest about how many runs it's summarising.
    """
    out: dict[str, list[float]] = {c: [] for c in categories}
    for r in runs:
        for c in categories:
            hit, total = r.score_for_category(c)
            out[c].append(hit / total if total else 0.0)
    return out


def aggregate_runs(
    runs: Sequence[SystemResult],
    *,
    categories: Sequence[str],
) -> AggregatedSystemResult:
    """Collapse a list of per-run results into an :class:`AggregatedSystemResult`.

    Categories are passed in (not derived) so the aggregation respects the
    persona's declared category order even when run 0 happened to miss every
    question in a given category.

    Errored runs (``SystemResult.error`` non-empty) are still included — they
    contribute ``0.0`` to the overall ratio and per-category ratio. That's a
    deliberate "errors count as misses" stance which is consistent with how
    the single-run scorer treats a search that returns no context.
    """
    if not runs:
        raise ValueError("aggregate_runs needs at least one run")

    overall_ratios = [r.overall_score for r in runs]
    cat_ratios = _category_ratios(runs, categories)
    ingest_ms = [r.ingest_total_ms for r in runs]
    flush_ms = [r.flush_total_ms for r in runs]
    search_ms = [r.avg_search_latency_ms for r in runs]

    return AggregatedSystemResult(
        representative=runs[0],
        runs=list(runs),
        overall_ratios=overall_ratios,
        category_ratios=cat_ratios,
        ingest_ms=ingest_ms,
        flush_ms=flush_ms,
        search_ms=search_ms,
    )


def aggregated_to_json(
    agg: AggregatedSystemResult,
    *,
    categories: Sequence[str],
) -> dict[str, Any]:
    """Render an :class:`AggregatedSystemResult` as a JSON-ready dict.

    This is the multi-run system entry in :func:`build_json_report` — the
    reporter just wraps it with the persona block and the ``systems`` array.
    """
    rep = agg.representative
    overall_stats = describe(agg.overall_ratios)
    score: dict[str, Any] = {
        "hit": rep.questions_answered,
        "total": rep.total_questions,
        "ratio": rep.overall_score,
    }
    # ``describe`` returns {} only for empty input; we know n_runs >= 1 here.
    for k in ("median", "mean", "min", "max", "iqr", "stddev"):
        score[k] = overall_stats.get(k, 0.0)

    return {
        "name": rep.system_name,
        "error": rep.error or None,
        "runs": agg.n_runs,
        "score": score,
        "categories": {c: list(rep.score_for_category(c)) for c in categories},
        "category_stats": {
            c: {
                k: describe(agg.category_ratios[c]).get(k, 0.0)
                for k in ("median", "mean", "min", "max", "iqr", "stddev")
            }
            for c in categories
        },
        "timings_ms": {
            "ingest": {
                k: describe(agg.ingest_ms).get(k, 0.0)
                for k in ("median", "mean", "min", "max", "iqr", "stddev")
            },
            "flush": {
                k: describe(agg.flush_ms).get(k, 0.0)
                for k in ("median", "mean", "min", "max", "iqr", "stddev")
            },
            "search": {
                k: describe(agg.search_ms).get(k, 0.0)
                for k in ("median", "mean", "min", "max", "iqr", "stddev")
            },
        },
        "questions": [
            {
                "id": q.question_id,
                "category": q.category,
                "hit": q.hit,
                "latency_ms": q.latency_ms,
                "reason": q.reason,
            }
            for q in rep.question_results
        ],
    }
