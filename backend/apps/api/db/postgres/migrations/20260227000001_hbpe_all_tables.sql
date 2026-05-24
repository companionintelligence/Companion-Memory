-- migrate:up
--
-- CI-HBPE-SPEC-001 — All HBPE tables in the hbpe schema.
--
-- Squashed from migrations 20260227000001 through 20260320000002.
-- Creates the hbpe schema and all HBPE-owned tables directly; no ci → hbpe ALTER
-- is needed for fresh installs.  App-owned tables (ci.events, ci.content,
-- ci.summaries, ci.users) remain in the ci schema.
--
-- L1 centroids: FLOAT8[] (391-dim, NOT pgvector) — cosine routing in Python.
-- L2 centroids: VECTOR(768) via pgvector — insert as %s::vector.
-- prediction_log: TimescaleDB hypertable on predicted_at.

CREATE SCHEMA IF NOT EXISTS hbpe;

-- ── L1 vocabulary ─────────────────────────────────────────────────────────────

-- L1 cluster registry (one set per user per L0 class)
CREATE TABLE hbpe.l1_clusters (
    cluster_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,           -- WORK | EXERCISE | SOCIAL | ERRAND | LEISURE | TRANSIT | SLEEP | UNKNOWN
    label           TEXT NOT NULL,           -- DEEP_FOCUS | MEETING | CYCLING | ...
    display_name    TEXT NOT NULL,
    keywords        TEXT[],                  -- TF-IDF top terms from event titles
    centroid        FLOAT8[],                -- 391-dim (7 scalar + 384 title embedding); NULL until first feature vector is assigned
    member_count    INTEGER NOT NULL DEFAULT 0,
    naming_method   TEXT,                    -- ctfidf | phi3| user
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.l1_clusters (user_id, l0_class, is_active);

-- Maps calendar events to their assigned L1 cluster
-- NOTE: ci.events PK is event_id (not id)
CREATE TABLE hbpe.l1_event_cluster (
    event_id        UUID PRIMARY KEY REFERENCES ci.events(event_id),
    cluster_id      UUID NOT NULL REFERENCES hbpe.l1_clusters(cluster_id),
    similarity      FLOAT NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.l1_event_cluster (cluster_id);

-- Events that did not meet the similarity threshold and are awaiting rediscovery
CREATE TABLE hbpe.l1_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES ci.events(event_id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    feature_vec     FLOAT8[] NOT NULL,       -- 391-dim (7 scalar scaled + 384 title embedding)
    max_similarity  FLOAT NOT NULL,          -- best cosine sim seen at routing time
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id)
);

CREATE INDEX ON hbpe.l1_pending_pool (user_id, l0_class, added_at);

-- Shared naming audit log for L1 and L2 cluster naming decisions
CREATE TABLE hbpe.vocab_naming_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level           TEXT NOT NULL CHECK (level IN ('l1', 'l2')),
    cluster_id      UUID NOT NULL,
    method          TEXT NOT NULL CHECK (method IN ('ctfidf', 'phi3', 'user')),
    input_keywords  TEXT[],
    proposed_label  TEXT,
    final_label     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.vocab_naming_log (cluster_id, created_at DESC);

-- ── L2 vocabulary ─────────────────────────────────────────────────────────────

-- Associates each content item with its (L0, L1) context inferred from
-- temporal co-occurrence with calendar events (±30 min window, §6.1).
-- Default when no event found: l0_class='LEISURE', l1_cluster_id=NULL.
CREATE TABLE hbpe.content_context (
    content_id      UUID PRIMARY KEY REFERENCES ci.content(id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL DEFAULT 'LEISURE',
    l1_cluster_id   UUID REFERENCES hbpe.l1_clusters(cluster_id),  -- NULL → LEISURE_GENERAL placeholder
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.content_context (user_id, l0_class, l1_cluster_id);

-- L2 cluster registry (one set per user per (L0 class, L1 cluster) pair)
CREATE TABLE hbpe.l2_clusters (
    cluster_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    l1_cluster_id   UUID NOT NULL REFERENCES hbpe.l1_clusters(cluster_id),
    label           TEXT NOT NULL,           -- TOPIC_TRADING | TOPIC_PLASMA_PHYSICS | ...
    display_name    TEXT NOT NULL,
    keywords        TEXT[],
    centroid        VECTOR(768),             -- NULL until first embedding is assigned
    member_count    INTEGER NOT NULL DEFAULT 0,
    naming_method   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, is_active);

-- Maps content items to their assigned L2 cluster
CREATE TABLE hbpe.l2_content_cluster (
    content_id      UUID PRIMARY KEY REFERENCES ci.content(id),
    cluster_id      UUID NOT NULL REFERENCES hbpe.l2_clusters(cluster_id),
    similarity      FLOAT NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON hbpe.l2_content_cluster (cluster_id);

-- Content items awaiting rediscovery, keyed per (L0, L1) pair
CREATE TABLE hbpe.l2_pending_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id      UUID NOT NULL REFERENCES ci.content(id),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    l0_class        TEXT NOT NULL,
    l1_cluster_id   UUID REFERENCES hbpe.l1_clusters(cluster_id),  -- NULL if L1 not yet assigned
    embedding       VECTOR(768) NOT NULL,
    max_similarity  FLOAT NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_id)
);

CREATE INDEX ON hbpe.l2_pending_pool (user_id, l0_class, l1_cluster_id, added_at);

-- ── Token stream ──────────────────────────────────────────────────────────────

-- Serialized [SOD]…[EOD] token stream per user-day.
CREATE TABLE hbpe.token_stream (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES ci.users(id),
    date          DATE NOT NULL,
    seq_order     SMALLINT NOT NULL,   -- row position within the day (0-based)
    bucket_idx    SMALLINT NOT NULL,   -- 0..47  (30-min bucket)
    level         TEXT NOT NULL,       -- SOD | L0 | L1 | L2 | EOD
    token_id      TEXT NOT NULL,       -- L0 class name, cluster UUID, or SOD/EOD
    soft_prob     FLOAT4[] NOT NULL,   -- similarity score(s); [1.0] for SOD/EOD/L0
    serialized_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON hbpe.token_stream (user_id, date, seq_order);
CREATE INDEX ON hbpe.token_stream (user_id, date);

-- ── Prediction log ────────────────────────────────────────────────────────────

-- Every issued forecast bucket, for retrospective accuracy measurement.
-- Actual labels are backfilled nightly by the retrospective actual fill job (T5.1).
CREATE TABLE hbpe.prediction_log (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    predicted_at    TIMESTAMPTZ NOT NULL,
    horizon_start   TIMESTAMPTZ NOT NULL,
    bucket_index    SMALLINT NOT NULL CHECK (bucket_index BETWEEN 0 AND 47),
    l0_probs        JSONB NOT NULL,          -- {WORK: 0.72, LEISURE: 0.18, ...}
    l1_probs        JSONB NOT NULL,          -- {DEEP_FOCUS: 0.65, MEETING: 0.35}
    l2_probs        JSONB,                   -- null until L2 vocab is established
    actual_l0       TEXT,                    -- filled in retrospectively by T5.1
    actual_l1       TEXT,
    actual_l2       TEXT,
    model_version   TEXT NOT NULL,
    PRIMARY KEY (id, predicted_at)
);

SELECT create_hypertable('hbpe.prediction_log', 'predicted_at');

CREATE INDEX ON hbpe.prediction_log (user_id, predicted_at DESC);

-- ── Summary labels ────────────────────────────────────────────────────────────

-- HBPE L0/L1 labels for hourly summaries produced by the summary service.
-- Populated nightly by SummaryTokenizer.  Summary tokens fill 30-min buckets
-- that have no event-derived coverage (soft_prob=0.7 in token_stream).
CREATE TABLE hbpe.summary_l1_label (
    summary_id      UUID        NOT NULL,
    l0_class        TEXT        NOT NULL,
    l1_cluster_id   UUID        REFERENCES hbpe.l1_clusters(cluster_id) ON DELETE SET NULL,
    labeled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (summary_id)
);

CREATE INDEX ON hbpe.summary_l1_label (labeled_at);

-- migrate:down

DROP TABLE IF EXISTS hbpe.summary_l1_label;
DROP INDEX IF EXISTS hbpe.prediction_log_user_id_predicted_at_idx;
DROP TABLE IF EXISTS hbpe.prediction_log;
DROP TABLE IF EXISTS hbpe.token_stream;
DROP TABLE IF EXISTS hbpe.l2_pending_pool;
DROP TABLE IF EXISTS hbpe.l2_content_cluster;
DROP TABLE IF EXISTS hbpe.l2_clusters;
DROP TABLE IF EXISTS hbpe.content_context;
DROP TABLE IF EXISTS hbpe.vocab_naming_log;
DROP TABLE IF EXISTS hbpe.l1_pending_pool;
DROP TABLE IF EXISTS hbpe.l1_event_cluster;
DROP TABLE IF EXISTS hbpe.l1_clusters;
DROP SCHEMA IF EXISTS hbpe;
