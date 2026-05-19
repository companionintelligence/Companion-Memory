-- migrate:up

-- Plan 04 §3.4 — log every LLM call routed through LlmRouter for cost
-- transparency, audit, and the eval drift dashboard.

CREATE TABLE ci.llm_invocations (
    id UUID PRIMARY KEY,
    actor_id UUID REFERENCES ci.actors(id) ON DELETE SET NULL,
    task TEXT NOT NULL CHECK (task IN ('embed','classify','summarize','chat','reflect','consolidate')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INT,
    output_tokens INT,
    latency_ms INT,
    cost_usd_micro BIGINT,             -- micro-USD (1e-6) to avoid float
    redacted BOOLEAN NOT NULL DEFAULT FALSE,
    skill_invocation_id UUID REFERENCES ci.skill_invocations(id) ON DELETE SET NULL,
    tool_invocation_id UUID REFERENCES ci.tool_invocations(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','error','aborted')),
    error_kind TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_invocations_actor ON ci.llm_invocations(actor_id, created_at DESC);
CREATE INDEX idx_llm_invocations_task ON ci.llm_invocations(task, created_at DESC);
CREATE INDEX idx_llm_invocations_provider_model ON ci.llm_invocations(provider, model, created_at DESC);
CREATE INDEX idx_llm_invocations_skill ON ci.llm_invocations(skill_invocation_id) WHERE skill_invocation_id IS NOT NULL;

-- migrate:down

DROP TABLE IF EXISTS ci.llm_invocations;
