-- migrate:up

-- `last_run_at` is stamped BEFORE the cron body runs, so it is the time of the
-- last *attempt* — it stays fresh for a tick that threw, and for a tick that
-- returned immediately on a feature gate. "Last run: 2 minutes ago" was
-- therefore true of a schedule that had succeeded at nothing for weeks.
-- Stamp a second column after the body returns so attempted and succeeded are
-- distinguishable. NULL means "has never completed a tick since this column
-- existed", which is the honest answer for every pre-existing row.

ALTER TABLE ci.cron_runs
    ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

COMMENT ON COLUMN ci.cron_runs.last_run_at IS
  'Last attempt. Stamped before the cron body runs, so it is fresh even when the body throws.';

COMMENT ON COLUMN ci.cron_runs.last_success_at IS
  'Last tick whose body returned without throwing. NULL until the schedule completes one.';

-- migrate:down

ALTER TABLE ci.cron_runs
    DROP COLUMN IF EXISTS last_success_at;
