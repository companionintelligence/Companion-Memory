-- migrate:up
-- Add seen flag to actions and summaries for UI state tracking
ALTER TABLE ci.actions
  ADD COLUMN IF NOT EXISTS seen BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ci.summaries
  ADD COLUMN IF NOT EXISTS seen BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from metadata where available
UPDATE ci.actions
SET seen = COALESCE((metadata->>'seen')::boolean, FALSE)
WHERE metadata IS NOT NULL AND metadata ? 'seen';

UPDATE ci.summaries
SET seen = COALESCE((metadata->>'seen')::boolean, FALSE)
WHERE metadata IS NOT NULL AND metadata ? 'seen';

-- migrate:down
ALTER TABLE ci.summaries
  DROP COLUMN IF EXISTS seen;

ALTER TABLE ci.actions
  DROP COLUMN IF EXISTS seen;
