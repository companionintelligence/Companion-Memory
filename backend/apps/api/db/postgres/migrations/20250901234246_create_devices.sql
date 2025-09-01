-- migrate:up
CREATE TABLE devices (
    id UUID PRIMARY KEY,
    
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    
    last_seen TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT,
    
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_type ON devices(type);

-- migrate:down
DROP TABLE devices;