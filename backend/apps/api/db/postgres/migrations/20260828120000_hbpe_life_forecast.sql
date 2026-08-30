-- migrate:up
-- HBPE life-forecast overhaul: channel map, cluster tier, 15-min buckets,
-- rollup corpus, seasonal profiles, and task L0 inheritance.

CREATE TABLE IF NOT EXISTS hbpe.kind_l0_map (
    kind_pattern         TEXT PRIMARY KEY,
    l0_class             TEXT NOT NULL,
    l1_label             TEXT NOT NULL,
    tier                 TEXT NOT NULL CHECK (tier IN ('anchor', 'ambient')),
    default_duration_min INTEGER NOT NULL DEFAULT 5
        CHECK (default_duration_min > 0)
);

INSERT INTO hbpe.kind_l0_map (kind_pattern, l0_class, l1_label, tier, default_duration_min)
VALUES
    ('media.play',      'LEISURE',  'Listening',    'ambient', 3),
    ('media.watch',     'LEISURE',  'Watching',     'ambient', 15),
    ('view',            'LEISURE',  'Browsing',     'ambient', 5),
    ('social.%',        'SOCIAL',   'Social',       'ambient', 5),
    ('travel.trip',     'TRANSIT',  'Trip',         'anchor',  60),
    ('fitness.workout', 'EXERCISE', 'Workout',      'anchor',  45),
    ('wearable.sleep',  'SLEEP',    'Night Sleep',  'anchor',  420),
    ('visited',         'TRANSIT',  'Place Visit',  'anchor',  30)
ON CONFLICT (kind_pattern) DO NOTHING;

ALTER TABLE hbpe.l1_clusters
    ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'anchor'
        CHECK (tier IN ('anchor', 'ambient'));

ALTER TABLE hbpe.l1_clusters
    DROP CONSTRAINT IF EXISTS l1_clusters_naming_method_check;
ALTER TABLE hbpe.l1_clusters
    ADD CONSTRAINT l1_clusters_naming_method_check
        CHECK (naming_method = ANY (ARRAY['LLM', 'ctfidf', 'user', 'STATIC']));

CREATE TABLE IF NOT EXISTS hbpe.token_stream_rollup (
    user_id      UUID        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    period_start DATE        NOT NULL,
    tier         TEXT        NOT NULL CHECK (tier IN ('weekly', 'prior_year')),
    seq_order    INTEGER     NOT NULL,
    bucket_idx   INTEGER     NOT NULL,
    level        TEXT        NOT NULL,
    token_id     TEXT        NOT NULL,
    soft_prob    FLOAT4[]    NOT NULL,
    weight       REAL        NOT NULL DEFAULT 0.6,
    PRIMARY KEY (user_id, period_start, tier, seq_order)
);

CREATE INDEX IF NOT EXISTS token_stream_rollup_user_tier_idx
    ON hbpe.token_stream_rollup (user_id, tier, period_start);

CREATE TABLE IF NOT EXISTS hbpe.seasonal_profiles (
    user_id            UUID        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    l1_cluster_id      UUID        NOT NULL REFERENCES hbpe.l1_clusters(cluster_id) ON DELETE CASCADE,
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    moy_counts         INTEGER[]   NOT NULL,
    distinct_years     INTEGER     NOT NULL DEFAULT 0,
    typical_day_of_year INTEGER,
    annual_confidence  REAL        NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, l1_cluster_id)
);

ALTER TABLE ci.tasks
    ADD COLUMN IF NOT EXISTS l0_class TEXT,
    ADD COLUMN IF NOT EXISTS l1_cluster_id UUID;

-- 15-minute buckets: wipe incompatible 30-min indices.
DELETE FROM hbpe.prediction_log;
DELETE FROM hbpe.token_stream;

ALTER TABLE hbpe.prediction_log
    DROP CONSTRAINT IF EXISTS prediction_log_bucket_index_check;

ALTER TABLE hbpe.prediction_log
    ADD CONSTRAINT prediction_log_bucket_index_check
    CHECK (bucket_index BETWEEN 0 AND 95);

COMMENT ON COLUMN hbpe.prediction_log.bucket_index IS '0..95 (15-min bucket within the calendar day)';
COMMENT ON COLUMN hbpe.token_stream.bucket_idx IS '0..95 (15-min bucket within the calendar day)';

-- migrate:down

ALTER TABLE ci.tasks
    DROP COLUMN IF EXISTS l1_cluster_id,
    DROP COLUMN IF EXISTS l0_class;

DROP TABLE IF EXISTS hbpe.seasonal_profiles;
DROP TABLE IF EXISTS hbpe.token_stream_rollup;

ALTER TABLE hbpe.l1_clusters DROP COLUMN IF EXISTS tier;
DROP TABLE IF EXISTS hbpe.kind_l0_map;

DELETE FROM hbpe.prediction_log;
DELETE FROM hbpe.token_stream;

ALTER TABLE hbpe.prediction_log
    DROP CONSTRAINT IF EXISTS prediction_log_bucket_index_check;

ALTER TABLE hbpe.prediction_log
    ADD CONSTRAINT prediction_log_bucket_index_check
    CHECK (bucket_index BETWEEN 0 AND 47);

COMMENT ON COLUMN hbpe.prediction_log.bucket_index IS '0..47 (30-min bucket within the calendar day)';
COMMENT ON COLUMN hbpe.token_stream.bucket_idx IS '0..47 (30-min bucket within the calendar day)';
