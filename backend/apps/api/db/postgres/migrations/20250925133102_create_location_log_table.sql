-- migrate:up
CREATE TABLE location_logs (
    id UUID PRIMARY KEY,
    content JSONB,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down
DROP TABLE location_logs;
