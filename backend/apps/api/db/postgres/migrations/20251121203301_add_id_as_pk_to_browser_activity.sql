-- migrate:up
ALTER TABLE browser_activity ADD COLUMN id UUID DEFAULT gen_uuid_v7();

-- migrate:down
ALTER TABLE browser_activity DROP COLUMN id;
