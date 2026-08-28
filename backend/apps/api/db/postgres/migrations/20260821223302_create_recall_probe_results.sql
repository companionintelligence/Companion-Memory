-- migrate:up
-- Weekly ANN-recall measurement, one row per (run, entity_type, ef_search).
--
-- Both pgvector recall knobs on this appliance are at their defaults and never
-- had a number attached to them: a repo-wide grep for `ef_search` returns one
-- hit and it is prose in a migration comment, and `hnsw.iterative_scan` returns
-- none. Meanwhile `embeddings_embedding_hnsw_idx` indexes `embedding` ALONE
-- (migration 20260701120100), while SearchService.semanticSearch filters on
-- `user_id` and on `entity_type` OUTSIDE the ORDER BY — so the index hands back
-- its k nearest across every user and every type and the filters then cut that
-- list down. A type-filtered search can therefore return far fewer than its
-- LIMIT while the exact answer sits in the table.
--
-- That is a claim with a number, and this table is where the number lives. Each
-- row is the same production statement measured against an exact answer
-- (`enable_indexscan`/`enable_bitmapscan` off, so the planner has to scan), at
-- one `hnsw.ef_search` setting. NULL ef_search means the server default was
-- left alone — recorded as NULL rather than as 40 because the default is
-- pgvector's to change, not ours to assert.
--
-- The probe MEASURES and never tunes: nothing here is read back by search, and
-- no setting is written anywhere. Choosing an ef_search is a separate, human
-- decision that this table exists to inform.
--
-- Persisted rather than logged for the same reason as
-- ci.retrieval_health_snapshots: "what is recall today" is answerable from a
-- log line, "did recall fall when the corpus doubled" is not.
CREATE TABLE IF NOT EXISTS ci.recall_probe_results (
    id                  uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    -- Shared by every row of one cron tick, so a run is addressable as a unit.
    run_id              uuid NOT NULL,
    captured_at         timestamptz NOT NULL DEFAULT now(),
    -- Whose index was probed. Recall is a property of a filtered query, and
    -- every production query filters by user, so the measurement is per-user.
    user_id             uuid NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
    -- One of INDEXABLE_ENTITIES (domains/search-next/types.ts). Not a FK and not
    -- a CHECK: the vocabulary is a code constant, so adding a type is a code
    -- change and not a migration.
    entity_type         text NOT NULL,
    -- hnsw.ef_search for this leg; NULL = server default, left unset.
    ef_search           integer,
    -- The LIMIT recall is measured at (PROBE_K).
    k                   integer NOT NULL,
    -- Sampled query vectors that produced a usable comparison. Lower than
    -- SAMPLES_PER_TYPE when the run hit its deadline or the exact leg timed out.
    samples             integer NOT NULL,
    -- Indexed rows the type had for this user when the sample was drawn. A
    -- recall of 1.0 over a population smaller than k means nothing; this column
    -- is what stops that number being read as good news.
    population          bigint NOT NULL,
    mean_recall         double precision NOT NULL,
    min_recall          double precision NOT NULL,
    -- Samples where the ANN leg returned FEWER rows than the exact leg found —
    -- the post-filter truncation signature, and the reason this table exists.
    truncated_samples   integer NOT NULL DEFAULT 0,
    exact_timeouts      integer NOT NULL DEFAULT 0,
    ann_timeouts        integer NOT NULL DEFAULT 0,
    mean_ann_rows       double precision NOT NULL,
    mean_exact_rows     double precision NOT NULL,
    mean_ann_ms         double precision NOT NULL,
    -- One exact answer serves every ef_search leg of a sample, so this is
    -- near-identical across a run's rows and differs only where a leg lost a
    -- sample to a timeout. Repeated on each row anyway, so a row is readable on
    -- its own — which is how anybody will actually query this.
    mean_exact_ms       double precision NOT NULL,
    -- One measurement per (type, ef_search) per run; a retried tick cannot
    -- double-count. NULLS NOT DISTINCT so the server-default leg is covered too
    -- (a plain UNIQUE would let NULL ef_search rows repeat freely).
    UNIQUE NULLS NOT DISTINCT (run_id, entity_type, ef_search)
);

-- The read shape this table exists for: one type's recall over time.
CREATE INDEX IF NOT EXISTS recall_probe_results_type_time_idx
    ON ci.recall_probe_results (entity_type, captured_at DESC);

-- Retention prune deletes by age across all types.
CREATE INDEX IF NOT EXISTS recall_probe_results_captured_at_idx
    ON ci.recall_probe_results (captured_at);

-- migrate:down
DROP TABLE IF EXISTS ci.recall_probe_results;
