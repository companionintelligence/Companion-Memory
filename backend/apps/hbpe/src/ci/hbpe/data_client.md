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
