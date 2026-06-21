-- migrate:up

-- Raw memory fragments written by the AI agent (via Hermes on_memory_write).
-- Kept separate from ci.notes (user-authored notes) so the agent's memory
-- lifecycle can evolve independently.
CREATE TABLE ci.agent_memories (
  id           UUID        NOT NULL PRIMARY KEY,
  user_id      UUID        NOT NULL,
  session_id   TEXT        NULL,      -- Hermes session that produced this fragment
  source       TEXT        NULL,      -- "memory" | "user" from on_memory_write target
  title        TEXT        NULL,      -- optional short label
  content      TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NULL,      -- set by the compaction cron; NULL = unprocessed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast scan for the compaction cron: all unprocessed rows for a user, oldest first.
CREATE INDEX idx_agent_memories_unprocessed
  ON ci.agent_memories (user_id, created_at)
  WHERE processed_at IS NULL;

-- Lookup fragments by session for future turn-linking.
CREATE INDEX idx_agent_memories_session
  ON ci.agent_memories (session_id)
  WHERE session_id IS NOT NULL;

-- migrate:down

DROP TABLE IF EXISTS ci.agent_memories;
