-- migrate:up
ALTER TABLE ci.providers ADD COLUMN auth_type TEXT;
ALTER TABLE ci.providers ADD COLUMN openid_key_link TEXT;

-- migrate:down
ALTER TABLE ci.providers DROP COLUMN auth_type;
ALTER TABLE ci.providers DROP COLUMN openid_key_link;

