-- migrate:up
-- ---------------------------------------------------------------------------
-- ci_search.embeddings: btree(user_id) for the per-user filtering path.
--
-- Every semantic/boosted search filters embeddings by user_id before the
-- cosine scan; with no index on user_id that filter is a sequential scan over
-- the whole table (prime suspect in issue #1601's 3s-60s latency variance).
-- This is the cheap, low-risk half of the search-perf P0 (plan §4 / §5): a
-- btree(user_id) alone may already collapse the tail latency, and unlike an
-- ANN index its build cost and memory footprint are trivial and well-known.
--
-- Kept out of DEFERRABLE_INDEXES: a plain btree on a single scalar column is
-- cheap to maintain incrementally during bulk load, so there is no benefit to
-- dropping/rebuilding it around a load window (unlike the HNSW index).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS embeddings_user_id_idx
  ON ci_search.embeddings (user_id)
  WHERE user_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci_search.embeddings_user_id_idx;
