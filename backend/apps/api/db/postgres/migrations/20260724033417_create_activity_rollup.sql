-- migrate:up
-- =================================================================
-- ACTIVITY ROLLUP TABLE
-- =================================================================
-- Precomputed per-user activity counts in hourly UTC buckets, one row
-- per (user, source, hour) that has any activity. Written by the
-- ActivityRollup refresh cron (full recompute, eventually consistent);
-- read by the activityTimeline GraphQL query, which rolls hours into
-- local calendar days for a requested timezone. Hourly UTC storage
-- keeps day boundaries timezone-correct at read time.

CREATE TABLE ci.activity_rollup (
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, source, bucket_start)
);

-- Read path filters on user + bucket range across all sources.
CREATE INDEX activity_rollup_user_bucket_idx ON ci.activity_rollup (user_id, bucket_start);

-- migrate:down
DROP INDEX IF EXISTS ci.activity_rollup_user_bucket_idx;

DROP TABLE IF EXISTS ci.activity_rollup;
