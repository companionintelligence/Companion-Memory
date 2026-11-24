-- migrate:up
-- hbpe.token_stream_rollup.tier: accept the tiers the rollup code writes.
--
-- WHY. #2553 folded the weekday/weekend split into `tier`, so the two groups of
-- a week stop colliding on the primary key: token_rollup._build_weekly now
-- writes 'weekly_weekday' and 'weekly_weekend'. The CHECK that
-- 20260828120000_hbpe_life_forecast.sql put on the column still allowed only
-- 'weekly' and 'prior_year'. So once hbpe.token_stream held a day older than
-- token_rollup.RAW_DAYS (30), the rollup INSERT raised CheckViolation. That
-- INSERT is the last thing bootstrap.serialize_token_stream does, after the
-- token rows are written, so the step reported an error with its work done:
-- the nightly recorded a failed serialize step, functions.bootstrap aborted the
-- cold start as `no_token_data`, and the nightly's recurrence step swallowed
-- the same error, which also skipped the seasonal-profile rebuild behind it.
-- Training went on without the rollup corpus and nothing said so.
--
-- WHAT. Replace the CHECK with one that accepts the three tiers written today
-- (weekly_weekday, weekly_weekend, prior_year) and still accepts 'weekly', so
-- ADD CONSTRAINT cannot fail on a row an earlier release left behind. There is
-- no backfill: the table is a derived cache, and rebuild_token_rollups replaces
-- a user's rows in full (DELETE, then INSERT) at the end of every serialize
-- run, so the first run after this migration fills it.
--
-- The constraint keeps its name. backend/apps/hbpe/tests/test_rollup_tier_parity.py
-- pins the tiers the code writes to this list, so the two cannot drift again.
ALTER TABLE hbpe.token_stream_rollup
    DROP CONSTRAINT IF EXISTS token_stream_rollup_tier_check;

ALTER TABLE hbpe.token_stream_rollup
    ADD CONSTRAINT token_stream_rollup_tier_check
    CHECK (tier IN ('weekly', 'weekly_weekday', 'weekly_weekend', 'prior_year'));

-- migrate:down
-- A rebuilt cache holds rows the old CHECK rejects, and ADD CONSTRAINT checks
-- every row, so the rows in the new tiers go first. They are derived: a serialize
-- run rebuilds them, though not under this schema, which rejects them again. Any
-- release that still writes the split tiers hits the bug this migration fixes.
DELETE FROM hbpe.token_stream_rollup
 WHERE tier NOT IN ('weekly', 'prior_year');

ALTER TABLE hbpe.token_stream_rollup
    DROP CONSTRAINT IF EXISTS token_stream_rollup_tier_check;

ALTER TABLE hbpe.token_stream_rollup
    ADD CONSTRAINT token_stream_rollup_tier_check
    CHECK (tier IN ('weekly', 'prior_year'));
