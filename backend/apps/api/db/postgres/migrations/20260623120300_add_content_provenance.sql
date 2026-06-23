-- migrate:up
-- Provenance triple for imported content: (source_type, source_system,
-- source_id). ci.content had no provenance columns; add them so the batch
-- createContents mutation can find-or-return on conflict and the importer can
-- re-sync safely. The same triple also auto-links a content row to its event:
-- ContentService.createMany looks up ci.events by the matching
-- (user_id, source_type, source_system, source_id) and sets content.event_id.
ALTER TABLE ci.content ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE ci.content ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE ci.content ADD COLUMN IF NOT EXISTS source_id TEXT;

-- Scoped to user_id so two users importing the same external content don't
-- collide. Partial on `source_id IS NOT NULL` so derived/manual content without
-- a stable source id is unaffected. Paired with the find-or-return upsert in
-- ContentService.createMany.
CREATE UNIQUE INDEX IF NOT EXISTS content_source_triple_uniq
  ON ci.content (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.content_source_triple_uniq;
ALTER TABLE ci.content DROP COLUMN IF EXISTS source_id;
ALTER TABLE ci.content DROP COLUMN IF EXISTS source_system;
ALTER TABLE ci.content DROP COLUMN IF EXISTS source_type;
