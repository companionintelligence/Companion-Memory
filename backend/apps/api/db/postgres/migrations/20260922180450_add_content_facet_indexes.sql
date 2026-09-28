-- Serve the content library's facet pickers (ContentService.getFacets) by
-- walking distinct values along an index instead of scanning the library.
--
-- Measured 2026-09-22 on a 132k-row library (224k events, 132k ledger rows):
-- the three facet queries — distinct type, distinct mimetype, and the
-- delivering platforms — each hashed every content row against every event
-- in a parallel hash join, 9–24 MB of dynamic shared memory apiece, ~240 ms
-- and six workers per page load, to return 67 short strings. Together they
-- exhausted the database container's 64 MB /dev/shm and every load failed
-- with "could not resize shared memory segment", which the page reported as
-- "No content types yet".
--
-- With these indexes the same answers come from loose index scans (a
-- recursive CTE that asks for the next value above the last one, one probe
-- per distinct value): 0.13 ms for types, 0.30 ms for mimetypes, 0.26 ms for
-- platforms, and no shared memory at all. See contentFacetsSql.ts for the
-- queries each index serves.
--
-- Built without CONCURRENTLY, matching 20260821164353: the tables are
-- modest on an appliance and the build holds its lock for a second or two.
-- An operator with a materially larger corpus should build these
-- CONCURRENTLY out of band.

-- migrate:up
CREATE INDEX IF NOT EXISTS content_user_type_idx
  ON ci.content (user_id, type);

CREATE INDEX IF NOT EXISTS content_user_mimetype_idx
  ON ci.content (user_id, mimetype);

CREATE INDEX IF NOT EXISTS content_user_source_system_idx
  ON ci.content (user_id, source_system);

CREATE INDEX IF NOT EXISTS record_sources_user_table_platform_idx
  ON ci.record_sources (user_id, record_table, platform);

CREATE INDEX IF NOT EXISTS record_sources_unplatformed_idx
  ON ci.record_sources (user_id, record_table, record_id)
  WHERE platform IS NULL;

CREATE INDEX IF NOT EXISTS events_user_deleted_idx
  ON ci.events (user_id)
  WHERE is_deleted;

COMMENT ON INDEX ci.content_user_type_idx IS
  'Loose index scan over a user''s distinct content types (ContentService.getFacets). Deliberately non-partial: the facet must see every row.';

COMMENT ON INDEX ci.content_user_mimetype_idx IS
  'Loose index scan over a user''s distinct mimetypes (ContentService.getFacets).';

COMMENT ON INDEX ci.content_user_source_system_idx IS
  'Loose index scan over a user''s distinct source_system values (ContentService.getFacets, the How picker''s column arm).';

COMMENT ON INDEX ci.record_sources_user_table_platform_idx IS
  'Loose index scan over the platforms the ledger recorded for one table of a user''s records (ContentService.getFacets, the How picker''s ledger arm).';

COMMENT ON INDEX ci.record_sources_unplatformed_idx IS
  'The (few) ledger rows whose producer could not name a platform. ContentService.getFacets reads a record''s own source_system for exactly these, so the set must be reachable without scanning the ledger.';

COMMENT ON INDEX ci.events_user_deleted_idx IS
  'The (few) soft-deleted events of a user. ContentService.getFacets hides media that exists only on a deleted event by starting from this set rather than joining every event.';

-- migrate:down
DROP INDEX IF EXISTS ci.events_user_deleted_idx;
DROP INDEX IF EXISTS ci.record_sources_unplatformed_idx;
DROP INDEX IF EXISTS ci.record_sources_user_table_platform_idx;
DROP INDEX IF EXISTS ci.content_user_source_system_idx;
DROP INDEX IF EXISTS ci.content_user_mimetype_idx;
DROP INDEX IF EXISTS ci.content_user_type_idx;
