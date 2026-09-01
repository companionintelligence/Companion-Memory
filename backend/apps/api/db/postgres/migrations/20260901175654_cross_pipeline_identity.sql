-- migrate:up

-- Cross-pipeline identity (docs/design/cross-pipeline-identity.md).
--
-- Identity is a property of the datum; provenance is a property of the
-- arrival. `source_type` (which pipeline wrote the row) leaves every unique
-- index: the arbiter becomes the identity pair `(source_system, source_id)`
-- scoped to the user, so the connection ETL and import-tools converge on ONE
-- row when they compute the same pair — which they now do, because both mint
-- the pair from the shared identity registry (domains/memory/identity/).
-- `source_type` stays as a plain provenance column.
--
-- Pre-launch: the database is wiped and re-imported around this change, so no
-- data migration accompanies the re-key. Each table keeps its existing NULLs
-- treatment and partial predicate; only `source_type` drops out of the key.

DROP INDEX IF EXISTS ci.communications_source_triple_uniq;
CREATE UNIQUE INDEX communications_source_identity_uniq
  ON ci.communications (user_id, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.events_source_triple_uniq;
CREATE UNIQUE INDEX events_source_identity_uniq
  ON ci.events (user_id, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.content_source_triple_uniq;
CREATE UNIQUE INDEX content_source_identity_uniq
  ON ci.content (user_id, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.objects_source_triple_uniq;
CREATE UNIQUE INDEX objects_source_identity_uniq
  ON ci.objects (owner_user_id, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.product_models_source_triple_uniq;
CREATE UNIQUE INDEX product_models_source_identity_uniq
  ON ci.product_models (owner_user_id, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.receipts_source_triple_uniq;
CREATE UNIQUE INDEX receipts_source_identity_uniq
  ON ci.receipts (owner_user_id, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.object_observations_source_triple_uniq;
CREATE UNIQUE INDEX object_observations_source_identity_uniq
  ON ci.object_observations (owner_user_id, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.browser_activity_source_triple_uniq;
CREATE UNIQUE INDEX browser_activity_source_identity_uniq
  ON ci.browser_activity (user_id, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- Multi-provenance ledger: one row per (record, arrival). With converged rows,
-- "which pipelines evidence this record?" is no longer answerable from the
-- record itself — and deletion keys on it (disconnect / undo-import must
-- delete only records left with zero remaining sources).
--
-- One ledger row per (record, source_type, identity pair) as stamped —
-- appended on every insert AND every dedup hit, so after importing Takeout and
-- syncing the connection,
-- sources-per-record ≈ 2 across the overlap window (the import doctor's
-- convergence metric). `import_run_id` is nullable and best-effort for now:
-- the memory services don't receive the run id yet; import-side rows are
-- identifiable by source_type until they do.
CREATE TABLE ci.record_sources (
  user_id        uuid NOT NULL,
  record_table   text NOT NULL,
  record_id      uuid NOT NULL,
  source_type    text NOT NULL,
  source_system  text NOT NULL,
  source_id      text NOT NULL,
  connection_id  uuid,
  import_run_id  uuid,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_table, source_type, source_system, source_id)
);

-- Deletion/lookup path: all sources evidencing one record.
CREATE INDEX record_sources_record_idx
  ON ci.record_sources (user_id, record_table, record_id);

-- Disconnect path: all ledger rows a connection produced.
CREATE INDEX record_sources_connection_idx
  ON ci.record_sources (connection_id)
  WHERE connection_id IS NOT NULL;

-- migrate:down

DROP TABLE IF EXISTS ci.record_sources;

DROP INDEX IF EXISTS ci.communications_source_identity_uniq;
CREATE UNIQUE INDEX communications_source_triple_uniq
  ON ci.communications (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.events_source_identity_uniq;
CREATE UNIQUE INDEX events_source_triple_uniq
  ON ci.events (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.content_source_identity_uniq;
CREATE UNIQUE INDEX content_source_triple_uniq
  ON ci.content (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.objects_source_identity_uniq;
CREATE UNIQUE INDEX objects_source_triple_uniq
  ON ci.objects (owner_user_id, source_type, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.product_models_source_identity_uniq;
CREATE UNIQUE INDEX product_models_source_triple_uniq
  ON ci.product_models (owner_user_id, source_type, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.receipts_source_identity_uniq;
CREATE UNIQUE INDEX receipts_source_triple_uniq
  ON ci.receipts (owner_user_id, source_type, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.object_observations_source_identity_uniq;
CREATE UNIQUE INDEX object_observations_source_triple_uniq
  ON ci.object_observations (owner_user_id, source_type, source_system, source_id)
  NULLS NOT DISTINCT
  WHERE source_id IS NOT NULL;

DROP INDEX IF EXISTS ci.browser_activity_source_identity_uniq;
CREATE UNIQUE INDEX browser_activity_source_triple_uniq
  ON ci.browser_activity (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
