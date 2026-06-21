-- migrate:up
-- Agent-memory affordances on captured events:
--   salience / access_count / last_accessed — retrieval ranking inputs so recall
--     can weight by importance + recency+frequency (managed by enrichment + reads).
--   sharing_level — consent scope, mirroring ci.answers.sharing_level; stored raw
--     at ingest, redacted at read by consumer scope (G2 agent permissions).
-- Fact-level temporal validity is already covered by ci.relationships.start_date
-- / end_date — use those for facts that change (job, address); no new column here.
ALTER TABLE ci.events
  ADD COLUMN IF NOT EXISTS salience      double precision NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS access_count  integer          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed timestamptz,
  ADD COLUMN IF NOT EXISTS sharing_level text             NOT NULL DEFAULT 'private';

-- migrate:down
ALTER TABLE ci.events
  DROP COLUMN IF EXISTS salience,
  DROP COLUMN IF EXISTS access_count,
  DROP COLUMN IF EXISTS last_accessed,
  DROP COLUMN IF EXISTS sharing_level;
