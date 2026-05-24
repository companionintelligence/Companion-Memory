-- migrate:up
ALTER TABLE ci.relationships DROP CONSTRAINT relationships_from_entity_id_fkey;
ALTER TABLE ci.relationships DROP CONSTRAINT relationships_to_entity_id_fkey;

-- migrate:down
ALTER TABLE ci.relationships ADD CONSTRAINT relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES ci.entities(id) ON DELETE CASCADE;
ALTER TABLE ci.relationships ADD CONSTRAINT relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES ci.entities(id) ON DELETE CASCADE;
