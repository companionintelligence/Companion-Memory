-- migrate:up

-- CI-HBPE-SPEC-001 §3.1 — L1 vocabulary tables
-- Amended: see HBPE_Spec_Amendments.md §Amendment 1
--
-- L1 centroids are stored as FLOAT8[] (plain Postgres array), NOT VECTOR(768).
-- Feature space: 391-dim (7 scalar + 384 title embedding).
-- Clustering uses UMAP(10-dim, cosine) → HDBSCAN(euclidean) but centroids are
-- stored in the original 391-dim space for cosine routing without re-running UMAP.
-- Cosine similarity is computed in Python (numpy).

-- L1 cluster registry (one set per user per L0 class)
CREATE TABLE ci.l1_clusters (
    cluster_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,           -- WORK | EXERCISE | SOCIAL | ERRAND | LEISURE | TRANSIT | SLEEP | UNKNOWN
    label           TEXT NOT NULL,           -- DEEP_FOCUS | MEETING | CYCLING | ...
    display_name    TEXT NOT NULL,
    keywords        TEXT[],                  -- TF-IDF top terms from event titles
    centroid        FLOAT8[] NOT NULL,       -- 391-dim (7 scalar + 384 title embedding); stored in original space, not UMAP-reduced
    member_count    INTEGER NOT NULL DEFAULT 0,
    naming_method   TEXT,                    -- ctfidf | phi3 | user
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.l1_clusters (user_id, l0_class, is_active);

-- Maps calendar events to their assigned L1 cluster
-- NOTE: ci.events PK is event_id (not id) — reference accordingly
CREATE TABLE ci.l1_event_cluster (
    event_id        UUID PRIMARY KEY REFERENCES ci.events(event_id),
    cluster_id      UUID NOT NULL REFERENCES ci.l1_clusters(cluster_id),
    similarity      FLOAT NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.l1_event_cluster (cluster_id);

-- L1 pending pool — events that did not meet the similarity threshold
-- during routing and are awaiting rediscovery
CREATE TABLE ci.l1_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES ci.events(event_id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    feature_vec     FLOAT8[] NOT NULL,       -- 391-dim (7 scalar scaled + 384 title embedding)
    max_similarity  FLOAT NOT NULL,          -- best cosine sim seen at routing time
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id)
);

CREATE INDEX ON ci.l1_pending_pool (user_id, l0_class, added_at);

-- Shared naming audit log for both L1 and L2 cluster naming decisions
CREATE TABLE ci.vocab_naming_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level           TEXT NOT NULL CHECK (level IN ('l1', 'l2')),
    cluster_id      UUID NOT NULL,
    method          TEXT NOT NULL CHECK (method IN ('ctfidf', 'phi3', 'user')),
    input_keywords  TEXT[],
    proposed_label  TEXT,
    final_label     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.vocab_naming_log (cluster_id, created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS ci.vocab_naming_log_cluster_id_created_at_idx;
DROP TABLE IF EXISTS ci.vocab_naming_log;
DROP INDEX IF EXISTS ci.l1_pending_pool_user_id_l0_class_added_at_idx;
DROP TABLE IF EXISTS ci.l1_pending_pool;
DROP INDEX IF EXISTS ci.l1_event_cluster_cluster_id_idx;
DROP TABLE IF EXISTS ci.l1_event_cluster;
DROP INDEX IF EXISTS ci.l1_clusters_user_id_l0_class_is_active_idx;
DROP TABLE IF EXISTS ci.l1_clusters;
