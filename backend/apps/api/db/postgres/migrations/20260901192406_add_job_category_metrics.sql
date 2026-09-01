-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- Job history, BY CATEGORY.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ci.job_metrics` (20260817030000) is keyed (sampled_at, queue), and a queue
-- can never be turned into a category after the fact. pg-boss's dead-letter
-- copy rewrites the `name` column to the literal `dead-letter` while copying
-- `data` verbatim, so for every dead-lettered job the queue it ran on is simply
-- gone -- 8,431 of 19,606 rows (43%) on a live appliance. Folding that table
-- into the taxonomy would therefore file two fifths of all work under one
-- meaningless bucket.
--
-- What survives the dead-letter copy is the EVENT NAME, at `data->>'name'`,
-- and that is what `domains/events/taxonomy.ts` maps to a category. So the
-- collector folds on the event and writes a second, differently-grained table
-- rather than gaining a column here: `ci.job_metrics`' primary key is
-- load-bearing for the existing depth/throughput chart, and (sampled_at, queue)
-- cannot also mean (sampled_at, category).
--
-- Why a table at all, when the same numbers can be derived live from
-- `pgboss.job`? Because that derivation only reaches back about thirty-six
-- hours -- twelve to archive plus twenty-four of archive retention. The live
-- query is the truth for the recent window; this table is the only thing that
-- will answer the same question next week.
CREATE TABLE IF NOT EXISTS ci.job_category_metrics (
    sampled_at      timestamptz NOT NULL,
    category        text        NOT NULL,

    -- GAUGES: how much work of this category is outstanding at this instant.
    pending         integer     NOT NULL DEFAULT 0,
    active          integer     NOT NULL DEFAULT 0,
    retry           integer     NOT NULL DEFAULT 0,
    dead_lettered   integer     NOT NULL DEFAULT 0,

    -- DELTAS over the sampling interval, not lifetime totals -- same reasoning
    -- as `ci.job_metrics`: pg-boss deletes the rows a running total would need.
    --
    -- `arrived` has no counterpart in the per-queue table and is the column the
    -- category chart actually plots. Volume-over-time has to mean the same
    -- thing on both sides of the ~36h live/sampled seam, and the live side can
    -- only count arrivals (`created_on` is the one timestamp every row carries,
    -- terminal or not). Without this column the older half of the chart would
    -- have to plot throughput while the recent half plotted arrivals, and the
    -- two would disagree at the join for reasons no reader could see.
    arrived         integer     NOT NULL DEFAULT 0,
    completed       integer     NOT NULL DEFAULT 0,
    failed          integer     NOT NULL DEFAULT 0,

    PRIMARY KEY (sampled_at, category)
);

COMMENT ON TABLE ci.job_category_metrics IS
  'Per-category job telemetry sampled on the same cron as ci.job_metrics. Exists because a queue cannot be mapped to a category -- pg-boss rewrites the queue name on the dead-letter copy (43% of rows on a live appliance) while preserving the event name in `data`, which is what the taxonomy folds.';

COMMENT ON COLUMN ci.job_category_metrics.category IS
  'A JOB_CATEGORIES value, or `unclassified` for events with no taxonomy entry. Folded from data->>''name'' at sample time by the same expression JobQueryService.facetCounts uses, so the chart and the category filter chips cannot disagree.';

COMMENT ON COLUMN ci.job_category_metrics.arrived IS
  'Delta: jobs of this category ENQUEUED during the interval ending at sampled_at, excluding dead-letter copies (a dead-lettered job is inserted a second time with a fresh created_on, and counting that as new work reports a burst of arrivals at the moment things broke).';

COMMENT ON COLUMN ci.job_category_metrics.dead_lettered IS
  'Gauge: rows sitting in the dead-letter queue. Counted from the DLQ copy alone, NOT also from the `failed` original the way ci.job_metrics has to -- the copy keeps the event name, so both rows fold to the same category and adding them would double every dead-lettered job.';

-- The chart always asks for a trailing window ordered by time, and the purge
-- deletes by age. Both are this index.
CREATE INDEX IF NOT EXISTS job_category_metrics_sampled_at_idx
    ON ci.job_category_metrics (sampled_at DESC);

-- Per-category drill-down: "show me ingest for the last week".
CREATE INDEX IF NOT EXISTS job_category_metrics_category_sampled_at_idx
    ON ci.job_category_metrics (category, sampled_at DESC);

-- migrate:down

DROP TABLE IF EXISTS ci.job_category_metrics;
