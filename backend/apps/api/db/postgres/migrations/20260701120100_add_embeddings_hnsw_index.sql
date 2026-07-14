-- migrate:up
-- ---------------------------------------------------------------------------
-- ci_search.embeddings: pgvector HNSW ANN index on the embedding column.
--
-- Search (semantic / boosted / hybrid modes) ranks by cosine distance (`<=>`)
-- against ci_search.embeddings.embedding. Until now there was NO ANN index on
-- that column (only UNIQUE(entity_type, entity_id)), so every semantic/boosted
-- query did a sequential scan + exact cosine over the full corpus (~400k rows).
-- That is the leading suspect for issue #1601's 3s-60s p95 latency variance.
--
-- We use HNSW with vector_cosine_ops to match the cosine operator used
-- everywhere in SearchService (nomic-embed-text vectors are unnormalised, so
-- cosine — not L2 — is correct). This mirrors the two legacy HNSW indexes that
-- previously existed (`messages_embedding_idx`, `entities_embedding_idx`).
--
-- Defaults m=16, ef_construction=64 are pgvector's defaults and a sane
-- starting point; the plan (§5) calls for a measure-first spike to quantify
-- build memory on appliance hardware before tuning these. The index build is
-- the expensive step, so this index is ALSO registered in DEFERRABLE_INDEXES
-- (IndexDeferralService) to be dropped/rebuilt around large bulk loads.
--
-- NOTE: this runs as a plain (blocking) CREATE INDEX, consistent with the rest
-- of this migration set. On a live appliance with an existing large corpus,
-- prefer building it out-of-band with CREATE INDEX CONCURRENTLY (see the
-- recreate path in IndexDeferralService / BULK_LOAD_RUNBOOK.md).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
  ON ci_search.embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci_search.embeddings_embedding_hnsw_idx;
