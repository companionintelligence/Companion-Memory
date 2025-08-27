-- migrate:up
ALTER TABLE actions ADD COLUMN image_url TEXT;

-- migrate:down
ALTER TABLE actions DROP COLUMN image_url;
