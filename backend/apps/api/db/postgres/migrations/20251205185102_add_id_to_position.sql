-- migrate:up
ALTER TABLE position ADD COLUMN id UUID;
UPDATE position SET id = gen_uuid_v7();

-- migrate:down
ALTER TABLE position DROP COLUMN id;
