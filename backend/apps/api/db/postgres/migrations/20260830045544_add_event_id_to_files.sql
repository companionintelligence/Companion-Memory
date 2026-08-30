-- migrate:up
-- CI-Capture takes a screenshot AND emits a desktop-activity event to
-- POST /v1/events in the same worker tick, but nothing linked the two: the
-- screenshot lands in ci.files (FilesController.upload -> FileService.create)
-- with no provenance, while the event lands in ci.events with a
-- (source_type, source_system, source_id) idempotency triple. Mirrors
-- ci.content.event_id (migration 20260808150100_schema_consolidation):
-- nullable, FK to ci.events(event_id), ON DELETE SET NULL so a deleted event
-- doesn't take its screenshot down with it.
ALTER TABLE ci.files ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES ci.events(event_id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE ci.files DROP COLUMN IF EXISTS event_id;
