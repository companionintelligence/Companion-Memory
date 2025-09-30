-- migrate:up
ALTER TABLE api_logs 
ADD COLUMN processed BOOLEAN DEFAULT false;

-- Create indexes for efficient querying of unprocessed logs
CREATE INDEX idx_api_logs_processed 
ON api_logs (processed) 
WHERE processed = false;

CREATE INDEX idx_api_logs_connection_processed 
ON api_logs (connection_id, processed) 
WHERE processed = false;

CREATE INDEX idx_api_logs_user_processed 
ON api_logs (user_id, processed) 
WHERE processed = false;

-- migrate:down
DROP INDEX IF EXISTS idx_api_logs_user_processed;
DROP INDEX IF EXISTS idx_api_logs_connection_processed;
DROP INDEX IF EXISTS idx_api_logs_processed;
ALTER TABLE api_logs DROP COLUMN processed;
