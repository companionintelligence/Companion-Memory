-- migrate:up
ALTER TABLE ci.communications ADD COLUMN preview TEXT;

-- migrate:down
ALTER TABLE ci.communications DROP COLUMN preview;
