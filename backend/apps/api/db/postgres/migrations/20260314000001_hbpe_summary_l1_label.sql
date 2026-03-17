-- migrate:up
--
-- Stores HBPE L0/L1 labels for hourly summaries produced by the summary service.
-- Mirrors ci.l1_event_cluster but keyed by summary_id.
--
-- Populated nightly by SummaryTokenizer (ci/tokenizer/summary_tokenizer.py).
-- Summary tokens are included in ci.token_stream at soft_prob=0.7 to fill
-- 30-min buckets that have no event-derived coverage.

CREATE TABLE IF NOT EXISTS ci.summary_l1_label (
    summary_id      UUID        NOT NULL,
    l0_class        TEXT        NOT NULL,
    -- NULL when the L1 cluster has been deactivated or not yet assigned
    l1_cluster_id   UUID        REFERENCES ci.l1_clusters(cluster_id) ON DELETE SET NULL,
    labeled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (summary_id)
);

CREATE INDEX IF NOT EXISTS summary_l1_label_labeled_at_idx
    ON ci.summary_l1_label (labeled_at);

-- migrate:down
DROP TABLE IF EXISTS ci.summary_l1_label;
