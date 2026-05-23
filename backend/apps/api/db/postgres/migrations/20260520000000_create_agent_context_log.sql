-- Plan: ci-memory-plan — agent memory provider context log table.
-- Stores each turn of context POSTed by Hermes / OpenClaw agents so CI can
-- persist conversation history and later surface it during retrieval.

CREATE TABLE IF NOT EXISTS ci.agent_context_log (
  id          UUID        NOT NULL PRIMARY KEY,
  session_id  TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  agent_id    TEXT,
  turn_index  INTEGER,
  messages    JSONB       NOT NULL DEFAULT '[]',
  -- Populated in v2 when the row is also stored as a memory entity.
  memory_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_context_log_user_id
  ON ci.agent_context_log (user_id);

CREATE INDEX IF NOT EXISTS idx_agent_context_log_session_id
  ON ci.agent_context_log (session_id);
