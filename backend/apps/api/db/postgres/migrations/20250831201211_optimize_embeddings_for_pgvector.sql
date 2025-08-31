-- migrate:up
-- Optimize embeddings table for pgvector performance
-- This migration improves vector storage and similarity search capabilities

-- Create a proper vector column alongside the existing text-based storage
-- We keep the existing column for backward compatibility during transition
ALTER TABLE embeddings 
    ADD COLUMN IF NOT EXISTS embedding_vector_native vector;

-- Create function to convert text array format to vector
CREATE OR REPLACE FUNCTION convert_text_to_vector(text_vec TEXT) 
RETURNS vector AS $$
BEGIN
    -- Remove brackets and convert comma-separated string to vector
    RETURN (trim(both '[]' from text_vec))::vector;
EXCEPTION
    WHEN OTHERS THEN
        -- Return null if conversion fails
        RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Populate the new vector column from existing text data
UPDATE embeddings 
SET embedding_vector_native = convert_text_to_vector(embedding_vector::text)
WHERE embedding_vector_native IS NULL 
  AND embedding_vector IS NOT NULL;

-- Create specialized indexes for vector similarity search
-- Use HNSW (Hierarchical Navigable Small World) for efficient similarity search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_vector_cosine 
    ON embeddings USING hnsw (embedding_vector_native vector_cosine_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_vector_l2 
    ON embeddings USING hnsw (embedding_vector_native vector_l2_ops);

-- Create composite index for filtered vector searches
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_user_entity_vector 
    ON embeddings(user_id, entity_type, entity_id) 
    WHERE embedding_vector_native IS NOT NULL;

-- Add index for entity lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_entity_lookup
    ON embeddings(entity_type, entity_id);

-- Optimize data_path queries (common in content retrieval)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_data_path_prefix
    ON embeddings(data_path text_pattern_ops);

-- Add constraint to ensure vector dimension consistency when using native vector type
ALTER TABLE embeddings
    ADD CONSTRAINT chk_embeddings_native_vector_dimension CHECK (
        embedding_vector_native IS NULL OR 
        vector_dims(embedding_vector_native) IN (384, 768, 1024, 1536, 3072)
    );

-- Create view for vector similarity searches to abstract the complexity
CREATE OR REPLACE VIEW embedding_similarities AS
SELECT 
    e1.id,
    e1.user_id,
    e1.entity_type,
    e1.entity_id,
    e1.data_path,
    e1.raw_input,
    e1.model,
    e1.created_at
FROM embeddings e1
WHERE e1.embedding_vector_native IS NOT NULL;

-- Add comment documenting the migration
COMMENT ON COLUMN embeddings.embedding_vector_native IS 
    'Native pgvector column for efficient similarity search operations';

COMMENT ON VIEW embedding_similarities IS 
    'View for vector similarity searches, filters out records without native vectors';

-- migrate:down
-- Remove optimizations (in reverse order)
DROP VIEW IF EXISTS embedding_similarities;

ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS chk_embeddings_native_vector_dimension;

DROP INDEX CONCURRENTLY IF EXISTS idx_embeddings_data_path_prefix;
DROP INDEX CONCURRENTLY IF EXISTS idx_embeddings_entity_lookup;
DROP INDEX CONCURRENTLY IF EXISTS idx_embeddings_user_entity_vector;
DROP INDEX CONCURRENTLY IF EXISTS idx_embeddings_vector_l2;
DROP INDEX CONCURRENTLY IF EXISTS idx_embeddings_vector_cosine;

DROP FUNCTION IF EXISTS convert_text_to_vector(TEXT);

ALTER TABLE embeddings DROP COLUMN IF EXISTS embedding_vector_native;