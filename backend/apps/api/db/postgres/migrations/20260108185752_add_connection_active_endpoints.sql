-- migrate:up
ALTER TABLE ci.connections ADD COLUMN active_endpoints JSONB DEFAULT '[]'::jsonb;

-- migrate:down
ALTER TABLE ci.connections DROP COLUMN active_endpoints;
