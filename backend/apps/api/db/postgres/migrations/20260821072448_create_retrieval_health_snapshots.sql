-- migrate:up
-- Nightly retrieval-health trend, one row per (run, search entity_type).
--
-- The appliance had ~43 crons for DOING and none for KNOWING: nothing measured
-- whether the derivation layer's producers actually produced. The coverage
-- holes PR #1605 found (content 0/366,862, event 2,743/42,376 = 6.5%) were
-- found BY HAND, because EmbedCoverageTelemetryService's only caller was an
-- HTTP route waiting for a metrics scraper that does not exist on an appliance.
--
-- A cron that only logs is another thing nobody reads, so the measurement is
-- persisted: "is content covered today" is answerable from the log stream, but
-- "did content stop being covered this week" needs yesterday's number, and a
-- week-over-week regression is the signal an operator can act on. Retention is
-- bounded by the same cron (RETENTION_DAYS in RetrievalHealthService).
--
-- BOTH index tables are counted, not just embeddings. `ci_search.vectors` is
-- the search CANDIDATE source and `ci_search.embeddings` only re-ranks, so a
-- type can read "healthy" on embeddings while being invisible to search — and
-- the backfill anti-joins on embeddings, which means filling embeddings alone
-- LOCKS the invisibility in. `vector_count` diverging from `embedded_count` is
-- therefore its own alert condition, not a rounding detail.
CREATE TABLE IF NOT EXISTS ci.retrieval_health_snapshots (
    id              uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    -- Shared by every row of one cron tick, so a run is addressable as a unit.
    run_id          uuid NOT NULL,
    captured_at     timestamptz NOT NULL DEFAULT now(),
    -- One of INDEXABLE_ENTITIES (domains/search-next/types.ts). Not a FK and not
    -- a CHECK: the vocabulary is a code constant, so adding a type is a code
    -- change and not a migration.
    entity_type     text NOT NULL,
    -- Source rows for the type, with ENTITY_SOURCE_MAP's discriminator applied.
    source_total    bigint NOT NULL,
    -- ci_search.embeddings rows (the re-rank / boost side).
    embedded_count  bigint NOT NULL,
    -- ci_search.vectors rows (the candidate side — what search can actually find).
    vector_count    bigint NOT NULL,
    embed_ratio     double precision NOT NULL,
    vector_ratio    double precision NOT NULL,
    -- Source rows exist but embedded_count is 0.
    embed_alarm     boolean NOT NULL DEFAULT false,
    -- Source rows exist but vector_count is 0 — invisible to search.
    vector_alarm    boolean NOT NULL DEFAULT false,
    -- embed_ratio below the coverage target (UNDER_COVERAGE_THRESHOLD).
    under_threshold boolean NOT NULL DEFAULT false,
    -- embedded_count and vector_count disagree by more than the divergence
    -- tolerance: one half of the index is ahead of the other.
    divergent       boolean NOT NULL DEFAULT false,
    -- One measurement per type per run; a retried tick cannot double-count.
    UNIQUE (run_id, entity_type)
);

-- The only read shapes: "latest per type" and "the baseline ~7 days back",
-- both of which are a backwards scan within one entity_type.
CREATE INDEX IF NOT EXISTS retrieval_health_snapshots_type_time_idx
    ON ci.retrieval_health_snapshots (entity_type, captured_at DESC);

-- Retention prune deletes by age across all types.
CREATE INDEX IF NOT EXISTS retrieval_health_snapshots_captured_at_idx
    ON ci.retrieval_health_snapshots (captured_at);

-- migrate:down
DROP TABLE IF EXISTS ci.retrieval_health_snapshots;
