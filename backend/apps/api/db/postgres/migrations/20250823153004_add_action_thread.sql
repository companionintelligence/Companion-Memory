-- migrate:up
ALTER TABLE actions ADD COLUMN thread_id UUID REFERENCES threads (id);

-- migrate:down
ALTER TABLE actions DROP COLUMN thread_id;
