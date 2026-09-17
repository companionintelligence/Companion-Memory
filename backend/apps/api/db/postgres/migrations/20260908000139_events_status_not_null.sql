-- migrate:up
-- `ci.events.status` has carried DEFAULT 'confirmed' since the table was
-- created, but never NOT NULL — so anything that wrote an explicit NULL (a bulk
-- insert naming the column, an ETL row with no status of its own) produced a
-- row the calendar cannot see. Every calendar read filters with
-- `status NOT IN ('cancelled', 'no_show', ...)`, and SQL's three-valued logic
-- makes that UNKNOWN for a NULL, not TRUE — so the row is silently dropped from
-- the schedule grid, the planner's occupied set, and peer free/busy alike.
--
-- The readers were fixed to COALESCE (see CalendarEventService.findInRange,
-- PlannedBlockService, TodoProcessService, matching the pattern
-- daily-metrics/dailyAggregateSql.ts already used). This closes the hole at the
-- source so the column finally matches EventEntity.status, which has always
-- been typed non-null.
--
-- Backfill first: ALTER ... SET NOT NULL validates every existing row.

UPDATE ci.events
SET status = 'confirmed'
WHERE status IS NULL;

ALTER TABLE ci.events
    ALTER COLUMN status SET NOT NULL;

-- migrate:down

ALTER TABLE ci.events
    ALTER COLUMN status DROP NOT NULL;
