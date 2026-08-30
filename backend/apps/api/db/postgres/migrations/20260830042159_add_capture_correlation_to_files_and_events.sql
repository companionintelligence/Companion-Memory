-- migrate:up
-- CI-Capture's screenshots and its desktop-activity ("vizier") events upload
-- via two completely separate, independently-retried paths and previously
-- shared no identifier at all — a screenshot could never be traced back to
-- the activity it was taken during. CI-Capture now mints one UUID per worker
-- tick and stamps it on both: the vizier event's JSON payload (already
-- free-form, so it flows onto ci.events.metadata) is upgraded to send it as
-- a first-class field instead, and the screenshot multipart upload gained a
-- new captureTickId text field (see CI-Capture's server_ingest.rs).
--
-- capture_tick_id is deliberately its OWN column on each table, not folded
-- into (source_type, source_system, source_id): that triple is each table's
-- own dedup/idempotency key (events_source_triple_uniq /
-- content_source_triple_uniq), and this correlator's job is unrelated —
-- linking a row on ONE table to a row on ANOTHER, not deduping re-sends of
-- the same row. Stored (not just resolved-and-discarded) on ci.files so a
-- future repair pass can link a screenshot whose upload raced ahead of its
-- event — see 20260819064129_link_content_to_events_by_triple.sql for the
-- exact precedent: content/event linking already needed one backfill once
-- for the same ordering reason.
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS capture_tick_id UUID;
ALTER TABLE ci.files ADD COLUMN IF NOT EXISTS capture_tick_id UUID;
ALTER TABLE ci.files ADD COLUMN IF NOT EXISTS event_id UUID;

CREATE INDEX IF NOT EXISTS events_capture_tick_id_idx
  ON ci.events (user_id, capture_tick_id)
  WHERE capture_tick_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS files_capture_tick_id_idx
  ON ci.files (user_id, capture_tick_id)
  WHERE capture_tick_id IS NOT NULL;

-- SET NULL, not CASCADE: unlike ci.content (which mirrors its event and is
-- meant to disappear with it, see 20260819014532), a screenshot is a real
-- object-storage asset independently useful after the event it was taken
-- during is deleted — only the link should go.
ALTER TABLE ci.files
  ADD CONSTRAINT files_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES ci.events(event_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS files_event_id_idx ON ci.files (event_id) WHERE event_id IS NOT NULL;

-- migrate:down
ALTER TABLE ci.files DROP CONSTRAINT IF EXISTS files_event_id_fkey;
DROP INDEX IF EXISTS ci.files_event_id_idx;
DROP INDEX IF EXISTS ci.files_capture_tick_id_idx;
DROP INDEX IF EXISTS ci.events_capture_tick_id_idx;
ALTER TABLE ci.files DROP COLUMN IF EXISTS event_id;
ALTER TABLE ci.files DROP COLUMN IF EXISTS capture_tick_id;
ALTER TABLE ci.events DROP COLUMN IF EXISTS capture_tick_id;
