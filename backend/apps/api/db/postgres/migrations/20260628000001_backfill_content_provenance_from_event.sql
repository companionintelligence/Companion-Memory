-- migrate:up
-- Backfill the provenance triple on existing ci.content rows from their linked
-- event. Pre-fix, the single-record createContent mutation (used by the
-- importer's media-link path: file upload → createContent) didn't accept
-- source_type/source_system/source_id, so ~60k photo content rows landed with
-- NULL triple and event_id set. Now that createContent routes through
-- ContentService.createMany and the importer propagates the parent event's
-- triple, derive the same triple onto historical rows so:
--   * content_source_triple_uniq actually protects them from duplicate inserts
--     on re-sync
--   * ContentService.resolveEventByTriple can re-link orphans after a refactor
--
-- Scope: only rows missing source_system whose linked event has a triple, and
-- where the unique-key target isn't already taken by another content row of the
-- same user (avoid violating content_source_triple_uniq if a triple-populated
-- row was inserted later for the same (sourceType, sourceSystem, sourceId)).
UPDATE ci.content c
SET
  source_type = e.source_type,
  source_system = e.source_system,
  source_id = e.source_id
FROM ci.events e
WHERE c.event_id = e.id
  AND c.source_system IS NULL
  AND c.source_type IS NULL
  AND c.source_id IS NULL
  AND e.source_system IS NOT NULL
  AND e.source_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM ci.content c2
    WHERE c2.user_id = c.user_id
      AND c2.source_type = e.source_type
      AND c2.source_system IS NOT DISTINCT FROM e.source_system
      AND c2.source_id = e.source_id
      AND c2.id <> c.id
  );

-- migrate:down
-- Irreversible by design: there is no way to distinguish a triple that was
-- backfilled here from a triple that was set by the application post-fix. The
-- backfill is a one-way data correction; leave the rows alone on rollback.
