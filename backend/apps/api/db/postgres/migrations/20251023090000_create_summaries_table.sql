-- migrate:up
-- =================================================================
-- SUMMARIES TABLE
-- =================================================================
-- Multi-scale temporal summaries (hourly → yearly) from CompInt agents

CREATE TABLE summaries (
    summary_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES ci_core.users(id) ON DELETE CASCADE,

    -- Period metadata
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    period_type TEXT NOT NULL CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly', 'seasonal', 'yearly')),
    timezone TEXT DEFAULT 'UTC',

    -- Provenance and scope
    source_types TEXT[] NOT NULL, -- e.g. {'browser_history','communications'}
    title TEXT,

    -- Content and structure
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    structured_context JSONB DEFAULT '{}'::jsonb,
    tags JSONB DEFAULT '{}',
    participants UUID[], -- Entity IDs for people/services involved
    related_goal_ids UUID[],
    related_activity_ids UUID[],
    related_habits_ids UUID[],
    related_entities_ids UUID[], -- for non-people entities
    related_documents_ids UUID[],
    related_communications_ids UUID[],
    related_files_ids UUID[],
    related_events_ids UUID[],

    -- Quality and embeddings
    confidence_score DOUBLE PRECISION DEFAULT 1.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
    summary_embedding vector(768),
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX summaries_user_period_idx ON summaries(user_id, period_type, period_start DESC);
CREATE INDEX summaries_user_end_idx ON summaries(user_id, period_end DESC);
CREATE INDEX summaries_tags_idx ON summaries USING GIN (tags) WHERE tags IS NOT NULL;
CREATE INDEX summaries_participants_idx ON summaries USING GIN (participants) WHERE participants IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS summaries_participants_idx;
DROP INDEX IF EXISTS summaries_tags_idx;
DROP INDEX IF EXISTS summaries_user_end_idx;
DROP INDEX IF EXISTS summaries_user_period_idx;

DROP TABLE IF EXISTS summaries;
