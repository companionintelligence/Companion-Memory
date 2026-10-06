"""Text rendering for a walk-forward run."""

from __future__ import annotations

from ci.hbpe.evaluation.walkforward import WalkForwardResult
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

# Uniform over 8 classes scores exactly this; anything near it has learned
# nothing. Printed as a reference line so the reader does not have to recall it.
_C = len(L0_CLASSES)
UNIFORM_BRIER = (1.0 - 1.0 / _C) ** 2 + (_C - 1) * (1.0 / _C) ** 2


def _fmt(value: float | None, places: int = 4) -> str:
    return "—" if value is None else f"{value:.{places}f}"


def macro_recall(score, exclude: str | None = None) -> float | None:
    """
    Mean per-class recall over classes that have support.

    Neither top-1 nor Brier survives a corpus with one dominant class, and both
    corpora here have one: sparse is 41% WORK, densified is 97% background. A
    forecaster that answers the dominant class everywhere posts 0.99 top-1 and
    a Brier near zero on the densified run while recognising nothing. Averaging
    recall over classes weights the rare ones equally with the common one, so
    that forecaster scores near zero here, which is the honest number.

    *exclude* drops the densification filler, whose recall says only how often
    the model correctly predicted that nothing was recorded.
    """
    values = [
        stats["recall"]
        for cls, stats in score.per_class.items()
        if cls != exclude and stats.get("support") and stats.get("recall") is not None
    ]
    return sum(values) / len(values) if values else None


def render(
    result: WalkForwardResult,
    candidate: str | None = None,
    background: str | None = None,
) -> str:
    cov = result.coverage
    lines = [
        "Walk-forward L0 occupancy forecast",
        "",
        f"  eval days       {cov.eval_days}"
        + (
            f"  ({cov.first_day} → {cov.last_day})"
            if cov.first_day and cov.last_day
            else ""
        ),
        f"  scored buckets  {cov.scored_buckets}"
        f"  ({cov.buckets_per_eval_day:.1f}/day of {cov.buckets_per_day},"
        f" {cov.occupancy_rate:.1%} occupancy)",
        "",
        f"  {'model':<14}{'n':>7}{'macro-R':>9}{'top-1':>9}{'Brier':>9}{'ECE':>9}",
        f"  {'-' * 14}{'-' * 7:>7}{'-' * 9:>9}{'-' * 9:>9}{'-' * 9:>9}{'-' * 9:>9}",
    ]

    # Ordered by macro recall, and Brier where that is unavailable. The gate no
    # longer reads top-1 and neither should the reader: on a corpus with one
    # dominant class it ranks a degenerate forecaster first.
    macro = {
        name: macro_recall(s, exclude=background) for name, s in result.scores.items()
    }
    ordered = sorted(
        result.scores.items(),
        key=lambda kv: (
            macro[kv[0]] is None,
            -(macro[kv[0]] or 0.0),
            kv[1].brier or 0.0,
        ),
    )
    for name, score in ordered:
        lines.append(
            f"  {name:<14}{score.n_l0:>7}"
            f"{_fmt(macro[name], 3):>9}"
            f"{_fmt(score.l0_top1_acc):>9}"
            f"{_fmt(score.brier):>9}"
            f"{_fmt(score.ece):>9}"
        )

    lines += ["", f"  (uniform Brier = {UNIFORM_BRIER:.4f})"]
    if background:
        lines.append(f"  (macro-R excludes {background}, the densification filler)")
    lines += ["", "  per-class recall"]
    header = f"  {'class':<14}" + "".join(f"{n:>12}" for n, _ in ordered)
    lines.append(header)
    for cls in L0_CLASSES:
        support = next(
            (s.per_class.get(cls, {}).get("support", 0) for _, s in ordered), 0
        )
        row = f"  {cls:<14}"
        for _, score in ordered:
            recall = score.per_class.get(cls, {}).get("recall")
            row += f"{_fmt(recall, 3):>12}"
        lines.append(f"{row}   (n={support})")

    if candidate:
        verdict = result.served_verdict(candidate)
        if verdict is None:
            lines += ["", f"  D3 serve gate: {candidate} not comparable (no B1 row)"]
        else:
            outcome = (
                "CLEARS" if verdict == "serve" else "BENCHED (falls back to a baseline)"
            )
            lines += ["", f"  D3 serve gate: {candidate} {outcome}"]
    return "\n".join(lines)
