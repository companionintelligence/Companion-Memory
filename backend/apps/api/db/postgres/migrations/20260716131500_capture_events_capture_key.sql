-- migrate:up

-- The bulk-ingest capture log (BulkIngestController.captureChunk) inserts
--   (user_id, destination, source_type, source_system, source_id, kind,
--    occurred_at, observed_at, payload)
-- and upserts on the capture key
--   (user_id, destination, source_type, source_system, source_id),
-- but 20260621021634_create_capture_events shipped the table without
-- `destination`/`source_type` and with a narrower UNIQUE
-- (user_id, source_system, source_id). Dev databases were patched by hand,
-- so the drift only breaks FRESH installs: every /v1 bulk lane 500s on the
-- missing column. All statements are idempotent so already-patched databases
-- migrate cleanly.

-- Fan-out kinds send one record to two destinations (events + content), so
-- `destination` is part of the capture identity.
ALTER TABLE ci.capture_events ADD COLUMN IF NOT EXISTS destination text NOT NULL DEFAULT 'events';
-- Provenance triple leg (e.g. 'ci-import-tools', or 'capture' for the
-- namespaced fallback lane).
ALTER TABLE ci.capture_events ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'capture';

ALTER TABLE ci.capture_events ALTER COLUMN destination DROP DEFAULT;
ALTER TABLE ci.capture_events ALTER COLUMN source_type DROP DEFAULT;

-- The materialize→link step stamps the destination row's id back onto its
-- capture row (UPDATE … SET materialized_id, BulkIngestController). Nullable:
-- a capture row is unlinked until its record materializes.
ALTER TABLE ci.capture_events ADD COLUMN IF NOT EXISTS materialized_id uuid;

-- Replace the v1 unique key with the capture key the ON CONFLICT targets.
ALTER TABLE ci.capture_events
  DROP CONSTRAINT IF EXISTS capture_events_user_id_source_system_source_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS capture_events_capture_key_uniq
  ON ci.capture_events (user_id, destination, source_type, source_system, source_id);

-- migrate:down

DROP INDEX IF EXISTS ci.capture_events_capture_key_uniq;
ALTER TABLE ci.capture_events
  ADD CONSTRAINT capture_events_user_id_source_system_source_id_key
  UNIQUE (user_id, source_system, source_id);
ALTER TABLE ci.capture_events DROP COLUMN IF EXISTS destination;
ALTER TABLE ci.capture_events DROP COLUMN IF EXISTS source_type;
ALTER TABLE ci.capture_events DROP COLUMN IF EXISTS materialized_id;
