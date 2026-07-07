-- migrate:up
-- Skip-marker table for the search-index sweep. The *SearchIndexListeners skip
-- "low-value" rows (embedSkipReason: empty/too-short/trivial/url-only) WITHOUT
-- writing a ci_search.embeddings row — embeddings.embedding is a VECTOR the
-- model never produced for them, so there is nothing valid to store there.
-- That left the post-load backfill (SearchIndexBackfillService.missingIds,
-- a LEFT JOIN against ci_search.embeddings) re-finding the same skipped rows on
-- EVERY run: the sweep never converged and the resulting no-op jobs starved
-- other entity types on the search-index queue.
--
-- A skip row here records "this (entity_type, entity_id) was examined and
-- intentionally not embedded", so the backfill can anti-join it out. Listeners
-- delete the row again on a successful embed upsert, so an updated row that
-- becomes embeddable stops being marked skipped.
CREATE TABLE ci_search.index_skips (
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

-- migrate:down
DROP TABLE ci_search.index_skips;
