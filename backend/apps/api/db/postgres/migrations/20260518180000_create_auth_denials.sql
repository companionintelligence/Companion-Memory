-- migrate:up

-- Plan 07 §3.4 — record every authorization denial so the SPA can show
-- "what was rejected and why" and external reviewers can audit
-- least-privilege behavior. Writes come from ScopesGuard, the MCP
-- scope/owner-binding paths, and (later) the policy enforcement layer
-- in plan 09.

CREATE TABLE ci.auth_denials (
    id UUID PRIMARY KEY,
    actor_id UUID REFERENCES ci.actors(id) ON DELETE SET NULL,
    api_key_id UUID REFERENCES ci.api_keys(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK (reason IN ('insufficient_scope','owner_mismatch','revoked','expired','policy','rate_limit')),
    required_scopes TEXT[] NOT NULL DEFAULT '{}',
    granted_scopes TEXT[] NOT NULL DEFAULT '{}',
    route TEXT,                       -- e.g. POST /mcp, query: getEntity
    tool_name TEXT,
    extra JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auth_denials_actor ON ci.auth_denials(actor_id, created_at DESC);
CREATE INDEX idx_auth_denials_reason ON ci.auth_denials(reason, created_at DESC);
CREATE INDEX idx_auth_denials_tool ON ci.auth_denials(tool_name) WHERE tool_name IS NOT NULL;

-- migrate:down

DROP TABLE IF EXISTS ci.auth_denials;
