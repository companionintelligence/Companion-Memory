-- Plan 18: document chunk table for RAG over uploaded files.
--
-- Stores fixed-size, overlapping text chunks extracted from ci.files rows.
-- Each chunk carries its embedding vector for semantic nearest-neighbour search.
--
-- Dimension 768 matches nomic-embed-text (EmbeddingGenerationService default).
-- For OpenAI text-embedding-3-small use 1536 — a follow-up migration will add
-- a variant column when multi-provider embedding is wired in.

CREATE TABLE IF NOT EXISTS ci.document_chunks (
  id           UUID        NOT NULL PRIMARY KEY,
  file_id      UUID        NOT NULL REFERENCES ci.files(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,
  chunk_index  INTEGER     NOT NULL CHECK (chunk_index >= 0),
  text         TEXT        NOT NULL,
  -- pgvector column; stored as TEXT here because TypeORM's generic driver
  -- doesn't have first-class vector support. The EmbeddingEntity pattern
  -- (transformer to/from '[n1,n2,...]') is used in the entity class.
  embedding    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (file_id, chunk_index)
);

COMMENT ON TABLE  ci.document_chunks IS 'Text chunks extracted from uploaded files for RAG search (plan 18).';
COMMENT ON COLUMN ci.document_chunks.chunk_index IS 'Zero-based position of this chunk within the source file.';
COMMENT ON COLUMN ci.document_chunks.embedding   IS 'nomic-embed-text 768-dim vector serialised as pgvector literal.';

CREATE INDEX IF NOT EXISTS document_chunks_file_idx    ON ci.document_chunks (file_id);
CREATE INDEX IF NOT EXISTS document_chunks_user_idx    ON ci.document_chunks (user_id);
