-- migrate:up
-- OpenClaw dispatch: thread kind, message source, and the job+packet row.
--
-- kind=dispatch threads stay in the Chat list but must never run ChatTurnService
-- / Ollama. source marks who wrote a bubble (openclaw | memory | user) so the
-- Chat UI can claw-mark OpenClaw turns. The job table is Memory's ownership of
-- the dispatch: packet snapshot, stop counters, and the thread/task link.

ALTER TABLE ci.threads
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';

ALTER TABLE ci.messages
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'memory';

ALTER TABLE ci.threads
    DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE ci.threads
    ADD CONSTRAINT threads_kind_check CHECK (kind IN ('chat', 'dispatch'));

ALTER TABLE ci.messages
    DROP CONSTRAINT IF EXISTS messages_source_check;
ALTER TABLE ci.messages
    ADD CONSTRAINT messages_source_check CHECK (source IN ('openclaw', 'memory', 'user'));

CREATE TABLE IF NOT EXISTS ci.agent_jobs (
    id            uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id       uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    task_id       uuid REFERENCES ci.tasks(id) ON DELETE SET NULL,
    thread_id     uuid NOT NULL,
    harness_id    text NOT NULL DEFAULT 'openclaw',
    packet_mode   text NOT NULL DEFAULT 'both',
    packet        jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'queued',
    fail_step     text,
    fail_count    int NOT NULL DEFAULT 0,
    result        jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,

    CONSTRAINT agent_jobs_status CHECK (
        status IN ('queued', 'running', 'blocked', 'completed', 'failed')
    ),
    CONSTRAINT agent_jobs_packet_mode CHECK (
        packet_mode IN ('details', 'intents', 'both')
    ),
    CONSTRAINT agent_jobs_harness CHECK (harness_id IN ('openclaw'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_thread_idx
    ON ci.agent_jobs (thread_id);

CREATE INDEX IF NOT EXISTS agent_jobs_user_status_idx
    ON ci.agent_jobs (user_id, status, created_at DESC);

COMMENT ON TABLE ci.agent_jobs IS
  'Memory-owned OpenClaw dispatch: packet snapshot, thread, optional delegated task, and the stop counters. OpenClaw fetches the packet and POSTs checkpoints; Memory owns the row.';

-- migrate:down
DROP INDEX IF EXISTS ci.agent_jobs_user_status_idx;
DROP INDEX IF EXISTS ci.agent_jobs_thread_idx;
DROP TABLE IF EXISTS ci.agent_jobs;

ALTER TABLE ci.messages DROP CONSTRAINT IF EXISTS messages_source_check;
ALTER TABLE ci.threads DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE ci.messages DROP COLUMN IF EXISTS source;
ALTER TABLE ci.threads DROP COLUMN IF EXISTS kind;
