-- migrate:up
--
-- Daily Feature Store (CI-Engineering#53, epic #49).
--
-- `ci_derived` holds derived/computed data products (as opposed to raw capture
-- in `ci` and search artifacts in `ci_search`). Its first table is the daily
-- feature store: one wide row of ~10 scalar metrics per (user, local calendar
-- day), computed from the raw capture tables by DailyMetricsService and read
-- back by the compute-then-narrate insight engine.
--
-- Contract (mirrored by DailyMetricEntity in domains/insights):
--   * A metric column is NULL when its source produced no usable rows that day,
--     so readers can distinguish "no data" from a real zero.
--   * `coverage` is a jsonb map of metric -> 0..1 confidence (fraction of
--     source rows that carried the field the metric needs).
--   * Rows are idempotently upserted on (user_id, date); `computed_at` records
--     the last (re)compute time.

CREATE SCHEMA IF NOT EXISTS ci_derived;

CREATE TABLE ci_derived.daily_metrics (
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    date DATE NOT NULL, -- the user's LOCAL calendar day (bucketed by `timezone`)
    timezone TEXT NOT NULL DEFAULT 'UTC',

    -- communications (ci.communications)
    n_messages INTEGER,
    n_conversations INTEGER,
    n_unique_contacts INTEGER,
    outbound_ratio DOUBLE PRECISION,
    avg_sentiment DOUBLE PRECISION,

    -- movement (ci.position)
    n_places INTEGER,
    km_traveled DOUBLE PRECISION,

    -- attention (ci.browser_activity)
    screen_minutes DOUBLE PRECISION,
    n_domains INTEGER,

    -- money (ci.inventory)
    spend_total NUMERIC(14, 2),

    -- per-metric 0..1 confidence, keyed by metric name
    coverage JSONB NOT NULL DEFAULT '{}',
    computed_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (user_id, date)
);

-- Cross-user reads by day (nightly compute sweeps, freshness monitoring).
CREATE INDEX daily_metrics_date_idx ON ci_derived.daily_metrics (date);

-- migrate:down
DROP TABLE IF EXISTS ci_derived.daily_metrics;

DROP SCHEMA IF EXISTS ci_derived;
