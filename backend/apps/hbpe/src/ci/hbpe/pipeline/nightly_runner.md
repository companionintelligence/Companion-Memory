# HBPE nightly step functions

## Intent

`nightly_runner.py` implements the independently observable steps orchestrated
by `ci.hbpe.functions`.

## Summary-label window

The summary-label step defaults to `bootstrap.content_source_days` — tiers A+B
of the day *list* the next token serialization will publish, not the span
between its ends. Aiming at a span would pay two Qwen calls per summary for every
day inside a bimodal corpus's gap, none of which serialization would then
publish. It only processes unlabeled hourly summaries, so repeated nightly runs
are cheap and idempotent. Optional inclusive start/end dates exist for an
explicit recovery run. Explicit ranges cannot span more than
`SERIALIZE_WINDOW_DAYS` (90 days), the largest label window that the token
serializer can publish.

It deliberately does NOT use `token_source_days`, which also carries tier C. A
purge day is source-less by construction, so it has no summary to label, and
handing one to `get_unlabeled_summaries_on_days` would widen that reader's
sargable MIN/MAX bracket across the whole corpus to fetch nothing.

If the day list comes back empty the step falls back to the previous UTC day.
That is *not* a recovery path for a just-created summary — the day list is
clamped with `< today + 1 day`, so a summary written minutes ago is already in
it. Because this reads the CONTENT tiers, the list is empty whenever the user
has no event and no hourly summary at or before today; leftover
`hbpe.token_stream` rows no longer keep it non-empty (they are tier C, which
serialize still receives). Labeling yesterday then finds nothing either. The
branch is there so the step reports a concrete day instead of indexing an empty
list; it is a no-op wherever it fires.

## Cancellation

`_run_inference` sets a `threading.Event` when its task is cancelled, and every
batch it drives must poll it between items. `_stop_poll` adapts that event to
the `should_continue()` predicate the summary tokenizer takes. Without it a
cancelled nightly would zombie-run the rest of a batch that is now the whole
serialize day list — up to ~2,160 summaries at two Qwen calls each — holding the
single-flight inference executor against every other user's night.
