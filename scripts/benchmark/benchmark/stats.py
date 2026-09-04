"""Pure stat helpers for the multi-run aggregation.

The reporter and aggregation layers need a tiny, well-defined surface for
descriptive statistics. We intentionally do NOT pull in numpy/scipy — the
benchmark must run on a stock CPython interpreter (CI lane image, dev laptops)
without a heavy dependency. The stdlib :mod:`statistics` module is sufficient.

Every helper:

* accepts ``Sequence[float | int]`` and returns ``float`` (or a plain ``dict``
  of floats for :func:`describe`),
* treats an empty input as a *neutral* result (``0.0`` / ``{}``) instead of
  raising — multi-run aggregation must survive partially-failing runs where a
  category has no samples, and we'd rather emit a zero than crash the report.
* gives a single-element input a stable, well-defined answer (median = mean =
  min = max = that value; iqr = 0.0; stddev = 0.0) so that ``--runs 1`` agrees
  with the single-run path.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence

Number = int | float


def median(xs: Sequence[Number]) -> float:
    """Return the median of ``xs``; ``0.0`` for an empty input.

    Why ``0.0`` for empty? The aggregation layer calls this on per-category
    latency / score lists and we want a "no samples" cell to render as a
    benign zero in the report, not blow up the whole render. The caller
    decides whether to suppress the cell based on the run count, not on an
    exception here.
    """
    if not xs:
        return 0.0
    return float(statistics.median(xs))


def mean(xs: Sequence[Number]) -> float:
    """Arithmetic mean; ``0.0`` for empty (same reasoning as :func:`median`)."""
    if not xs:
        return 0.0
    return float(statistics.fmean(xs))


def iqr(xs: Sequence[Number]) -> float:
    """Interquartile range (Q3 − Q1) using linear interpolation.

    Uses :func:`statistics.quantiles` with ``n=4`` and ``method='exclusive'``
    (the default), which matches Python's reference behaviour and the
    documented contract in the JSON shape.

    Edge cases:

    * empty → ``0.0``
    * single sample → ``0.0`` (statistics.quantiles needs ≥ 2 points; we
      shortcut to keep the function total)
    * two samples → still well-defined under exclusive quantiles
    """
    if len(xs) < 2:
        return 0.0
    qs = statistics.quantiles(xs, n=4)
    return float(qs[2] - qs[0])


def stddev(xs: Sequence[Number]) -> float:
    """Population standard deviation.

    We deliberately use :func:`statistics.pstdev` (population, not sample) so
    a 1-element input returns ``0.0`` instead of raising. Sample stddev is
    undefined for n=1, but the report expects a number; for a benchmark whose
    "population" is "the runs we actually executed", population stddev is the
    honest summary anyway.
    """
    if not xs:
        return 0.0
    return float(statistics.pstdev(xs))


def describe(xs: Sequence[Number]) -> dict[str, float]:
    """Return ``{median, mean, min, max, iqr, stddev, count}``.

    Empty input → empty dict so the caller can ``if not d: ...`` and skip
    rendering a row without checking individual keys.
    """
    if not xs:
        return {}
    return {
        "median": median(xs),
        "mean": mean(xs),
        "min": float(min(xs)),
        "max": float(max(xs)),
        "iqr": iqr(xs),
        "stddev": stddev(xs),
        "count": float(len(xs)),
    }
