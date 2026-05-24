-- migrate:up
ALTER TABLE ci.connections ADD COLUMN needs_reauth BOOLEAN NOT NULL DEFAULT FALSE;

-- migrate:down
ALTER TABLE ci.connections DROP COLUMN needs_reauth;
