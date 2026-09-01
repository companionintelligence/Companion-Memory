-- migrate:up

-- The materialize step of the /v1/events capture->materialize->link pipeline
-- (BulkIngestController.ingest) never copied observed_at from the raw
-- ci.capture_events log onto the materialized row, so it survived only in the
-- append-only log. Backfill from capture_events for rows still linked via
-- event_id before the app starts writing this column going forward.
ALTER TABLE ci.events ADD COLUMN observed_at timestamptz;

UPDATE ci.events e
SET observed_at = ce.observed_at
FROM ci.capture_events ce
WHERE ce.event_id = e.event_id
  AND ce.observed_at IS NOT NULL;

-- migrate:down

ALTER TABLE ci.events DROP COLUMN IF EXISTS observed_at;
