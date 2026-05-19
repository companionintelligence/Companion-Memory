-- migrate:up

-- Plan 10: actors are the access unit. Today a user has one actor of kind
-- 'user'; tomorrow agents (Claude Code, Cowork, OpenClaw, Codex), devices,
-- and households are also first-class actors. All writes carry created_by_actor;
-- all reads filter on actor access.

CREATE TABLE ci.actors (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user','agent','device','household')),
    parent_user_id UUID REFERENCES ci.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_actors_parent_user ON ci.actors(parent_user_id);
CREATE INDEX idx_actors_kind ON ci.actors(kind);

-- Backfill: one user-kind actor per existing user, with the same UUID.
-- This makes existing api_keys.user_id valid as actor_id without rewriting.
INSERT INTO ci.actors (id, kind, parent_user_id, display_name)
SELECT
    id,
    'user',
    id,
    COALESCE(NULLIF(name, ''), email, id::text)
FROM ci.users
ON CONFLICT (id) DO NOTHING;

-- Add actor_id to api_keys; backfill from user_id (matches the actor backfill
-- above 1:1). Nullable initially, then NOT NULL after backfill.
ALTER TABLE ci.api_keys ADD COLUMN actor_id UUID REFERENCES ci.actors(id) ON DELETE CASCADE;

UPDATE ci.api_keys SET actor_id = user_id WHERE actor_id IS NULL;

ALTER TABLE ci.api_keys ALTER COLUMN actor_id SET NOT NULL;

CREATE INDEX idx_api_keys_actor_id ON ci.api_keys(actor_id);

-- migrate:down

ALTER TABLE ci.api_keys DROP COLUMN IF EXISTS actor_id;
DROP TABLE IF EXISTS ci.actors;
