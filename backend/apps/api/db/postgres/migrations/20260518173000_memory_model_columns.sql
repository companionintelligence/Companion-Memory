-- migrate:up

-- Plan 03: lift the flat graph into an episodic / semantic / procedural memory
-- model with importance, decay, valence, confidence, recall tracking, and
-- temporal anchoring. Only the columns + indexes; retrieval-time ranking and
-- the consolidation worker land in follow-up commits.

ALTER TABLE ci.entities
  ADD COLUMN memory_kind TEXT NOT NULL DEFAULT 'other'
    CHECK (memory_kind IN ('episodic','semantic','procedural','reflective','meta','other')),
  ADD COLUMN importance REAL NOT NULL DEFAULT 0.5,
  ADD COLUMN decay_rate REAL NOT NULL DEFAULT 0,
  ADD COLUMN valence REAL NOT NULL DEFAULT 0,
  ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5,
  ADD COLUMN last_recalled_at TIMESTAMPTZ,
  ADD COLUMN recall_count INT NOT NULL DEFAULT 0,
  ADD COLUMN occurred_at TIMESTAMPTZ,
  ADD COLUMN time_range TSTZRANGE;

CREATE INDEX idx_entities_memory_kind ON ci.entities(memory_kind);
CREATE INDEX idx_entities_occurred_at
  ON ci.entities(occurred_at)
  WHERE memory_kind = 'episodic';
CREATE INDEX idx_entities_time_range_gist
  ON ci.entities USING gist(time_range)
  WHERE time_range IS NOT NULL;
CREATE INDEX idx_entities_importance
  ON ci.entities(importance DESC)
  WHERE importance > 0.5;
CREATE INDEX idx_entities_last_recalled
  ON ci.entities(last_recalled_at DESC)
  WHERE last_recalled_at IS NOT NULL;

-- Heuristic backfill of memory_kind from entity_type. Conservative — anything
-- we are not sure of stays 'other' so the consolidation worker can re-classify
-- later. Mirrors the rule of thumb in docs/architecture/Database.md.
UPDATE ci.entities SET memory_kind = 'episodic'
  WHERE memory_kind = 'other'
    AND entity_type IN ('Event','Activity','Message','Communication','Capture','Recording');

UPDATE ci.entities SET memory_kind = 'semantic'
  WHERE memory_kind = 'other'
    AND entity_type IN ('Person','Concept','Location','Place','Object','Item','Preference','Goal');

UPDATE ci.entities SET memory_kind = 'procedural'
  WHERE memory_kind = 'other'
    AND entity_type IN ('Routine','Habit','Workflow');

UPDATE ci.entities SET memory_kind = 'reflective'
  WHERE memory_kind = 'other'
    AND entity_type IN ('Reflection','Insight','Observation');

UPDATE ci.entities SET memory_kind = 'meta'
  WHERE memory_kind = 'other'
    AND entity_type IN ('HourlySummary','DailySummary','WeeklySummary','Summary');

-- migrate:down

DROP INDEX IF EXISTS ci.idx_entities_last_recalled;
DROP INDEX IF EXISTS ci.idx_entities_importance;
DROP INDEX IF EXISTS ci.idx_entities_time_range_gist;
DROP INDEX IF EXISTS ci.idx_entities_occurred_at;
DROP INDEX IF EXISTS ci.idx_entities_memory_kind;

ALTER TABLE ci.entities
  DROP COLUMN IF EXISTS time_range,
  DROP COLUMN IF EXISTS occurred_at,
  DROP COLUMN IF EXISTS recall_count,
  DROP COLUMN IF EXISTS last_recalled_at,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS valence,
  DROP COLUMN IF EXISTS decay_rate,
  DROP COLUMN IF EXISTS importance,
  DROP COLUMN IF EXISTS memory_kind;
