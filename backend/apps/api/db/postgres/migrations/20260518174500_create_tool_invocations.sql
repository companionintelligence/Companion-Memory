-- migrate:up

-- Plan 06 §3.4 — log every tool execution for audit, drift tracking, and the
-- memory eval harness. One row per attempt (including denials and errors).

CREATE TABLE ci.tool_invocations (
    id UUID PRIMARY KEY,
    actor_id UUID REFERENCES ci.actors(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    provider TEXT,
    args JSONB,
    result JSONB,
    status TEXT NOT NULL CHECK (status IN ('ok','error','denied','confirmed')),
    required_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_by UUID REFERENCES ci.actors(id) ON DELETE SET NULL,
    latency_ms INT,
    skill_invocation_id UUID REFERENCES ci.skill_invocations(id) ON DELETE SET NULL,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tool_invocations_actor ON ci.tool_invocations(actor_id, created_at DESC);
CREATE INDEX idx_tool_invocations_tool ON ci.tool_invocations(tool_name, created_at DESC);
CREATE INDEX idx_tool_invocations_skill ON ci.tool_invocations(skill_invocation_id) WHERE skill_invocation_id IS NOT NULL;
CREATE INDEX idx_tool_invocations_status ON ci.tool_invocations(status) WHERE status != 'ok';

-- migrate:down

DROP TABLE IF EXISTS ci.tool_invocations;
