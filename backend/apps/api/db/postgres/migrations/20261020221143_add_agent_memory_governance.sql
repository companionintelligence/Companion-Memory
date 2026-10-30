-- migrate:up
-- Governed memory lifecycle columns for ci.agent_memories (knowl pattern):
-- typed atom category, lifecycle status (active / superseded / conflicted),
-- superseding atom pointer, and explicit temporal validity bounds.

ALTER TABLE ci.agent_memories
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'fact',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS superseded_by_id UUID NULL REFERENCES ci.agent_memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ NULL;

ALTER TABLE ci.agent_memories
  ADD CONSTRAINT agent_memories_category_chk CHECK (
    category IN (
      'fact',
      'decision',
      'goal',
      'constraint',
      'architecture',
      'state',
      'preference',
      'observation'
    )
  ),
  ADD CONSTRAINT agent_memories_status_chk CHECK (
    status IN ('active', 'superseded', 'conflicted')
  );

CREATE INDEX IF NOT EXISTS idx_agent_memories_user_status_category
  ON ci.agent_memories (user_id, status, category);

-- migrate:down

DROP INDEX IF EXISTS ci.idx_agent_memories_user_status_category;

ALTER TABLE ci.agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_status_chk,
  DROP CONSTRAINT IF EXISTS agent_memories_category_chk,
  DROP COLUMN IF EXISTS valid_until,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS superseded_by_id,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS category;
