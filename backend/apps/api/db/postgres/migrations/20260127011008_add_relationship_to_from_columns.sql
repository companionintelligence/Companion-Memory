-- migrate:up
ALTER TABLE ci.relationships ADD COLUMN to_entity_type TEXT;
ALTER TABLE ci.relationships ADD COLUMN from_entity_type TEXT;

-- migrate:down
ALTER TABLE ci.relationships DROP COLUMN from_entity_type;
ALTER TABLE ci.relationships DROP COLUMN to_entity_type;
