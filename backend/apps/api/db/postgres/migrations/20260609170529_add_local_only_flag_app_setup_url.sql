-- migrate:up
ALTER TABLE ci.providers ADD COLUMN IF NOT EXISTS local_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ci.providers ADD COLUMN IF NOT EXISTS app_setup_url TEXT;

-- migrate:down
ALTER TABLE ci.providers DROP COLUMN local_only;
ALTER TABLE ci.providers DROP COLUMN app_setup_url;
