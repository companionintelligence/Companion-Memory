-- migrate:up
--
-- Remove HDBSCAN-era tables and columns that are unreachable in the current
-- Qwen-labeling architecture (ADR-0002).
--
-- Dropped tables (never written to after ADR-0002):
--   hbpe.vocab_naming_log  — cluster naming audit log for the Phi-3/ctfidf namer (T1.3d)
--   hbpe.l1_pending_pool   — events awaiting centroid-routing rediscovery (T1.3e)
--   hbpe.l2_pending_pool   — content items awaiting centroid-routing rediscovery (T1.4d)
--
-- Dropped columns (always inserted as empty array, never queried):
--   hbpe.l1_clusters.keywords TEXT[]
--   hbpe.l2_clusters.keywords TEXT[]
--
-- Retained intentionally:
--   *.centroid      — schema placeholder for future similarity routing (ADR-0004)
--   *.naming_method — provenance metadata ('qwen' for all current rows)

DROP TABLE IF EXISTS hbpe.vocab_naming_log;
DROP TABLE IF EXISTS hbpe.l1_pending_pool;
DROP TABLE IF EXISTS hbpe.l2_pending_pool;

ALTER TABLE hbpe.l1_clusters DROP COLUMN IF EXISTS keywords;
ALTER TABLE hbpe.l2_clusters DROP COLUMN IF EXISTS keywords;

-- migrate:down

ALTER TABLE hbpe.l1_clusters ADD COLUMN IF NOT EXISTS keywords TEXT[];
ALTER TABLE hbpe.l2_clusters ADD COLUMN IF NOT EXISTS keywords TEXT[];

CREATE TABLE IF NOT EXISTS hbpe.l1_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES ci.events(event_id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    feature_vec     FLOAT8[] NOT NULL,
    max_similarity  FLOAT NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS ON hbpe.l1_pending_pool (user_id, l0_class, added_at);

CREATE TABLE IF NOT EXISTS hbpe.vocab_naming_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level           TEXT NOT NULL CHECK (level IN ('l1', 'l2')),
    cluster_id      UUID NOT NULL,
    method          TEXT NOT NULL CHECK (method IN ('ctfidf', 'LLM', 'user')),
    input_keywords  TEXT[],
    proposed_label  TEXT,
    final_label     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ON hbpe.vocab_naming_log (cluster_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hbpe.l2_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id      UUID NOT NULL REFERENCES ci.content(id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    l1_cluster_id   UUID REFERENCES hbpe.l1_clusters(cluster_id),
    embedding       VECTOR(768) NOT NULL,
    max_similarity  FLOAT NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_id)
);

CREATE INDEX IF NOT EXISTS ON hbpe.l2_pending_pool (user_id, l0_class, l1_cluster_id, added_at);
