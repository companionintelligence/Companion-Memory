-- migrate:up
-- Idempotency key for captured/imported events: the (source_type, source_system,
-- source_id) provenance triple. Lets a capture source (importer, browser ext,
-- pipe) safely re-send the same event without creating duplicates. Partial on
-- `source_id IS NOT NULL` so derived/manual events without a stable source id
-- are unaffected. Paired with the find-or-return upsert in EventService.create.
CREATE UNIQUE INDEX IF NOT EXISTS events_source_triple_uniq
  ON ci.events (source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.events_source_triple_uniq;
