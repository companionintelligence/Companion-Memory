-- migrate:up
-- Per-connection provenance for events and content.
--
-- ci.communications has carried `connection_id` since it was created, which
-- is what lets DELETE /connections/:id purge one service's messages without
-- touching another's. ci.events lost its column when the table was replaced
-- (20250925145800_replace_events_table) and ci.content never had one, so the
-- ETL transforms parked the id inside JSONB instead — events under
-- `metadata.connectionId` (Google Calendar) or `metadata.connection_id`
-- (Facebook likes), content under `source_data.connection_id` — where nothing
-- could delete by it. This adds a real column to both, indexed for the purge,
-- and backfills it from those JSONB keys so rows written before today are
-- reachable by the same DELETE.
--
-- No foreign key, matching communications: the deletion service removes
-- derived rows before the connection row, and an FK would only add a way for
-- a row that was missed to block that delete.

ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE ci.content ADD COLUMN IF NOT EXISTS connection_id UUID;

CREATE INDEX IF NOT EXISTS idx_events_connection_id
  ON ci.events (connection_id) WHERE connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_connection_id
  ON ci.content (connection_id) WHERE connection_id IS NOT NULL;

-- Backfill. Only values that are well-formed UUIDs are cast; anything else the
-- transforms may have written there is left alone rather than failing the
-- migration.
UPDATE ci.events
SET connection_id = COALESCE(metadata->>'connection_id', metadata->>'connectionId')::uuid
WHERE connection_id IS NULL
  AND COALESCE(metadata->>'connection_id', metadata->>'connectionId')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE ci.content
SET connection_id = (source_data->>'connection_id')::uuid
WHERE connection_id IS NULL
  AND source_data->>'connection_id'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- migrate:down
DROP INDEX IF EXISTS ci.idx_content_connection_id;
DROP INDEX IF EXISTS ci.idx_events_connection_id;
ALTER TABLE ci.content DROP COLUMN IF EXISTS connection_id;
ALTER TABLE ci.events DROP COLUMN IF EXISTS connection_id;
