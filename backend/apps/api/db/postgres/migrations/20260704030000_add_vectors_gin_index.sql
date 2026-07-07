-- migrate:up
-- Full-text (keyword) search over bulk-ingested entities queries
-- ci_search.vectors.vector (a tsvector) with the @@ match operator, but the
-- table only had btree indexes (pkey + unique entity key) — so every keyword
-- search was a sequential scan. A GIN index makes @@ an index scan.
--
-- NOTE: on a live appliance with an existing corpus, build this out-of-band with
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS vectors_vector_gin_idx
--     ON ci_search.vectors USING gin (vector);
-- (CONCURRENTLY cannot run inside dbmate's migration transaction). On a fresh
-- DB the plain build below is instant. IF NOT EXISTS makes it a no-op when the
-- index was already created concurrently.
CREATE INDEX IF NOT EXISTS vectors_vector_gin_idx
  ON ci_search.vectors USING gin (vector);

-- migrate:down
DROP INDEX IF EXISTS ci_search.vectors_vector_gin_idx;
