-- migrate:up

-- ==================== ENTITIES ====================
-- Remove the GENERATED constraint from existing column
ALTER TABLE entities ALTER COLUMN search_vector DROP EXPRESSION IF EXISTS;

-- Create function to update entities search_vector
CREATE OR REPLACE FUNCTION entities_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(NEW.description, '') || ' ' ||
    coalesce(NEW.search_content, '') || ' ' ||
    coalesce(NEW.properties::text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
CREATE TRIGGER entities_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, description, search_content, properties
  ON entities
  FOR EACH ROW
  EXECUTE FUNCTION entities_search_vector_update();

-- ==================== FACTS ====================
-- Remove the GENERATED constraint from existing column
ALTER TABLE facts ALTER COLUMN fact_search_vector DROP EXPRESSION IF EXISTS;

-- Create function to update facts search_vector
CREATE OR REPLACE FUNCTION facts_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.fact_search_vector := to_tsvector('english',
    coalesce(NEW.fact_statement::text, '') || ' ' ||
    coalesce(NEW.source, '') || ' ' ||
    coalesce(NEW.fact_type, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
CREATE TRIGGER facts_search_vector_trigger
  BEFORE INSERT OR UPDATE OF fact_statement, source, fact_type
  ON facts
  FOR EACH ROW
  EXECUTE FUNCTION facts_search_vector_update();

-- ==================== DOCUMENT CHUNKS ====================
-- Remove the GENERATED constraint from existing column
ALTER TABLE document_chunks ALTER COLUMN content_search_vector DROP EXPRESSION IF EXISTS;

-- Create function
CREATE OR REPLACE FUNCTION document_chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.content_search_vector := to_tsvector('english',
    coalesce(NEW.content, '') || ' ' ||
    coalesce(NEW.section_title, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
CREATE TRIGGER document_chunks_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content, section_title
  ON document_chunks
  FOR EACH ROW
  EXECUTE FUNCTION document_chunks_search_vector_update();

-- migrate:down
-- =================================================================
-- REVERT TO GENERATED COLUMNS
-- =================================================================

-- Drop triggers and functions
DROP TRIGGER IF EXISTS document_chunks_search_vector_trigger ON document_chunks;
DROP FUNCTION IF EXISTS document_chunks_search_vector_update();

DROP TRIGGER IF EXISTS facts_search_vector_trigger ON facts;
DROP FUNCTION IF EXISTS facts_search_vector_update();

DROP TRIGGER IF EXISTS entities_search_vector_trigger ON entities;
DROP FUNCTION IF EXISTS entities_search_vector_update();

-- Recreate as generated columns (requires dropping and recreating)
ALTER TABLE document_chunks DROP COLUMN content_search_vector;
ALTER TABLE document_chunks
ADD COLUMN content_search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(content, '') || ' ' ||
    coalesce(section_title, '')
  )
) STORED;

ALTER TABLE facts DROP COLUMN fact_search_vector;
ALTER TABLE facts
ADD COLUMN fact_search_vector tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(fact_statement::text, '') || ' ' ||
    coalesce(source, '') || ' ' ||
    coalesce(fact_type, '')
  )
) STORED;

ALTER TABLE entities DROP COLUMN search_vector;
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
