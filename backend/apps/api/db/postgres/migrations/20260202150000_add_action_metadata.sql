-- migrate:up
-- Add metadata column to actions table for storing additional fields like 'seen'
ALTER TABLE ci.actions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add index for efficient querying of metadata fields (e.g., filtering by seen status)
CREATE INDEX IF NOT EXISTS idx_actions_metadata ON ci.actions USING GIN (metadata);

-- migrate:down
DROP INDEX IF EXISTS ci.idx_actions_metadata;
ALTER TABLE ci.actions DROP COLUMN IF EXISTS metadata;
