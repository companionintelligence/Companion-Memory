-- migrate:up
ALTER TABLE ci.connections ADD COLUMN external_id TEXT;

-- migrate:down
ALTER TABLE ci.connections DROP COLUMN external_id;
