-- migrate:up
-- =================================================================
-- GRAPH DELTAS - Change tracking for entities and relationships
-- =================================================================
-- Captures changes to the knowledge graph for history and summary generation.
-- Delta records are created by the application layer (TypeScript services)
-- rather than database triggers, keeping logic versioned and testable.

CREATE TABLE ci.graph_deltas (
    delta_id UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

    -- Reference to what changed (one or the other, not both)
    entity_id UUID REFERENCES ci.entities(entity_id) ON DELETE SET NULL,
    relationship_id UUID REFERENCES ci.relationships(relationship_id) ON DELETE SET NULL,

    -- Context (denormalized for query efficiency when source is deleted)
    node_type TEXT NOT NULL, -- 'entity' or 'relationship'
    entity_type TEXT, -- 'Person', 'Concept', etc. (for entities)
    relationship_type TEXT, -- 'KNOWS', 'WORKS_AT', etc. (for relationships)

    -- For relationships, capture the endpoints for context
    from_entity_id UUID,
    to_entity_id UUID,

    -- The actual change
    change_type TEXT NOT NULL, -- 'created', 'updated', 'archived', 'deleted', 'merged'
    changed_fields JSONB NOT NULL DEFAULT '{}', -- {"name": {"old": "Bob", "new": "Robert"}}
    change_source TEXT, -- 'user_edit', 'system_inference', 'merge_operation', 'provider_sync'
    change_reason TEXT, -- Optional explanation of why the change happened

    -- Link to batch summary when generated
    summary_id UUID REFERENCES ci.summaries(summary_id) ON DELETE SET NULL,

    -- Metadata
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    changed_by_user_id UUID REFERENCES ci.users(id) ON DELETE SET NULL,
    owner_user_id UUID REFERENCES ci.users(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT valid_node_type CHECK (node_type IN ('entity', 'relationship')),
    CONSTRAINT valid_change_type CHECK (change_type IN ('created', 'updated', 'archived', 'deleted', 'merged')),
    CONSTRAINT has_valid_reference CHECK (
        (node_type = 'entity' AND entity_id IS NOT NULL AND relationship_id IS NULL) OR
        (node_type = 'relationship' AND relationship_id IS NOT NULL)
    )
);

-- Indexes for common queries
CREATE INDEX graph_deltas_entity_idx ON ci.graph_deltas(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX graph_deltas_relationship_idx ON ci.graph_deltas(relationship_id) WHERE relationship_id IS NOT NULL;
CREATE INDEX graph_deltas_owner_time_idx ON ci.graph_deltas(owner_user_id, changed_at DESC);
CREATE INDEX graph_deltas_unsummarized_idx ON ci.graph_deltas(owner_user_id, changed_at) WHERE summary_id IS NULL;
CREATE INDEX graph_deltas_node_type_idx ON ci.graph_deltas(node_type, change_type);
CREATE INDEX graph_deltas_entity_type_idx ON ci.graph_deltas(entity_type) WHERE entity_type IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS ci.graph_deltas;
