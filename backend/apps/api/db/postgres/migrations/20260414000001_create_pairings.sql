-- migrate:up
CREATE TABLE ci.pairings (
    id UUID PRIMARY KEY,
    pairing_token TEXT UNIQUE NOT NULL,
    poll_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    user_id UUID REFERENCES ci.users(id),
    device_id TEXT,
    access_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- migrate:down
DROP TABLE ci.pairings;
