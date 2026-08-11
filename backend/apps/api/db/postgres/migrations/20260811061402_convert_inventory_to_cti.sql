-- migrate:up
-- =================================================================
-- INVENTORY CTI - every ci.inventory row gains a ci.entities base row
-- =================================================================
-- First class-table-inheritance conversion, fully normalized. An item's
-- identity becomes a ci.entities uuid: the base row is discriminated 'Item'
-- and shares the SAME uuid as the ci.inventory detail row
-- (inventory.object_id = entities.entity_id), and the
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
--
--    The delta triggers (20260809182943) are OFF for the rebuild. They record
--    every ci.entities statement into ci.graph_deltas, which
--    backend/apps/summary/src/ci/summary/insight_aggregator.py renders as the
--    "what changed in your graph" section of every summary. Left on, this
--    normalization would reach the user as a mass deletion followed by a mass
--    creation of items they did not touch. A schema migration is not a graph
--    change, and the delta log should not claim it was one.
--
--    Only the two delta triggers are disabled, by name.
--    entities_search_vector_trigger (BEFORE INSERT ... FOR EACH ROW) stays on:
--    the whole point of moving the text into the base row is that items become
--    findable in graph text search, which is that trigger's job.
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_delete;
ALTER TABLE ci.entities DISABLE TRIGGER entities_graph_delta_insert;

-- Scoped by provenance: only detail-table mirrors are rebuilt. 'Item'-typed
-- rows created by graph ingest (linked_table 'import:<source>') are real graph
-- entities with their own ids and relationships, not inventory mirrors, and
-- must survive the rebuild. The entity_id subselect additionally clears any
-- row that would collide with the re-insert below regardless of provenance.
DELETE FROM ci.entities
WHERE entity_type = 'Item'
  AND (linked_table = 'inventory'
       OR entity_id IN (SELECT object_id FROM ci.inventory));

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT
  i.object_id, 'Item', i.name, i.description, '{}'::jsonb,
  COALESCE(i.owner_user_id, i.user_id), 'inventory', i.object_id,
  i.created_at, i.updated_at
FROM ci.inventory i;

ALTER TABLE ci.entities ENABLE TRIGGER entities_graph_delta_insert;
ALTER TABLE ci.entities ENABLE TRIGGER entities_graph_delta_delete;

-- 2. The CTI invariant: no detail row without its base row, AND the base row
--    must carry the matching discriminator. The FK target is the composite
--    (entity_id, entity_type), backed by the UNIQUE below, and the detail
--    side pins its half with a constant CHECKed column, so a detail row can
--    never point at a base row of another type (the application's ON CONFLICT
--    DO NOTHING guards would otherwise paper over such a mismatch silently).
--    The pinned column is DEFAULTed and CHECKed, so no writer names it.
--
--    DEFERRABLE INITIALLY DEFERRED so bulk ingest may insert detail-then-base
--    inside one transaction; ON DELETE CASCADE so deleting the base row deletes
--    the aggregate as one unit (ItemService.remove deletes the base; the detail
--    follows).
ALTER TABLE ci.entities
  ADD CONSTRAINT entities_entity_id_entity_type_key UNIQUE (entity_id, entity_type);

ALTER TABLE ci.inventory
  ADD COLUMN entity_type text NOT NULL DEFAULT 'Item'
    CONSTRAINT inventory_entity_type_check CHECK (entity_type = 'Item');

ALTER TABLE ci.inventory
  ADD CONSTRAINT inventory_object_id_entities_fk
  FOREIGN KEY (object_id, entity_type) REFERENCES ci.entities(entity_id, entity_type)
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
