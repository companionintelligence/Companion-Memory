-- migrate:up
-- =================================================================
-- ENTITY MUTATIONS - app-written auditable trail (no trigger writers)
-- =================================================================
-- Replaces reliance on ci.graph_deltas DB triggers as the source of truth
-- for "what changed in the graph". Services append rows in the same
-- transaction as domain writes; pg-boss consumers replay / rebuild.
--
-- Trigger writers on graph_deltas are retired in a follow-up once readers
-- (insights, LifeContext) cut over. See CI-Server#1941.

CREATE TABLE ci.entity_mutations (
  mutation_id     uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  user_id         uuid REFERENCES ci.users(id) ON DELETE SET NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  aggregate_kind  text NOT NULL
    CHECK (aggregate_kind IN ('entity', 'relationship')),
  aggregate_id    uuid NOT NULL,
  entity_type     text,
  relationship_type text,
  op              text NOT NULL
    CHECK (op IN ('insert', 'update', 'delete', 'merge')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  causation       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX entity_mutations_user_occurred_idx
  ON ci.entity_mutations (user_id, occurred_at DESC);

CREATE INDEX entity_mutations_aggregate_idx
  ON ci.entity_mutations (aggregate_kind, aggregate_id, occurred_at DESC);

COMMENT ON TABLE ci.entity_mutations IS
  'Append-only app-written mutation trail for CTI/graph aggregates; replayable via pg-boss. Not written by DB triggers.';

-- migrate:down
DROP TABLE IF EXISTS ci.entity_mutations;
