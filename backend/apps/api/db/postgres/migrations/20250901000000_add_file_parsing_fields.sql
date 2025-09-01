-- migrate:up
ALTER TABLE files 
ADD COLUMN parsed_content TEXT,
ADD COLUMN parsing_status TEXT DEFAULT 'pending' CHECK (parsing_status IN ('pending', 'processing', 'completed', 'failed')),
ADD COLUMN parsed_metadata JSONB,
ADD COLUMN parsing_error TEXT,
ADD COLUMN parsed_at TIMESTAMPTZ;

CREATE INDEX idx_files_parsing_status ON files (parsing_status);

-- migrate:down
ALTER TABLE files 
DROP COLUMN IF EXISTS parsed_content,
DROP COLUMN IF EXISTS parsing_status,
DROP COLUMN IF EXISTS parsed_metadata,
DROP COLUMN IF EXISTS parsing_error,
DROP COLUMN IF EXISTS parsed_at;

DROP INDEX IF EXISTS idx_files_parsing_status;