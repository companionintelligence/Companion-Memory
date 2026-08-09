-- Make dead letters erasable.
--
-- `domains/portability` discovers every user-scoped table by COLUMN NAME —
-- `DISCOVER_USER_TABLES_SQL` selects tables having a `user_id` or
-- `owner_user_id` column (`src/domains/portability/userDataTables.ts`) — and
-- export/erasure operate on whatever that query returns.
--
-- Four of the five control-plane tables are therefore already covered:
-- `ci.pipeline_state`, `ci.pipeline_runs` and `ci.record_rejections` carry
-- `user_id` directly, and `ci.pipeline_shards` is reached by its
-- `ON DELETE CASCADE` from `ci.pipeline_runs`.
--
-- `ci.pipeline_dead_letters` was the exception, and it is the one holding
-- payloads that failed: a dead letter is a verbatim copy of a job's data, which
-- for an ingest job is source material. Without this column an erasure request
-- would sweep every other table and silently leave that copy behind — the exact
-- shape of privacy bug that stays invisible until someone audits it.
--
-- Nullable on purpose: not every job is user-scoped (maintenance sweeps,
-- telemetry), and a dead letter whose user cannot be determined must still be
-- recorded. NULL means "not attributable", not "not yet backfilled" — the
-- reaper fills it in the same INSERT that creates the row.
--
-- No FK to ci.users, consistent with the rest of the control plane: this table
-- is written on the failure path, and a write that could fail because a user row
-- is being deleted concurrently would lose the very evidence it exists to keep.

-- migrate:up
ALTER TABLE ci.pipeline_dead_letters
  ADD COLUMN IF NOT EXISTS user_id UUID;

COMMENT ON COLUMN ci.pipeline_dead_letters.user_id IS
  'Owning user, read from the failed job payload. Nullable: system jobs have no user. Present so domains/portability discovers this table for export and erasure.';

-- Partial: the erasure sweep filters by user_id, and the rows that matter are
-- the attributable ones. Cheap here because the table is empty; on a table with
-- history this belongs out of band as CREATE INDEX CONCURRENTLY, since dbmate
-- wraps migrations in a transaction and migrate-database gates api startup.
CREATE INDEX IF NOT EXISTS pipeline_dead_letters_user_idx
  ON ci.pipeline_dead_letters (user_id)
  WHERE user_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.pipeline_dead_letters_user_idx;

ALTER TABLE ci.pipeline_dead_letters
  DROP COLUMN IF EXISTS user_id;
