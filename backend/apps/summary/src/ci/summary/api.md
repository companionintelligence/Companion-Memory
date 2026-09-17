# Summary HTTP API

## Intent

`api.py` exposes health checks and explicit manual entry points over the same
functions used by scheduled work.

## Recovery trigger

`POST /summary/manual-trigger` accepts `period_type: hourly_backfill` in
addition to normal summary cadences. The request must carry explicit aligned
`start_time` and `end_time`.

The range is validated by `functions.plan_hourly_backfill` **from the endpoint,
before the run is accepted** — the 24-hour bound, hour alignment and required
UTC offsets are all answered as a 400 to the caller who is still on the line,
rather than as a background job failure nobody is watching.

Cadences other than `hourly_backfill` run inline and return the finished
result. A `hourly_backfill` longer than one hour does not: each window is a
full LLM summary, so the endpoint submits it to the function runner and answers
202 with a `backfill_id` and a `progress_url`. A progress record exists from
that moment, so `GET /summary/backfill/{id}` answers while the run waits for a
worker instead of 404ing. A range already queued or running is answered with
that run (`duplicate: true`) rather than submitted twice — the runner takes no
singleton key. `wait: true` forces a multi-hour range inline for an operator
who wants the result in the response; a single hour is inline either way.
