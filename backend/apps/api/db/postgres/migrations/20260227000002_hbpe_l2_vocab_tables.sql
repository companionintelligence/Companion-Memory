-- migrate:up

-- CI-HBPE-SPEC-001 §3.2 + §6.1 — L2 vocabulary tables and content context
--
-- L2 centroids are stored as VECTOR(768) via pgvector (already enabled).
-- Insert: %s::vector   Read: centroid::text → np.fromstring(s.strip('[]'), sep=',')

-- Content context — associates each content item with its (L0, L1) context
-- inferred from temporal co-occurrence with calendar events (§6.1).
-- Join window: ± 30 minutes around content timestamp.
-- Default when no event found: l0_class='LEISURE', l1_cluster_id=NULL.
CREATE TABLE ci.content_context (
    content_id      UUID PRIMARY KEY REFERENCES ci.content(id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL DEFAULT 'LEISURE',
    l1_cluster_id   UUID REFERENCES ci.l1_clusters(cluster_id),   -- NULL → LEISURE_GENERAL placeholder
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.content_context (user_id, l0_class, l1_cluster_id);

-- L2 cluster registry (one set per user per (L0 class, L1 cluster) pair)
CREATE TABLE ci.l2_clusters (
    cluster_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    l1_cluster_id   UUID NOT NULL REFERENCES ci.l1_clusters(cluster_id),
    label           TEXT NOT NULL,           -- TOPIC_TRADING | TOPIC_PLASMA_PHYSICS | ...
    display_name    TEXT NOT NULL,
    keywords        TEXT[],
    centroid        VECTOR(768) NOT NULL,    -- mean of member content embeddings
    member_count    INTEGER NOT NULL DEFAULT 0,
    naming_method   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.l2_clusters (user_id, l0_class, l1_cluster_id, is_active);

-- Maps content items to their assigned L2 cluster
CREATE TABLE ci.l2_content_cluster (
    content_id      UUID PRIMARY KEY REFERENCES ci.content(id),
    cluster_id      UUID NOT NULL REFERENCES ci.l2_clusters(cluster_id),
    similarity      FLOAT NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON ci.l2_content_cluster (cluster_id);

-- L2 pending pool — content items awaiting rediscovery, keyed per (L0, L1) pair
CREATE TABLE ci.l2_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id      UUID NOT NULL REFERENCES ci.content(id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    l1_cluster_id   UUID REFERENCES ci.l1_clusters(cluster_id),   -- NULL if L1 not yet assigned
    embedding       VECTOR(768) NOT NULL,
    max_similarity  FLOAT NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_id)
);

CREATE INDEX ON ci.l2_pending_pool (user_id, l0_class, l1_cluster_id, added_at);

-- migrate:down

DROP INDEX IF EXISTS ci.l2_pending_pool_user_id_l0_class_l1_cluster_id_added_at_idx;
DROP TABLE IF EXISTS ci.l2_pending_pool;
DROP INDEX IF EXISTS ci.l2_content_cluster_cluster_id_idx;
DROP TABLE IF EXISTS ci.l2_content_cluster;
DROP INDEX IF EXISTS ci.l2_clusters_user_id_l0_class_l1_cluster_id_is_active_idx;
DROP TABLE IF EXISTS ci.l2_clusters;
DROP INDEX IF EXISTS ci.content_context_user_id_l0_class_l1_cluster_id_idx;
DROP TABLE IF EXISTS ci.content_context;
