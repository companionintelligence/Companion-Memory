-- migrate:up
DROP TABLE IF EXISTS ci.api_logs;

-- migrate:down
CREATE TABLE ci.api_logs (
  id UUID DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  connection_id UUID REFERENCES connections(id),
  scope TEXT,
  content JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_processed TIMESTAMPTZ,
  PRIMARY KEY (id, created_at, user_id)
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('api_logs', 'created_at', 'user_id', 4);
ALTER TABLE ci.api_logs
    SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'user_id',
    timescaledb.compress_orderby = 'created_at DESC'
    );
SELECT add_compression_policy('api_logs', INTERVAL '7 days');

-- Basic indexes
CREATE INDEX IF NOT EXISTS idx_api_logs_user_id ON ci.api_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_connection_id ON ci.api_logs(connection_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON ci.api_logs(created_at DESC);

-- JSONB indexes
CREATE INDEX IF NOT EXISTS idx_api_logs_content ON ci.api_logs USING GIN (content);

-- Composite indexes
CREATE INDEX IF NOT EXISTS idx_api_logs_user_created ON ci.api_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_connection_created ON ci.api_logs(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_last_processed ON ci.api_logs(last_processed);
