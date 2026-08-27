-- migrate:up
-- Retire ci.event_analytics. It has never had a writer or a reader.
--
-- History:
--   20260621005811 added salience / access_count / last_accessed to ci.events as
--     "retrieval ranking inputs ... managed by enrichment + reads". The enrichment
--     writer and the ranking reader were never built.
--   20260808150100 (schema consolidation) moved salience, access_count and five
--     older dead columns (prediction_model, productivity_impact, related_event_ids,
--     supersedes_event_id, last_synced_at) off the hot ci.events row into this
--     1:1 side table. That relocated the dead columns; it did not revive them.
--
-- As of this migration the only references to `ci.event_analytics` anywhere in the
-- repository are SQL in those two migrations, a comment on EventEntity, and prose
-- in docs/. No entity, service, resolver, repository query, seed script, PowerSync
-- sync rule or Python sidecar (backend/apps/{hbpe,summary}) touches it. Every row
-- therefore still holds the column defaults (salience 1.0, access_count 0, the rest
-- NULL) copied over from ci.events at consolidation time.
--
-- Why retire rather than wire: salience needs an access signal to be anything other
-- than a rename of start_time. ci.events.last_accessed has no writer either, and
-- ci.api_logs is the provider-sync log, not a retrieval log (see
-- docs/jobs-schedule-review.md item 11). A table with a schema and no model misleads
-- reviewers into thinking salience is modelled. When a real retrieval signal exists,
-- the table it needs should be designed for that model, not inherited from these
-- seven columns.
--
-- ci.events.last_accessed and ci.events.sharing_level are deliberately untouched:
-- sharing_level is live (consent scope, read on every egress) and last_accessed is
-- the read-path touch slot, which stays on the hot row.
--
-- Nothing depends on this table: it is a leaf. Its only FK is outbound
-- (event_id -> ci.events ON DELETE CASCADE), and no other table, view, matview or
-- index references it.
DROP TABLE IF EXISTS ci.event_analytics;

-- migrate:down
-- Recreate the table with the exact DDL from 20260808150100:48-59. This is not
-- cosmetic: that migration's own migrate:down runs `UPDATE ci.events e SET ... FROM
-- ci.event_analytics a` (line 325-334), which raises 42P01 against a missing table.
-- Rolling all the way back past the consolidation therefore requires the table to be
-- present again first.
--
-- Deliberately left EMPTY rather than reseeded from ci.events. The consolidation's
-- down joins on ci.event_analytics, so an empty table leaves ci.events at the
-- defaults its own ADD COLUMN clauses supply (salience 1.0, access_count 0, the rest
-- NULL) -- byte-identical to what copying the never-written rows would have produced,
-- without a full-table INSERT over every event.
CREATE TABLE ci.event_analytics (
  event_id UUID PRIMARY KEY REFERENCES ci.events(event_id) ON DELETE CASCADE,
  salience DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  prediction_model TEXT,
  productivity_impact DOUBLE PRECISION,
  related_event_ids UUID[],
  supersedes_event_id UUID,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
