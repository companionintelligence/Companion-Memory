-- migrate:up
-- =================================================================
-- INVENTORY CTI - every ci.inventory row gains a ci.entities base row
-- =================================================================
-- First class-table-inheritance conversion (see ENTITY-INHERITANCE-MATRIX.md,
-- "Class C"), fully normalized. An item's identity becomes a ci.entities uuid:
-- the base row is discriminated 'Item' and shares the SAME uuid as the
-- ci.inventory detail row (inventory.object_id = entities.entity_id), and the
-- base row is the SOLE owner of name/description — the inventory copies are
-- moved into it and dropped. Nothing in ci_search rekeys — embeddings/
-- entity_tag rows already key items by object_id, and that uuid is now also
-- the entity uuid. Base rows carrying real text also means items land in the
-- ci.entities search_vector (graph text search).
--
-- ci.inventory.object_entity_id (added 20260803223025) was a dead precursor of
-- this link (no writer anywhere, all NULL); dropped below.

-- 1. Rebuild the 'Item' slice of ci.entities from the detail table, moving
--    name/description into the base row. linked_table/linked_id carry the
--    self-describing provenance pair ('inventory', object_id).
DELETE FROM ci.entities WHERE entity_type = 'Item';

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT
  i.object_id, 'Item', i.name, i.description, '{}'::jsonb,
  COALESCE(i.owner_user_id, i.user_id), 'inventory', i.object_id,
  i.created_at, i.updated_at
FROM ci.inventory i;

-- 2. The CTI invariant: no detail row without its base row.
--    DEFERRABLE INITIALLY DEFERRED so bulk ingest may insert detail-then-base
--    inside one transaction; ON DELETE CASCADE so deleting the base row deletes
--    the aggregate as one unit (ItemService.remove deletes the base; the detail
--    follows).
ALTER TABLE ci.inventory
  ADD CONSTRAINT inventory_object_id_entities_fk
  FOREIGN KEY (object_id) REFERENCES ci.entities(entity_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- 3. Normalize: the base row owns name/description now; the dead mirror column
--    goes with them.
ALTER TABLE ci.inventory
  DROP COLUMN name,
  DROP COLUMN description,
  DROP COLUMN object_entity_id;

-- migrate:down
-- One-way (normalization). Restoring the detail-side columns would require
-- copying values back out of ci.entities; re-ingest instead.
