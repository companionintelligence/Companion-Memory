# Data aggregator

## Intent

`data_aggregator.py` executes the explicit source projections declared in
`summary_sources.py` and returns a stable source-name-to-rows mapping for an
hourly summary window.

## Contract

- Metadata keys (`user_id`, `start_time`, `end_time`) describe the requested
  window; every registry source is present as a list.
- Queries use a uniform parameter set and the per-source row limit.
- Database errors propagate. An hourly job with a stale schema is a failed job
  eligible for retry and diagnosis, not a successful "Nothing new" summary.
- Schema discovery and broad `SELECT *` behavior do not belong here; source
  semantics live in the registry.
