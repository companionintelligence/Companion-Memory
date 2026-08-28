-- migrate:up
-- Drop the two `last_accessed` columns. Both were added as declared
-- retrieval-recency inputs; neither ever got the read-path writer that would
-- make them mean anything, and nothing reads them:
--
--   ci.events.last_accessed   — added 20260621005811 alongside salience /
--     access_count "managed by enrichment + reads". No code path has ever
--     assigned it (EventService.create/update never mention it), so the column
--     is NULL on every row that exists. Its two siblings were moved off the hot
--     table into ci.event_analytics by 20260808150100.
--   ci.entities.last_accessed — added 20250925144000 with DEFAULT NOW(). It is
--     stamped once at insert (and, from two Facebook transforms, re-stamped on
--     an update) and never touched again, which makes it a strictly worse copy
--     of created_at. No UPDATE anywhere in the repo sets it.
--
-- Neither column is exposed by GraphQL, by PowerSync sync rules (which exclude
-- ci.events and ci.entities outright, infrastructure/powersync/sync-rules.yaml:24-26)
-- or by any view, index, CHECK or trigger — ci.record_entity_graph_delta
-- deliberately excludes last_accessed from its diffed field list
-- (20260809182943:133), so the trigger body never names it.
--
-- Rebuilding recency ranking later is a `docs/jobs-schedule-review.md` §11 job
-- and needs a real retrieval log, not a resurrected timestamp; both columns are
-- restored byte-for-byte by migrate:down if that work ever starts here.
--
-- DROP COLUMN is catalogue-only in PostgreSQL (the attribute is marked dropped;
-- no table rewrite, no full-table lock beyond the brief ACCESS EXCLUSIVE), so
-- this is safe on ci.events at production row counts. Storage is reclaimed only
-- by a later VACUUM FULL / pg_repack.
ALTER TABLE ci.events
  DROP COLUMN IF EXISTS last_accessed;

ALTER TABLE ci.entities
  DROP COLUMN IF EXISTS last_accessed;

-- migrate:down
-- Restores both columns with their original definitions. Ordinal position is not
-- restored (they return last); harmless — there is no positional INSERT into
-- either table, and no SELECT * against them.
ALTER TABLE ci.events
  ADD COLUMN IF NOT EXISTS last_accessed timestamptz;

ALTER TABLE ci.entities
  ADD COLUMN IF NOT EXISTS last_accessed timestamptz DEFAULT NOW();
