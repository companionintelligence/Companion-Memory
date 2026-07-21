-- migrate:up
ALTER TABLE ci.files
  ADD COLUMN IF NOT EXISTS parse_status text,
  ADD COLUMN IF NOT EXISTS parse_error text,
  ADD COLUMN IF NOT EXISTS parsed_at timestamptz,
  ADD COLUMN IF NOT EXISTS parser_name text,
  ADD COLUMN IF NOT EXISTS parser_version text,
  ADD COLUMN IF NOT EXISTS chunker_version text;

CREATE INDEX IF NOT EXISTS idx_files_parse_status ON ci.files(parse_status) WHERE parse_status IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.idx_files_parse_status;

ALTER TABLE ci.files
  DROP COLUMN IF EXISTS parse_status,
  DROP COLUMN IF EXISTS parse_error,
  DROP COLUMN IF EXISTS parsed_at,
  DROP COLUMN IF EXISTS parser_name,
  DROP COLUMN IF EXISTS parser_version,
  DROP COLUMN IF EXISTS chunker_version;
