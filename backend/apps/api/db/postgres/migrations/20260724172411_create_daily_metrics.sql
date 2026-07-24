-- migrate:up
-- =================================================================
-- DAILY METRICS (Daily Feature Store)
-- =================================================================
-- One row per (user, local calendar day) of derived scalar metrics used by
-- the insights compute-then-narrate engine. Written by DailyMetricsService /
-- DailyMetricsCron (idempotent upsert); read by getRange / descriptive Q&A.
-- Day boundaries are interpreted in the row's `timezone` column at compute
-- time (see DAILY_AGGREGATE_SQL).

CREATE TABLE ci.daily_metrics (
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',

    n_messages INTEGER,
    n_conversations INTEGER,
    n_unique_contacts INTEGER,
    outbound_ratio DOUBLE PRECISION,
    avg_sentiment DOUBLE PRECISION,
    n_places INTEGER,
    km_traveled DOUBLE PRECISION,
    screen_minutes DOUBLE PRECISION,
    n_domains INTEGER,
    spend_total NUMERIC(14, 2),

    coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (user_id, date)
);

CREATE INDEX daily_metrics_user_date_idx ON ci.daily_metrics (user_id, date);

-- migrate:down
DROP INDEX IF EXISTS ci.daily_metrics_user_date_idx;

DROP TABLE IF EXISTS ci.daily_metrics;
