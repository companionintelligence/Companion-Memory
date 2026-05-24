-- migrate:up
-- Add 'insight' to the period_type check constraint for proactive insights

ALTER TABLE ci.summaries DROP CONSTRAINT IF EXISTS summaries_period_type_check;

ALTER TABLE ci.summaries ADD CONSTRAINT summaries_period_type_check
CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly', 'seasonal', 'yearly', 'insight'));

-- migrate:down
ALTER TABLE ci.summaries DROP CONSTRAINT IF EXISTS summaries_period_type_check;

ALTER TABLE ci.summaries ADD CONSTRAINT summaries_period_type_check
CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly', 'seasonal', 'yearly'));
