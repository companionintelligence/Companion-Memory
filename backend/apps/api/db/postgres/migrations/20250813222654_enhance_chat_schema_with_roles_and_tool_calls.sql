-- migrate:up
ALTER TABLE messages
    ADD COLUMN role TEXT,
    ADD COLUMN tool_calls JSONB;

-- migrate:down
ALTER TABLE messages
    DROP COLUMN tool_calls,
    DROP COLUMN role;
