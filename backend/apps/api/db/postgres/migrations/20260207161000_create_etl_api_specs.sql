-- migrate:up
CREATE TABLE ci.etl_api_specs (
    id TEXT PRIMARY KEY,
    
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    version TEXT NOT NULL,
    
    meta JSONB NOT NULL,
    endpoints JSONB NOT NULL DEFAULT '{}',
    global_rate_limit JSONB,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_etl_api_specs_version ON ci.etl_api_specs(version);

-- migrate:down
DROP TABLE ci.etl_api_specs;
