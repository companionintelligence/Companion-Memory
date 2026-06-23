-- migrate:up
-- Provenance triple for imported inventory items: (source_type, source_system,
-- source_id). Lets the importer route timeline items (e.g. Amazon order
-- confirmations → inventory) and safely re-ingest without creating duplicates.
-- Inventory had no provenance columns; add them and a partial unique index so
-- the batch createInventoryItems mutation can find-or-return on conflict, exactly
-- like EventService.create / the events_source_triple_uniq index.
ALTER TABLE ci.inventory ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE ci.inventory ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE ci.inventory ADD COLUMN IF NOT EXISTS source_id TEXT;

-- Scoped to owner_user_id (the auto-detected owner) so two users importing the
-- same external item don't collide. Partial on `source_id IS NOT NULL` so
-- manually-created items without a stable source id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_source_triple_uniq
  ON ci.inventory (owner_user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.inventory_source_triple_uniq;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS source_id;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS source_system;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS source_type;
