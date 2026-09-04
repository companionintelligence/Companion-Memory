"""Aggregate a list of per-run :class:`SystemResult` into report-shaped dicts.

This module is the single place the multi-run JSON contract is materialised,
so the reporter doesn't have to know about :mod:`statistics`.

Two rules govern everything here, and they exist because breaking either one
produces a report that reads clean while describing a broken system:

1. **No single run speaks for the set.** Scores, category cells and
   per-question outcomes pool *every* run that completed. An earlier revision
   pinned all of them to run 0, so a system that failed in four runs out of
   five reported run 0's numbers and nothing else.
2. **An errored run is not a zero.** A run that never produced an answer has
   no score and no timing to contribute, so it is excluded from every
   statistic and counted separately instead. Folding it in as ``0.0`` both
   understates latency (a crash is fast) and fabricates variance between a
   real score and a phantom zero.

JSON contract:

* ``runs`` — int, runs attempted (i.e. ``--runs N``)
* ``runs_ok`` / ``runs_errored`` — int, how that split
* ``errors`` — list of the error strings from the errored runs, in run order
* ``error`` — set only when **every** run errored; ``None`` otherwise. A
  partially-failing system still has data, so it is not an "errored system";
  ``runs_errored`` is where that shows up.
* ``score`` — ``{hit, total, ratio, median, mean, min, max, iqr, stddev}``.
  ``hit``/``total`` pool the completed runs (so ``ratio`` is the pooled hit
  rate); the remaining fields describe the distribution of the per-run ratios.
* ``categories[c]`` — ``[hit, total]`` pooled across the completed runs
* ``category_stats[c]`` — ``{median, mean, min, max, iqr, stddev}`` of the
  per-run hit ratio for category ``c``
* ``timings_ms.{ingest,flush,search}`` — each ``{median, mean, min, max, iqr,
  stddev}`` over the completed runs
* ``questions[]`` — ``{id, category, hits, runs, hit_ratio, latency_ms,
  reason}`` where ``hits`` counts the completed runs in which the question was
  answered and ``latency_ms`` is the median across them
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .schema import SystemResult
from .stats import describe, median

_STAT_KEYS = ("median", "mean", "min", "max", "iqr", "stddev")


def _stats(xs: Sequence[float]) -> dict[str, float]:
    """``describe`` narrowed to the locked key set, zero-filled when empty."""
    d = describe(xs)
    return {k: d.get(k, 0.0) for k in _STAT_KEYS}


@dataclass
class AggregatedSystemResult:
    """In-memory container for an N-run aggregation of one adapter.

    Kept as a dataclass (not a dict) so the reporter has a typed surface and
    static checkers can catch missing fields; :func:`aggregated_to_json` turns
    it into the JSON report entry.

    ``runs`` holds every attempted run in order; ``ok_runs`` holds the subset
    that produced results. Every statistics list on this object is derived
    from ``ok_runs`` alone — see the module docstring for why.

    ``representative`` is the first run that completed, used only for the
    things that are genuinely per-run rather than aggregate: the system name
    and the question ordering. When every run errored it falls back to
    ``runs[0]`` so callers always have a name to print.
    """

    representative: SystemResult
    runs: list[SystemResult]
    ok_runs: list[SystemResult]
    errored_runs: list[SystemResult]
    overall_ratios: list[float]
    category_ratios: dict[str, list[float]]
    ingest_ms: list[float]
    flush_ms: list[float]
    search_ms: list[float]

    @property
    def n_runs(self) -> int:
        return len(self.runs)

    @property
    def n_ok(self) -> int:
        return len(self.ok_runs)

    @property
    def n_errored(self) -> int:
        return len(self.errored_runs)

    @property
    def all_errored(self) -> bool:
        return not self.ok_runs

    @property
    def errors(self) -> list[str]:
        """Error strings from the failed runs, in run order."""
        return [r.error for r in self.errored_runs]

    def score_for_category(self, category: str) -> tuple[int, int]:
        """Pooled ``(hit, total)`` for ``category`` across the completed runs."""
        hit = total = 0
        for r in self.ok_runs:
            h, t = r.score_for_category(category)
            hit += h
            total += t
        return hit, total

    @property
    def questions_answered(self) -> int:
        return sum(r.questions_answered for r in self.ok_runs)

    @property
    def total_questions(self) -> int:
        return sum(r.total_questions for r in self.ok_runs)

    @property
    def overall_ratio(self) -> float:
        total = self.total_questions
        return self.questions_answered / total if total else 0.0


def _category_ratios(
    runs: Sequence[SystemResult], categories: Sequence[str]
) -> dict[str, list[float]]:
    """Per-category hit-ratio across the runs given.

    A run in which the category has no questions contributes no sample rather
    than a ``0.0`` — "the persona asked nothing here" is not "the system got
    everything wrong". Since the persona is fixed across runs this only bites
    for a category that is absent everywhere, which then yields an empty list
    and a zero-filled stats block.
    """
    out: dict[str, list[float]] = {c: [] for c in categories}
    for r in runs:
        for c in categories:
            hit, total = r.score_for_category(c)
            if total:
                out[c].append(hit / total)
    return out


def aggregate_runs(
    runs: Sequence[SystemResult],
    *,
    categories: Sequence[str],
) -> AggregatedSystemResult:
    """Collapse a list of per-run results into an :class:`AggregatedSystemResult`.

    Categories are passed in (not derived) so the aggregation respects the
    persona's declared category order even when a run happened to miss every
    question in a given category.

    Runs whose ``SystemResult.error`` is non-empty are partitioned out and
    excluded from every statistic; they survive in ``errored_runs`` so the
    caller can report the count and the messages alongside the numbers.
    """
    if not runs:
        raise ValueError("aggregate_runs needs at least one run")

    ok = [r for r in runs if not r.error]
    bad = [r for r in runs if r.error]

    return AggregatedSystemResult(
        representative=ok[0] if ok else runs[0],
        runs=list(runs),
        ok_runs=ok,
        errored_runs=bad,
        overall_ratios=[r.overall_score for r in ok],
        category_ratios=_category_ratios(ok, categories),
        ingest_ms=[r.ingest_total_ms for r in ok],
        flush_ms=[r.flush_total_ms for r in ok],
        search_ms=[r.avg_search_latency_ms for r in ok],
    )


def aggregated_questions(agg: AggregatedSystemResult) -> list[dict[str, Any]]:
    """Per-question outcomes pooled across the completed runs.

    ``hits``/``runs`` replace the single-run ``hit`` boolean: with N runs
    there is no one boolean to report, and taking run 0's would hide a
    question that is answered a third of the time. Ordering follows the
    first completed run; an id seen only in a later run is appended, which
    shouldn't happen for a fixed persona but costs nothing to tolerate.
    """
    order: list[str] = []
    meta: dict[str, dict[str, Any]] = {}
    hits: dict[str, int] = {}
    latencies: dict[str, list[float]] = {}

    for run in agg.ok_runs:
        for q in run.question_results:
            if q.question_id not in meta:
                order.append(q.question_id)
                meta[q.question_id] = {"category": q.category, "reason": q.reason}
                hits[q.question_id] = 0
                latencies[q.question_id] = []
            hits[q.question_id] += int(q.hit)
            latencies[q.question_id].append(q.latency_ms)

    return [
        {
            "id": qid,
            "category": meta[qid]["category"],
            "hits": hits[qid],
            "runs": len(latencies[qid]),
            "hit_ratio": hits[qid] / len(latencies[qid]) if latencies[qid] else 0.0,
            "latency_ms": median(latencies[qid]),
            "reason": meta[qid]["reason"],
        }
        for qid in order
    ]


def aggregated_to_json(
    agg: AggregatedSystemResult,
    *,
    categories: Sequence[str],
) -> dict[str, Any]:
    """Render an :class:`AggregatedSystemResult` as a JSON-ready dict.

    This is the multi-run system entry in :func:`build_json_report` — the
    reporter just wraps it with the persona block and the ``systems`` array.
    """
    score: dict[str, Any] = {
        "hit": agg.questions_answered,
        "total": agg.total_questions,
        "ratio": agg.overall_ratio,
        **_stats(agg.overall_ratios),
    }

    return {
        "name": agg.representative.system_name,
        # Only a system that never completed a single run is "errored"; a
        # partial failure shows up as runs_errored/errors instead.
        "error": agg.errors[0] if agg.all_errored else None,
        "runs": agg.n_runs,
        "runs_ok": agg.n_ok,
        "runs_errored": agg.n_errored,
        "errors": agg.errors,
        "score": score,
        "categories": {c: list(agg.score_for_category(c)) for c in categories},
        "category_stats": {c: _stats(agg.category_ratios[c]) for c in categories},
        "timings_ms": {
            "ingest": _stats(agg.ingest_ms),
            "flush": _stats(agg.flush_ms),
            "search": _stats(agg.search_ms),
        },
        "questions": aggregated_questions(agg),
    }
