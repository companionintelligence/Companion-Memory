-- migrate:up
CREATE TABLE api_logs (
    id UUID PRIMARY KEY,

    content TEXT,
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down
DROP TABLE api_logs;
