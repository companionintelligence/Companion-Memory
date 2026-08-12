-- migrate:up
--
-- occurrence_log is written on every GET /forecast; without dedupe a single
-- schedule-page session appends hundreds of identical rows. One row per
-- (user, target day, cluster, issuance calendar day) is enough for Brier
-- scoring. Rows older than 90 days are dropped by the nightly pipeline
-- (occurrence_log is not a hypertable, so there is no retention policy API).

-- Collapse the rows that accumulated BEFORE the writer was deduped. On a fresh
-- database this deletes nothing; on any database that served /forecast under
-- the old writer the table is mostly duplicates, and the unique index below
-- cannot be built over them. One real case: 10,728 rows over 491 distinct
-- keys, worst group 65 copies.
--
-- Survivor per key: a scored row first (actual IS NOT NULL — that is the half
-- of the Brier pair that cannot be recomputed), then the most recent issuance.
-- Joined on ctid so the delete does not depend on the shape of the primary key.
DELETE FROM hbpe.occurrence_log o
USING (
    SELECT
        ctid,
        row_number() OVER (
            PARTITION BY user_id, target_date, l1_cluster_id,
                         ((predicted_at AT TIME ZONE 'UTC')::date)
            ORDER BY (actual IS NOT NULL) DESC, predicted_at DESC, ctid DESC
        ) AS rn
    FROM hbpe.occurrence_log
) d
WHERE o.ctid = d.ctid
  AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS occurrence_log_issue_dedupe_idx
    ON hbpe.occurrence_log (
        user_id,
        target_date,
        l1_cluster_id,
        ((predicted_at AT TIME ZONE 'UTC')::date)
    );

COMMENT ON TABLE ci.event_candidates IS
    'Proposed activities (the possible schedule layer). Kept out of ci.events '
    'so HBPE never trains on its own suggestions; accept promotes a row to a '
    'real event via promoted_event_id.';

COMMENT ON TABLE ci.rhythms IS
    'P2 fit-solver scaffolding — schema and TypeORM entity only; no reader or '
    'writer ships in this release.';

-- migrate:down

COMMENT ON TABLE ci.rhythms IS NULL;
COMMENT ON TABLE ci.event_candidates IS NULL;
DROP INDEX IF EXISTS hbpe.occurrence_log_issue_dedupe_idx;
