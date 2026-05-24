-- migrate:up
ALTER TABLE ci.sessions
    ADD COLUMN previous_token TEXT,
    ADD COLUMN rotated_at TIMESTAMPTZ;

-- migrate:down
ALTER TABLE ci.sessions
    DROP COLUMN IF EXISTS previous_token,
    DROP COLUMN IF EXISTS rotated_at;
