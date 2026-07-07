-- migrate:up
-- #1672: provenance triple on ci.position, mirroring the other bulk-ingest
-- tables (communications/content/browser_activity). Bulk importers push GPS /
-- place / photo-GPS fixes whose origin was previously untraceable once the
-- rows landed, and idempotent re-sends could only be collapsed by exact time.
--
-- NOTE ci.position is a TimescaleDB hypertable with PRIMARY KEY (time, user_id),
-- so one row per (time, user) is a PK-level invariant we do NOT relax here —
-- two distinct same-second fixes still collapse (documented limitation; a PK
-- change is a separate, data-migrating exercise). The triple makes rows
-- traceable and lets the service map same-triple re-sends onto the existing
-- row. The index is non-unique on purpose: uniqueness on a hypertable would
-- have to include the partition key (time), which would add nothing over the PK.

ALTER TABLE ci.position
  ADD COLUMN source_type TEXT,
  ADD COLUMN source_system TEXT,
  ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS position_source_triple_idx
  ON ci.position (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.position_source_triple_idx;

ALTER TABLE ci.position
  DROP COLUMN IF EXISTS source_type,
  DROP COLUMN IF EXISTS source_system,
  DROP COLUMN IF EXISTS source_id;
