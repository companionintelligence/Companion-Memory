# Summary source registry

## Intent

`summary_sources.py` is the schema contract between the current `ci` database
and hourly summaries. Each entry owns one explicit, bounded projection of a
source table. Semantic fields are selected before identifiers and bookkeeping
so prompt clipping cannot hide the material being summarized.

## Contract

- Every query accepts `user_id`, `start`, `end`, and `limit` parameters.
- The time predicate means "new or materially changed in this summary window"
  where the table exposes creation/update timestamps; event occurrence times
  remain present in the projected row.
- Raw capture logs and generated products are deliberately absent. In
  particular, `capture_events`, `summaries`, `insights`, `activity_rollup`, and
  `agent_memories` would duplicate material or create feedback loops.
- Sensitive browser rows, deleted records, inferred answers, and private
  answers are filtered before prompt construction.
- **Exclusion filters are NULL-safe.** Every flag filtered on except
  `ci.events.is_deleted` is nullable, and `col = false` is NULL rather than
  true for a NULL row, so a plain equality drops that row from the summary with
  no log line. Writers do produce explicit NULLs -- bulk ingest paths that
  enumerate columns, partial upserts -- because the column default only applies
  when the column is omitted. Boolean flags therefore use `col IS NOT TRUE` and
  `ci.answers.answer_source` uses `IS DISTINCT FROM 'inferred'`.
- **A NULL is "not excluded", including for the privacy flags**
  (`is_private`, `is_sensitive`, `contains_sensitive`, `is_incognito`). These
  columns default to false, so a NULL is an absent marking rather than an
  unknown; the summary is generated for and read by the row's own owner, so
  this is prompt hygiene honouring an explicit "keep this out", not an
  access-control boundary, and failing open exposes nothing to anyone else.
  The introspection-based aggregator this registry replaced filtered nothing at
  all, so every excluded row is a new exclusion -- only an explicit `true` is a
  positive assertion of privacy, and only that excludes. `ci.events.is_deleted`
  is NOT NULL, so its `= false` is already total and stays.
- A broken projection must fail the job visibly. Callers do not silently turn
  schema errors into an empty hour.

## Extending the registry

Add a source only when it contributes grounded user activity. Project compact
human-readable fields, put text/name fields first, use the shared half-open
window, and add or update the registry contract tests.
