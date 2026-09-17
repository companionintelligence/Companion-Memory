# Summary background functions

## Intent

`functions.py` orchestrates named summary, dossier, insight, and action jobs.
The functions contain sequencing and skip policy while database/model effects
remain in `activities.py`.

## Hourly recovery

- `hourly_summary` is idempotent for an exact hour window and skips a window
  already stored.
- `hourly_summary_backfill` walks an explicit, UTC-offset-aware range in whole
  one-hour windows.
- A backfill range must be aligned to hour boundaries, non-empty, and no longer
  than 24 hours. This prevents an accidental unbounded model workload.
- Empty hours remain successful skips and existing hours remain successful
  idempotent skips; both are reported in the aggregate result.

Other products retain their own semantics: insight cards append incrementally,
while dossier refresh updates the user's existing entity payload.
