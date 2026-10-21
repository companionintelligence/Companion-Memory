-- migrate:up

-- The search index a phone can carry.
--
-- ci_search.vectors holds a tsvector: stemmed lexemes with positions and no
-- original text, so nothing on the server could be rendered back into a result
-- row or re-indexed on a device. This table is the plain-text projection of the
-- same rows, one per indexed entity, written by the same two statements that
-- write the tsvector (search-ingress VectorService.upsert and the pipeline's
-- vector stages, through one shared builder) so the two can never disagree about
-- what text represents a row.
--
-- Columns are what a search result on the device needs and nothing more:
--   title       the first weight-A text of the row's search document — a name,
--               a subject, a filename, a message preview when there is no subject
--   body        the rest of that document, cut at 1 KB
--   occurred_at the row's OWN time (sent, started, taken, written), the same
--               per-type CASE search-next uses for "most recent"; NULL for types
--               with no time of their own
--
-- Only the types a device shows are projected (see DEVICE_INDEXED_ENTITIES in
-- search-next/types.ts); answers, browser activity, positions, file chunks and
-- chat fragments are not. PowerSync replicates this table per user
-- (infrastructure/powersync/sync-rules.yaml), and the device builds its own
-- FTS5 index over it.
--
-- `id` is the vectors row's id, with ON DELETE CASCADE: removing an index row
-- (an entity deleted, a merge tombstone, the orphan sweep, a privacy deletion)
-- removes its document in the same statement, and PowerSync evicts it from
-- every device. No second delete path to keep in step.
--
-- No backfill here. The vector pipeline stages' versions were bumped alongside
-- this migration, so the next pipeline index sweep rewrites the documents for
-- every type they cover (content, communication, event, item, person, file —
-- all but a few thousand rows on a typical install). A sweep is requested only
-- at the end of an import (import PushStage emits SearchIndexBackfillRequest
-- for the types it pushed; nothing requests one on a timer), so an existing
-- install's bulk gets its documents on its next import. Concepts, products and
-- receipts are picked up by POST /maintenance/search-index/backfill, whose
-- "missing" test now also counts an index row with no document. Notes,
-- threads, tasks and places have neither a pipeline stage nor a backfill lane;
-- they get a document the next time their row is written (every one of them
-- is indexed by a listener on change) — a handful of rows.

CREATE TABLE ci_search.mobile_search_documents (
  id          uuid PRIMARY KEY REFERENCES ci_search.vectors(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  occurred_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);

COMMENT ON TABLE ci_search.mobile_search_documents IS
  'Plain-text projection of ci_search.vectors for on-device search (PowerSync). '
  'Written only beside the tsvector; never edited by hand.';

-- The sync rule selects by user; the logical-replication snapshot and every
-- bucket re-evaluation read this.
CREATE INDEX mobile_search_documents_user_id_idx ON ci_search.mobile_search_documents (user_id);

-- migrate:down
DROP TABLE IF EXISTS ci_search.mobile_search_documents;
