-- migrate:up
-- Provenance triple for imported communications: (source_type, source_system,
-- source_id). Communications had no write path outside ETL and no provenance
-- columns; add them so the batch createCommunications mutation can find-or-return
-- on conflict and the importer can re-sync safely.
ALTER TABLE communications ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE communications ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE communications ADD COLUMN IF NOT EXISTS source_id TEXT;

-- `communications` is a TimescaleDB hypertable partitioned on (time, user_id), so
-- every UNIQUE index MUST include both partitioning columns. We add them ahead of
-- the provenance triple: the importer sends a stable `time` for a given source
-- row, so (user_id, time, source_type, source_system, source_id) is a sound
-- re-ingest guard, while still satisfying the hypertable constraint. Partial on
-- `source_id IS NOT NULL` so derived/manual rows are unaffected. Paired with the
-- find-or-return upsert in CommunicationService.create.
CREATE UNIQUE INDEX IF NOT EXISTS communications_source_triple_uniq
  ON communications (user_id, time, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS communications_source_triple_uniq;
ALTER TABLE communications DROP COLUMN IF EXISTS source_id;
ALTER TABLE communications DROP COLUMN IF EXISTS source_system;
ALTER TABLE communications DROP COLUMN IF EXISTS source_type;
