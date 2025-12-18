-- migrate:up
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS dossier JSONB DEFAULT '{}'::jsonb;

-- migrate:down
ALTER TABLE entities
DROP COLUMN IF EXISTS dossier;
