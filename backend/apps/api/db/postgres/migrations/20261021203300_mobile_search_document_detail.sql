-- migrate:up

-- One device record per entity (docs/architecture/mobile-local-search-plan.md,
-- "Revision 2026-10-21"). The phone stops syncing whole rows for a few types and
-- keeps one row per searchable entity here instead, so each document also
-- carries what an offline record page shows beyond its title, body and time:
--
--   related_id      the row this one belongs with — a message's conversation,
--                   a sub-event's parent, a file's parent, a task's parent, a
--                   place's parent place, content's event. For communications
--                   it is a uuid v5 of (user, source system, thread id): the raw
--                   thread id is free text, unique only per account and source,
--                   and never leaves the server.
--   detail          a few per-type display fields as JSON (direction and
--                   participants, end time and place, size and type ...).
--                   Nothing filters or sorts on them, so a new field is a code
--                   change, not a migration.
--   detail_version  which recipe last derived the two columns above. Server
--                   only, not synced. MobileSearchDocumentDetailCron rewrites
--                   rows below the current version in batches, so the existing
--                   corpus is filled in here and every later recipe change
--                   re-derives everything. Default 0 marks every existing row
--                   as not yet derived.
--
-- Both are written by the same shared statement that writes title, body and
-- occurred_at (search-ingress VectorService.buildVectorUpsertStatement), from
-- the source row, so the live listeners and the pipeline stages stay identical.

-- The conversation key is `uuid_generate_v5` from uuid-ossp, called unqualified
-- by the shared index statement at runtime (search_path ci,public). The setup
-- container and the test-db bootstrap install the extension with the others;
-- this makes an install that predates that explicit rather than dependent on
-- the 202608 data-repair migrations having installed it as a side effect.
-- uuid-ossp is a trusted extension, so the application role may create it.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE ci_search.mobile_search_documents
  ADD COLUMN related_id     uuid,
  ADD COLUMN detail         jsonb,
  ADD COLUMN detail_version smallint NOT NULL DEFAULT 0;

-- The refresh cron's work list: rows still below a given version. Partial on
-- nothing — the version moves — but tiny next to the table, and it is what lets
-- each batch find its next rows without scanning 600k.
CREATE INDEX mobile_search_documents_detail_version_idx
  ON ci_search.mobile_search_documents (detail_version, id);

-- migrate:down
DROP INDEX IF EXISTS ci_search.mobile_search_documents_detail_version_idx;

ALTER TABLE ci_search.mobile_search_documents
  DROP COLUMN IF EXISTS detail_version,
  DROP COLUMN IF EXISTS detail,
  DROP COLUMN IF EXISTS related_id;
