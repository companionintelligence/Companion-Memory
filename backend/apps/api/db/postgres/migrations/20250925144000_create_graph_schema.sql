-- migrate:up
-- =================================================================
-- GRAPH SCHEMA
-- =================================================================
-- Flexible entity-relationship graph system

-- Core entities table - unified storage for all graph nodes
--DROP TABLE IF EXISTS people;
--DROP TABLE IF EXISTS places;
--DROP TABLE IF EXISTS things;
--DROP TABLE IF EXISTS thing_tag;
--DROP TABLE IF EXISTS relationships;
--DROP TABLE IF EXISTS embeddings;

CREATE TABLE entities (
    entity_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    entity_type TEXT NOT NULL, -- 'Person', 'Concept', 'Location', 'Object', etc.
    outgoing_relationships UUID[] DEFAULT '{}',
    owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Common properties all entities might have
    name TEXT,
    description TEXT,
    
    -- Type-specific and dynamic properties as JSONB
    properties JSONB DEFAULT '{}',
    
    -- Vector embedding for semantic search across all entities
    embedding vector(768),
    
    -- Full-text search content (generated from name + description + key properties)
    search_content TEXT,
    
    -- Links to existing relational tables where relevant
    linked_table TEXT,
    linked_id UUID,
    
    -- Lifecycle management
    is_active BOOLEAN DEFAULT TRUE,
    is_archived BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_entity_type CHECK (entity_type ~ '^[A-Z][A-Za-z]*$'),
    CONSTRAINT linked_table_consistency CHECK (
        (linked_table IS NULL AND linked_id IS NULL) OR
        (linked_table IS NOT NULL AND linked_id IS NOT NULL)
    )
);

-- Rich relationships table - stores all connections between entities
CREATE TABLE relationships (
    relationship_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    from_entity_id UUID NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    to_entity_id UUID NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Relationship strength/weight (0.0 to 1.0)
    strength DOUBLE PRECISION DEFAULT 1.0 CHECK (strength >= 0.0 AND strength <= 1.0),
    
    -- Relationship properties as JSONB
    properties JSONB DEFAULT '{}',
    
    -- Bidirectional control
    is_bidirectional BOOLEAN DEFAULT FALSE,
    
    -- Lifecycle
    is_active BOOLEAN DEFAULT TRUE,
    start_date DATE,
    end_date DATE,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT no_self_references CHECK (from_entity_id != to_entity_id),
    CONSTRAINT valid_relationship_type CHECK (relationship_type ~ '^[A-Z_][A-Z0-9_]*$'),
    CONSTRAINT valid_date_range CHECK (
        start_date IS NULL OR end_date IS NULL OR start_date <= end_date
    )
);

-- Indexes for performance
CREATE INDEX entities_type_idx ON entities(entity_type);
CREATE INDEX entities_name_idx ON entities(name) WHERE name IS NOT NULL;
CREATE INDEX entities_search_idx ON entities USING gin(to_tsvector('english', search_content)) 
    WHERE search_content IS NOT NULL;
CREATE INDEX entities_embedding_idx ON entities USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;
CREATE INDEX entities_linked_idx ON entities(linked_table, linked_id) 
    WHERE linked_table IS NOT NULL;
CREATE INDEX entities_active_idx ON entities(entity_type, is_active);

CREATE INDEX relationships_from_idx ON relationships(from_entity_id);
CREATE INDEX relationships_to_idx ON relationships(to_entity_id);
CREATE INDEX relationships_type_idx ON relationships(relationship_type);
CREATE INDEX relationships_bidirectional_idx ON relationships(from_entity_id, to_entity_id, is_bidirectional);
CREATE INDEX relationships_strength_idx ON relationships(strength) WHERE strength > 0.0;

-- Unique constraint to prevent duplicate relationships
CREATE UNIQUE INDEX relationships_unique_directed_idx ON relationships (
    from_entity_id, to_entity_id, relationship_type
) WHERE is_active = TRUE;


CREATE OR REPLACE FUNCTION update_entity_outgoing_relationships()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the outgoing_relationships for the from_entity_id
    UPDATE entities
    SET outgoing_relationships = (
        SELECT ARRAY_AGG(relationship_id)
        FROM relationships
        WHERE from_entity_id = NEW.from_entity_id
          AND is_active = TRUE
    )
    WHERE entity_id = NEW.from_entity_id;

    -- If the relationship is being deleted or updated, also update the old from_entity_id (if it changed)
    IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        UPDATE entities
        SET outgoing_relationships = (
            SELECT ARRAY_AGG(relationship_id)
            FROM relationships
            WHERE from_entity_id = OLD.from_entity_id
              AND is_active = TRUE
        )
        WHERE entity_id = OLD.from_entity_id;
    END IF;

    RETURN NULL; -- For AFTER triggers, the return value is ignored
END;
$$ LANGUAGE plpgsql;


-- migrate:down
-- Drop indexes first
DROP INDEX IF EXISTS relationships_unique_directed_idx;
DROP INDEX IF EXISTS relationships_strength_idx;
DROP INDEX IF EXISTS relationships_bidirectional_idx;
DROP INDEX IF EXISTS relationships_type_idx;
DROP INDEX IF EXISTS relationships_to_idx;
DROP INDEX IF EXISTS relationships_from_idx;
DROP INDEX IF EXISTS entities_active_idx;
DROP INDEX IF EXISTS entities_linked_idx;
DROP INDEX IF EXISTS entities_embedding_idx;
DROP INDEX IF EXISTS entities_search_idx;
DROP INDEX IF EXISTS entities_name_idx;
DROP INDEX IF EXISTS entities_type_idx;

-- Drop tables (relationships first due to FK)
DROP TABLE IF EXISTS relationships;
DROP TABLE IF EXISTS entities;
