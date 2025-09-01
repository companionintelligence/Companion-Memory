-- migrate:up
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(255) NOT NULL,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('ios', 'android', 'windows', 'mac')),
    device_identifier VARCHAR(255) NOT NULL UNIQUE,
    app_version VARCHAR(100),
    os_version VARCHAR(100),
    metadata JSONB,
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE device_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    data_type VARCHAR(50) NOT NULL CHECK (data_type IN ('file_activity', 'app_usage', 'media_played', 'notification', 'location', 'device_usage', 'system_info')),
    timestamp TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    source_app VARCHAR(255),
    file_path VARCHAR(500),
    file_type VARCHAR(100),
    activity_type VARCHAR(50) CHECK (activity_type IN ('create', 'edit', 'open', 'delete', 'rename', 'move')),
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    duration_seconds INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_device_data_device_id ON device_data(device_id);
CREATE INDEX idx_device_data_device_type_timestamp ON device_data(device_id, data_type, timestamp);
CREATE INDEX idx_device_data_timestamp ON device_data(timestamp);

-- Create trigger to update updated_at on devices table
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_devices_updated_at 
    BEFORE UPDATE ON devices 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- migrate:down
DROP TRIGGER IF EXISTS update_devices_updated_at ON devices;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS device_data;
DROP TABLE IF EXISTS devices;
