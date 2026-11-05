-- migrate:up
-- A leg the control tick found nothing stale for, and at which stage version.
--
-- The tick probed every (user, stage, entity_type) leg on every tick with a
-- LIMIT 1 anti-join over the leg's whole source — the cheapest proof there is
-- that nothing is stale, and still ~7 ms / ~7,800 blocks per leg on a converged
-- corpus, for thirty-odd legs, every two minutes, forever. A leg never starts a
-- sweep while it is converged, so its last_started_at never moves and the
-- clock never excuses the probe. This stamp does: a leg found converged at
-- this version is not probed again for CONVERGED_REPROBE_SECONDS (pipeline
-- constants.ts), and the stamp is dropped the moment a sweep starts for the
-- leg or the stage version moves.
--
-- last_started_at becomes nullable so a leg that has NEVER run can carry the
-- stamp too: a user with no rows for a stage would otherwise be probed every
-- tick for the lifetime of the appliance. No row, or a NULL clock, still reads
-- as never-run (infinite staleness) to stageDueness.
ALTER TABLE ci.pipeline_schedule
  ALTER COLUMN last_started_at DROP NOT NULL,
  ADD COLUMN converged_at TIMESTAMPTZ,
  ADD COLUMN converged_version INTEGER;

COMMENT ON COLUMN ci.pipeline_schedule.last_started_at IS
  'The instant the control tick claimed this leg''s shard — the START of a sweep, stamped before any slice is enqueued. No row, or NULL, means the leg has never run, which stageDueness treats as infinite staleness.';
COMMENT ON COLUMN ci.pipeline_schedule.converged_at IS
  'When the tick last probed this leg and found nothing stale, at converged_version. While younger than CONVERGED_REPROBE_SECONDS and at the current stage version, the tick does not probe the leg. Cleared by a sweep start.';

-- migrate:down
ALTER TABLE ci.pipeline_schedule
  DROP COLUMN converged_version,
  DROP COLUMN converged_at;
-- A NULL clock cannot survive the constraint coming back; the row is a stamp
-- for a never-run leg, which no row expresses just as well.
DELETE FROM ci.pipeline_schedule WHERE last_started_at IS NULL;
ALTER TABLE ci.pipeline_schedule ALTER COLUMN last_started_at SET NOT NULL;
