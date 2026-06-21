-- migrate:up
-- Idempotency key for linked/imported entities (people, concepts, places): the
-- (owner_user_id, entity_type, linked_table, linked_id) tuple. Lets a capture
-- source (importer) resolve-or-create an entity by its stable external id
-- without duplicating on re-sync — the entity counterpart of the event
-- (source_type, source_system, source_id) idempotency. Partial on
-- `linked_table IS NOT NULL` so unlinked/derived entities are unaffected. The
-- existing non-unique entities_linked_idx stays for lookup-by-link queries.
CREATE UNIQUE INDEX IF NOT EXISTS entities_linked_uniq
  ON ci.entities (owner_user_id, entity_type, linked_table, linked_id)
  WHERE linked_table IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.entities_linked_uniq;
