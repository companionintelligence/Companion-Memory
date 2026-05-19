-- migrate:up

-- Plan 02: agent-skills registry. CI-Server owns the user's "how I want my
-- agent to work" playbook. Skills are versioned and immutable per version;
-- installs pin to a version. The executor lands in a follow-up.

CREATE TABLE ci.skills (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('builtin','user','marketplace')),
    owner_actor_id UUID REFERENCES ci.actors(id) ON DELETE SET NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_skills_owner_actor ON ci.skills(owner_actor_id);
CREATE INDEX idx_skills_source ON ci.skills(source);

CREATE TABLE ci.skill_versions (
    id UUID PRIMARY KEY,
    skill_id UUID NOT NULL REFERENCES ci.skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    -- Full skill spec (kind, input/output schema, tools_allowed, model_policy, etc.).
    spec JSONB NOT NULL,
    instructions_md TEXT,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (skill_id, version)
);
CREATE INDEX idx_skill_versions_skill ON ci.skill_versions(skill_id, published_at DESC);

CREATE TABLE ci.user_skill_installs (
    id UUID PRIMARY KEY,
    actor_id UUID NOT NULL REFERENCES ci.actors(id) ON DELETE CASCADE,
    skill_version_id UUID NOT NULL REFERENCES ci.skill_versions(id) ON DELETE CASCADE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (actor_id, skill_version_id)
);
CREATE INDEX idx_user_skill_installs_actor ON ci.user_skill_installs(actor_id);

CREATE TABLE ci.skill_invocations (
    id UUID PRIMARY KEY,
    skill_version_id UUID NOT NULL REFERENCES ci.skill_versions(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES ci.actors(id) ON DELETE CASCADE,
    input JSONB,
    output JSONB,
    tool_trace JSONB,
    latency_ms INT,
    status TEXT NOT NULL CHECK (status IN ('ok','error','denied')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_skill_invocations_actor ON ci.skill_invocations(actor_id, created_at DESC);
CREATE INDEX idx_skill_invocations_skill_version ON ci.skill_invocations(skill_version_id, created_at DESC);

-- migrate:down

DROP TABLE IF EXISTS ci.skill_invocations;
DROP TABLE IF EXISTS ci.user_skill_installs;
DROP TABLE IF EXISTS ci.skill_versions;
DROP TABLE IF EXISTS ci.skills;
