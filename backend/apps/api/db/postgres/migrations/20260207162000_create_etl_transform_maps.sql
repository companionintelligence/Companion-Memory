-- migrate:up
CREATE TABLE ci.etl_transform_maps (
    id TEXT PRIMARY KEY,
    
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    source_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    
    fields JSONB NOT NULL DEFAULT '{}',
    transformers JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    
    enabled BOOLEAN NOT NULL DEFAULT true,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_etl_transform_maps_source_type ON ci.etl_transform_maps(source_type);
CREATE INDEX idx_etl_transform_maps_target_type ON ci.etl_transform_maps(target_type);
CREATE INDEX idx_etl_transform_maps_enabled ON ci.etl_transform_maps(enabled);

-- migrate:down
DROP TABLE ci.etl_transform_maps;
