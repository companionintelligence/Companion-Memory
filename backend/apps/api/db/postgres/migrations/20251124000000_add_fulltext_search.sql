-- migrate:up
-- =================================================================
-- ADD FULL-TEXT SEARCH SUPPORT
-- =================================================================
-- Add tsvector columns and GIN indexes for fast full-text search

-- Add tsvector column to entities for full-text search
ALTER TABLE entities
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(name, '') || ' ' ||
    coalesce(description, '') || ' ' ||
    coalesce(search_content, '') || ' ' ||
    coalesce(properties::text, '')
  )
) STORED;

-- Create GIN index for fast FTS on entities
CREATE INDEX entities_fts_idx ON entities USING GIN(search_vector);

-- Add tsvector to facts table
ALTER TABLE facts
ADD COLUMN fact_search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(fact_statement::text, '') || ' ' ||
    coalesce(source, '') || ' ' ||
    coalesce(fact_type, '')
  )
) STORED;

CREATE INDEX facts_fts_idx ON facts USING GIN(fact_search_vector);

-- Add tsvector to document_chunks
ALTER TABLE document_chunks
ADD COLUMN content_search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(content, '') || ' ' ||
    coalesce(section_title, '')
  )
) STORED;

CREATE INDEX document_chunks_fts_idx ON document_chunks USING GIN(content_search_vector);

CREATE OR REPLACE FUNCTION immutable_array_to_string(text[], text)
    RETURNS text as $$ SELECT array_to_string($1, $2); $$
LANGUAGE sql IMMUTABLE;

ALTER TABLE messages
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(content, '') || ' ' ||
    coalesce(immutable_array_to_string(extracted_entities, ' '), '') || ' ' ||
    coalesce(immutable_array_to_string(intent_categories, ' '), '')
  )
) STORED;

CREATE INDEX messages_thread_idx ON messages(thread_id);
CREATE INDEX messages_user_idx ON messages(user_id);
CREATE INDEX messages_role_idx ON messages(role);
CREATE INDEX messages_created_idx ON messages(created_at DESC);
CREATE INDEX messages_fts_idx ON messages USING GIN(search_vector);
CREATE INDEX messages_embedding_idx ON messages USING hnsw (message_embedding vector_cosine_ops)
    WHERE message_embedding IS NOT NULL;

-- migrate:down
-- Drop indexes first
DROP INDEX IF EXISTS messages_embedding_idx;
DROP INDEX IF EXISTS messages_fts_idx;
DROP INDEX IF EXISTS messages_created_idx;
DROP INDEX IF EXISTS messages_role_idx;
DROP INDEX IF EXISTS messages_user_idx;
DROP INDEX IF EXISTS messages_thread_idx;

DROP INDEX IF EXISTS document_chunks_fts_idx;
DROP INDEX IF EXISTS facts_fts_idx;
DROP INDEX IF EXISTS entities_fts_idx;

-- Drop columns
ALTER TABLE document_chunks DROP COLUMN IF EXISTS content_search_vector;
ALTER TABLE facts DROP COLUMN IF EXISTS fact_search_vector;
ALTER TABLE entities DROP COLUMN IF EXISTS search_vector;
