-- migrate:up
ALTER TABLE communications ADD COLUMN id UUID;
UPDATE communications SET id = gen_uuid_v7();

-- migrate:down
ALTER TABLE communications DROP COLUMN id;
