-- migrate:up
--
-- occurrence_log is written on every GET /forecast; without dedupe a single
-- schedule-page session appends hundreds of identical rows. One row per
-- (user, target day, cluster, issuance calendar day) is enough for Brier
-- scoring. Rows older than 90 days are dropped by the nightly pipeline
-- (occurrence_log is not a hypertable, so there is no retention policy API).

CREATE UNIQUE INDEX occurrence_log_issue_dedupe_idx
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
