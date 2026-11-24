# HBPE data client

## Intent

`data_client.py` is the read boundary between HBPE and application-owned data.
Summary reads only accept `ci.summaries.period_type = 'hourly'`; generated
insights and rollups are intentionally excluded from behavioral labels.

## Summary read contract

Two readers, one direct SQL query each, rather than repeatedly downloading the
entire GraphQL connection for each day. Both return rows ordered by
`period_start`, and both exclude existing `hbpe.summary_l1_label` rows in SQL.

- `get_unlabeled_summaries_on_days(user_id, dates)` is the nightly default. It
  selects the serialize day *list* itself, because that list jumps the gap on a
  bimodal corpus and a `(MIN, MAX)` range would pull in every summary inside the
  gap for labels serialization never publishes. It still carries the bracketing
  range predicate: `period_start::date = ANY(...)` is not sargable on its own,
  so without it the planner scans every hourly summary. An empty day list issues
  no query at all.
- `get_unlabeled_summaries_in_range(user_id, start, end)` remains for explicit
  operator recovery over a contiguous span, inclusive by calendar date.

## Event read contract

Both event readers that feed training, `get_token_events_for_day` (what the
serializer publishes) and `get_unlabeled_events` (what the Qwen drain labels),
leave out events that did not happen: deleted rows, planning's own
`planned_block` rows, and, through `event_status.LIVE_EVENT_SQL`, the statuses
the calendar treats as dead (`cancelled`, `no_show`, `skipped`). That list is a
copy of `DEAD_EVENT_STATUSES` in `CalendarEventService.ts`, pinned to it by
`tests/test_event_status_parity.py`. `static_labeler.label_mapped_events` and the
two day queries in `pipeline/bootstrap.py` carry the same predicate.
`tests/test_event_status_readers.py` fails when a `ci.events` reader is added
without a decision about it.
