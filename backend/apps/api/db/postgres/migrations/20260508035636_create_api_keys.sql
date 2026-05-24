-- migrate:up
CREATE TABLE ci.api_keys (
    id UUID PRIMARY KEY,

    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hashed_key TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,

    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user_id ON ci.api_keys(user_id);
CREATE UNIQUE INDEX idx_api_keys_hashed_key ON ci.api_keys(hashed_key);

-- migrate:down
DROP TABLE IF EXISTS ci.api_keys;
