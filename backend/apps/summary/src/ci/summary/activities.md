# Summary activities

## Intent

`activities.py` is the I/O boundary for summary functions: database reads and
writes, model calls, dossier persistence, insight context, and action storage.

## Summary storage contract

Hourly generation checks for an existing `(user, period_type, period_start,
period_end)` row before doing expensive aggregation or model work, so a
scheduled retry skips a window that is already summarized.

That check alone is not the guarantee. `store_summary_activity` writes as an
UPSERT against the partial unique index `summaries_user_window_uniq` (migration
`20260903162709_unique_summary_window.sql`, `WHERE period_type <> 'insight'`) —
without it, two runs that both passed the existence check each inserted a row
for the same window. On conflict the stored content is replaced and the
SURVIVING row's id is read back, because the id minted for the losing insert
points at nothing. `seen` is deliberately left alone: regenerating a window is
not a reason to mark it unread.

Insights are excluded from the index on purpose — one run stores several cards
over the same span.

Database and model errors propagate to the function runner unless an activity's
documented product semantics explicitly make it non-fatal.
