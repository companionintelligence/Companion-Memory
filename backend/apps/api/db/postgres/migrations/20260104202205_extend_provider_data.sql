-- migrate:up
ALTER TABLE ci.providers ADD COLUMN description TEXT;
ALTER TABLE ci.providers ADD COLUMN logo_url TEXT;
ALTER TABLE ci.providers ADD COLUMN endpoints JSONB DEFAULT '[]'::jsonb;
ALTER TABLE ci.providers ADD COLUMN theme JSONB NOT NULL DEFAULT '{}'::jsonb;

-- migrate:down
ALTER TABLE ci.providers DROP COLUMN description;
ALTER TABLE ci.providers DROP COLUMN logo_url;
ALTER TABLE ci.providers DROP COLUMN endpoints;
ALTER TABLE ci.providers DROP COLUMN theme;
