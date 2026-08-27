-- migrate:up

-- Supports the retention sweep (AgentMemoryRetentionService.sweep), whose two
-- statements are `processed_at < $cutoff` — a batched SELECT of expiry
-- candidates and a COUNT of the remaining backlog.
--
-- The table's existing indexes cannot serve those: idx_agent_memories_unprocessed
-- is partial on `processed_at IS NULL` (the exact complement of what the sweep
-- reads) and idx_agent_memories_session keys on session_id. Without this index
-- the nightly sweep is a full scan of every fragment the appliance has ever
-- kept, which is the population the sweep exists to bound.
--
-- Partial on IS NOT NULL rather than a plain index on the column: unprocessed
-- rows are never retention candidates (`processed_at < x` is NULL-false, and
-- deleting an unprocessed fragment would destroy the only copy of text nothing
-- has promoted into the graph yet), so indexing them would only widen the index
-- with rows no sweep query can match.
CREATE INDEX IF NOT EXISTS idx_agent_memories_processed
  ON ci.agent_memories (processed_at)
  WHERE processed_at IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS ci.idx_agent_memories_processed;
