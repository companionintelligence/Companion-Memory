-- migrate:up
CREATE TABLE ci.saved_searches (
    id UUID PRIMARY KEY NOT NULL,
    user_id UUID NOT NULL REFERENCES ci.users(id),
    name TEXT,
    description TEXT,
    query TEXT,
    entity_types TEXT[],
    tags uuid[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down
DROP TABLE IF EXISTS ci.saved_searches
