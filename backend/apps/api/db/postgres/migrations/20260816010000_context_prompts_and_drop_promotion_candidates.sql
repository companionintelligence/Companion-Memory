-- migrate:up

CREATE TABLE ci.context_prompts (
    context_prompt_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    selector JSONB NOT NULL DEFAULT '{}',
    source JSONB NOT NULL DEFAULT '{}',
    response JSONB,
    write_plan JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT context_prompts_status_check CHECK (
        status IN ('pending', 'answered', 'skipped', 'written', 'failed')
    )
);

CREATE UNIQUE INDEX context_prompts_one_pending_per_user
    ON ci.context_prompts (user_id)
    WHERE status = 'pending';

CREATE INDEX idx_context_prompts_user_status
    ON ci.context_prompts (user_id, status, created_at DESC);

DELETE FROM ci.feed_queue WHERE item_type = 'promotion_review';

ALTER TABLE ci.feed_queue
    DROP CONSTRAINT IF EXISTS feed_queue_item_type_check;

ALTER TABLE ci.feed_queue
    DROP CONSTRAINT IF EXISTS feed_queue_item_reference_check;

ALTER TABLE ci.feed_queue
    ADD CONSTRAINT feed_queue_item_reference_check
        CHECK (
            (item_type = 'action' AND action_id IS NOT NULL AND summary_id IS NULL AND question_id IS NULL)
            OR (item_type = 'summary' AND summary_id IS NOT NULL AND action_id IS NULL AND question_id IS NULL)
            OR (item_type = 'question' AND question_id IS NOT NULL AND action_id IS NULL AND summary_id IS NULL)
        );

ALTER TABLE ci.feed_queue
    ADD CONSTRAINT feed_queue_item_type_check
        CHECK (item_type IN ('action', 'summary', 'question'));

DROP TABLE IF EXISTS ci.promotion_candidates;

-- migrate:down

CREATE TABLE ci.promotion_candidates (
    promotion_candidate_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    source_job TEXT,
    requires_user_input BOOLEAN NOT NULL DEFAULT TRUE,
    review_prompt TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT promotion_candidates_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT promotion_candidates_kind_check CHECK (kind IN ('relationship', 'entity', 'schedule_accept', 'inferred_fact'))
);

ALTER TABLE ci.feed_queue
    DROP CONSTRAINT IF EXISTS feed_queue_item_type_check;

ALTER TABLE ci.feed_queue
    DROP CONSTRAINT IF EXISTS feed_queue_item_reference_check;

ALTER TABLE ci.feed_queue
    ADD CONSTRAINT feed_queue_item_reference_check
        CHECK (
            (item_type = 'action' AND action_id IS NOT NULL AND summary_id IS NULL AND question_id IS NULL)
            OR (item_type = 'summary' AND summary_id IS NOT NULL AND action_id IS NULL AND question_id IS NULL)
            OR (item_type = 'question' AND question_id IS NOT NULL AND action_id IS NULL AND summary_id IS NULL)
            OR (item_type = 'promotion_review' AND action_id IS NULL AND summary_id IS NULL AND question_id IS NULL)
        );

ALTER TABLE ci.feed_queue
    ADD CONSTRAINT feed_queue_item_type_check
        CHECK (item_type IN ('action', 'summary', 'question', 'promotion_review'));

DROP TABLE IF EXISTS ci.context_prompts;
