-- migrate:up
-- Add dismissed flag to actions and summaries for feed visibility state tracking
ALTER TABLE ci.actions
  ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ci.summaries
  ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE;

-- migrate:down
ALTER TABLE ci.summaries
  DROP COLUMN IF EXISTS dismissed;

ALTER TABLE ci.actions
  DROP COLUMN IF EXISTS dismissed;
