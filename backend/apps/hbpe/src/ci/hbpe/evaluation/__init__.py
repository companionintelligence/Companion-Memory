"""
Offline walk-forward evaluation for HBPE next-day forecasters.

Answers the only question that decides whether a new forecaster ships: does it
beat B1 on the D3 gate's own terms, measured on history, without deploying it?

    from ci.hbpe.evaluation import walk_forward, render
    from ci.hbpe.pipeline.baselines import fetch_occupancy_rows

    result = walk_forward(fetch_occupancy_rows(user_id))
    print(render(result))

``ci.hbpe.evaluation.hmt`` adds the deployed transformer as a row; it is a
separate import because it needs ONNX, torch and a database.
"""

from ci.hbpe.evaluation.corpus import (
    actuals_for_day,
    corpus_dates,
    eval_dates,
    history_before,
)
from ci.hbpe.evaluation.forecaster import (
    DEFAULT_FORECASTERS,
    B0Forecaster,
    B1Forecaster,
    B2Forecaster,
    DayFit,
    Forecaster,
    PersistenceForecaster,
    UniformForecaster,
)
from ci.hbpe.evaluation.report import render
from ci.hbpe.evaluation.walkforward import (
    Coverage,
    WalkForwardResult,
    walk_forward,
)

__all__ = [
    "DEFAULT_FORECASTERS",
    "B0Forecaster",
    "B1Forecaster",
    "B2Forecaster",
    "Coverage",
    "DayFit",
    "Forecaster",
    "PersistenceForecaster",
    "UniformForecaster",
    "WalkForwardResult",
    "actuals_for_day",
    "corpus_dates",
    "eval_dates",
    "history_before",
    "render",
    "walk_forward",
]
