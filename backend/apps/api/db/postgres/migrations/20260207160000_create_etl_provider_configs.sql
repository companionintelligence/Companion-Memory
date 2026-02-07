-- migrate:up
CREATE TABLE ci.etl_provider_configs (
    id UUID PRIMARY KEY,
    
    name TEXT NOT NULL,
    description TEXT,
    logo_url TEXT,
    theme JSONB DEFAULT '{}',
    
    sources JSONB NOT NULL DEFAULT '[]',
    auth JSONB NOT NULL,
    api_spec_id TEXT NOT NULL,
    
    enabled BOOLEAN NOT NULL DEFAULT true,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_etl_provider_configs_enabled ON ci.etl_provider_configs(enabled);
CREATE INDEX idx_etl_provider_configs_api_spec_id ON ci.etl_provider_configs(api_spec_id);

-- migrate:down
DROP TABLE ci.etl_provider_configs;
