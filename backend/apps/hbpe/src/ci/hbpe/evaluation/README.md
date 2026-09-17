# `ci.hbpe.evaluation` — offline walk-forward forecaster evaluation

Measures any next-day L0 forecaster against the baselines, on history, without
deploying it.

## Why this exists

`pipeline/baselines.py` already scores B0/B1/B2 walk-forward, but only against
`hbpe.prediction_log` — actuals that exist solely for days a forecast was
*served* and later backfilled. That is the right source for monitoring what is
live, and useless for deciding what to build: a candidate forecaster has no log
rows, and history predating the first served forecast is invisible.

This package derives history *and* actuals from `hbpe.token_stream`, the same
table `occupancy_counts` fits on. Every day in the corpus becomes an evaluation
day, and a forecaster can be scored before a line of serving code is written.

## Running it

```bash
python -m ci.hbpe.evaluation --list-users          # which users have a corpus
python -m ci.hbpe.evaluation --user <uuid>
python -m ci.hbpe.evaluation --user <uuid> --with-hmt --json
```

`--list-users` reports days, rows and date range per user, longest history
first, so picking a UUID does not need a separate psql session.

`--with-hmt` adds the deployed transformer; it needs a checkpoint and pulls in
ONNX/torch. Everything else runs on numpy alone.

```python
from ci.hbpe.evaluation import walk_forward, render
from ci.hbpe.pipeline.baselines import fetch_occupancy_rows

print(render(walk_forward(fetch_occupancy_rows(user_id)), candidate="hmt"))
```

## Adding a forecaster

Implement `Forecaster` — `name`, and `forecast(history, target_date, fit)`
returning `(n_buckets, 8)` over `L0_CLASSES` order:

```python
class MyForecaster:
    name = "mine"

    def forecast(self, history, target_date, fit):
        return ...  # (96, 8), rows summing to 1
```

`history` is already filtered to rows strictly before `target_date`, so leaking
future data requires fabricating it rather than forgetting a cutoff. `fit` is
the shared `occupancy_counts` result for the day — a cache computed once and
handed to every forecaster, carrying nothing that is not already in `history`;
ignore it freely.

Outputs are validated per day for shape, finiteness and normalisation, and a
violation raises rather than quietly corrupting a Brier score.

## Reading the table

Scores come from `pipeline.scoring.score_predictions` — the same Brier / top-1 /
ECE / per-class-recall path that writes `hbpe.prediction_score` — so a number
here is directly comparable to a number in production.

`D3 serve gate:` applies `serve.pick_served_model` to the candidate's own
metrics and reports `CLEARS` or `BENCHED`. That is the rule that actually
governs deployment; prefer it to whichever metric happens to flatter a model.

### Two traps this harness exposes

**Top-1 is inflated for flat forecasters.** `scoring.argmax_class` breaks ties
by `L0_CLASSES` order, whose first entry is `WORK`. A model that has learned
nothing therefore "predicts" WORK everywhere and collects the WORK base rate —
around 45% on typical corpora, and WORK is already the plurality class in the
seed data. Since top-1 is the D3 gate's primary branch, a degenerate forecaster
clears a surprisingly high bar. This is why `uniform` is a permanent row: the
table always shows what nothing scores, and any candidate near that line has
learned nothing regardless of how impressive its top-1 looks.

**B1 is under-confident, not inaccurate.** Slicing by day-of-week gives B1 seven
times fewer counts per cell than B0, and `hmm.LAPLACE = 1.0` smooths a thin cell
hard. B1 routinely posts the best top-1 and a markedly worse Brier and ECE than
B0. A candidate that beats B1 on Brier/ECE while losing on top-1 has not
necessarily beaten it at forecasting — it may only be better calibrated. Read
all three columns.

## Files

| file | role |
|---|---|
| `corpus.py` | token-stream slicing; history/actuals extraction, eligibility |
| `forecaster.py` | the `Forecaster` protocol, `DayFit`, and reference models |
| `walkforward.py` | the loop, leakage guard, output validation, D3 verdict |
| `report.py` | text rendering |
| `hmt.py` | adapter for the deployed transformer (ONNX + DB; imported separately) |
| `__main__.py` | CLI |

## Known limitation

Every forecaster except `hmt` is handed a pre-filtered history and structurally
cannot see the future. `HmtForecaster` cannot be constrained that way:
`InferenceEngine` fetches its own occupancy rows and manages the cutoff
internally via `as_of`. Its window loop reads `as_of - (i + 1)` days, so it is
correct as written — but that is a property of the engine, verified by reading
it, not one this harness enforces.
