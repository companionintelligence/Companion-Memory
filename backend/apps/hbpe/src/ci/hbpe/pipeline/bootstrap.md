# HBPE bootstrap steps

## Intent

`bootstrap.py` owns cold-start serialization-day selection, token-stream
publication, HMT training, calibration, and model export.

## Which days get serialized

`token_source_days` returns the most recent `SERIALIZE_WINDOW_DAYS + 1`
calendar days that hold an event, an hourly summary, or stale
`hbpe.token_stream` rows, with nothing dated after today. It is a **list of
days**, not a contiguous `(MIN, MAX)` range, and the difference is load-bearing
in both directions:

- Hourly summaries are written continuously, so on any running appliance the
  union's `MAX` is today. A contiguous trailing window therefore contains zero
  events on an imported corpus whose events stop in 2024 — the whole historical
  event corpus stops being labeled and stops reaching `hbpe.token_stream`,
  replaced by summary tokens at the lower `SUMMARY_SOFT_PROB` (0.7).
- Ending the range at the last *event* instead strands a summary created today
  outside `hbpe.token_stream`.

A day list holds both ends inside one 90-day budget, and costs the same number
of `serialize_day` calls as a contiguous 90-day range — whereas widening the
range to span the gap would be ~800 days on that corpus.

### What the budget actually guarantees

Only this: the newest `SERIALIZE_WINDOW_DAYS + 1` days-with-data are
serialized. `ORDER BY source_date DESC LIMIT 91` has no notion of *source*, so
the archival event days survive only while fewer than 91 days-with-data are
newer than them. On an appliance carrying **both** an archival import and
continuous live capture, the hourly summaries add one day-with-data per
calendar day, so roughly 91 days after the import every 2024 event day is
evicted and the historical corpus stops reaching `hbpe.token_stream` again.
That is the same failure the contiguous window had, deferred by about three
months rather than eliminated.

Removing it means a **policy** change, not a query change: reserve a share of
the budget for event-bearing days and cap the summary branch instead of letting
it fill the list. That is deliberately not done here.

### Purging a day that emptied out

`serialize_day`'s `DELETE` is the only thing in the repo that removes rows from
`hbpe.token_stream`, and it only runs on days this query returns. A day *can*
empty out — its sole event soft-deleted by `CalendarEventService`, or its
`start_time` edited onto another day — and it then disappears from both source
branches. So the query also unions the distinct dates that still hold
`hbpe.token_stream` rows for the user, under the same clamp to today. The
emptied day is revisited once, purged, and drops out by itself on the next run.
The old contiguous `serialize_range(start, end)` got this for free by walking
every calendar day in the window whether or not it held data.

Those days compete for the same `LIMIT` budget rather than being added on top
of it: a purge frees the slot it borrowed the same night, whereas an extra
budget would let a bulk delete inflate one night's `serialize_day` count
without bound.

### Why `ci.tasks` is not a source branch

The predicate it would need (`l0_class IS NOT NULL AND l0_class <> 'UNKNOWN'`)
has no writer anywhere in the repo;
`data_client._completed_tasks_l0_class_populated()` probes exactly that once per
process so the always-empty scan stops running.

Note the asymmetry: the serializer still **consumes** completed labeled tasks
once a day has been selected (`serializer._fetch_tokens_for_day` →
`data_client.get_completed_tasks_for_day`). A task therefore contributes tokens
only on a day some other source already put in the list. A future writer of
`ci.tasks.l0_class` has to add the selection branch back here as well.

## Summary relationship

Summary labeling is orchestrated immediately before serialization and targets
the same day list, so every expensive label can become an HBPE token and the
cold start does not waste work outside the model corpus.

## Legacy helpers

`event_date_bounds` and `serialize_window` remain exported. They no longer
drive serialization; the contiguous window is still the right shape for
`label_recency_start`'s fallback cutoff, and the bounds are the cheapest way to
tell an empty corpus apart from an entirely future-dated one.
