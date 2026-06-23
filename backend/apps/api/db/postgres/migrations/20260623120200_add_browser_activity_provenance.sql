-- migrate:up
-- Provenance triple for imported browser activity: (source_type, source_system,
-- source_id). browser_activity had no provenance columns and no idempotency key;
-- add them so the batch createBrowserActivities mutation can find-or-return on
-- conflict and the importer can re-sync safely. The table was departitioned
-- (PK on id), so a plain partial unique index applies.
ALTER TABLE ci.browser_activity ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE ci.browser_activity ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE ci.browser_activity ADD COLUMN IF NOT EXISTS source_id TEXT;

-- Scoped to user_id so two users importing the same external activity don't
-- collide. Partial on `source_id IS NOT NULL` so live-captured rows (browser
-- extension) without a stable source id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS browser_activity_source_triple_uniq
  ON ci.browser_activity (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.browser_activity_source_triple_uniq;
ALTER TABLE ci.browser_activity DROP COLUMN IF EXISTS source_id;
ALTER TABLE ci.browser_activity DROP COLUMN IF EXISTS source_system;
ALTER TABLE ci.browser_activity DROP COLUMN IF EXISTS source_type;
