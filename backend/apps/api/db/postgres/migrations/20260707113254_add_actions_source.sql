-- migrate:up
-- Provenance discriminator for ci.actions (CI-Engineering #63).
--
-- Producer families sharing this table:
--   'llm-narrative'      — free-LLM narrative actions (backend/apps/summary action_aggregator)
--   'divergence-anomaly' — grounded forecast-vs-actual divergences (HBPE scoring pass, upcoming)
--   'suggestion-engine'  — computed, evidence-linked suggestions (upcoming)
--   'onboarding'         — seeded onboarding cards (OnboardingService)
--   'unspecified'        — legacy rows written before this column existed
--
-- Consumers (feed, anomalies.recent / suggestions.list intents) filter on this
-- column so LLM-invented items are never surfaced as evidence-linked and the
-- tools do not cross-read each other's rows.
ALTER TABLE ci.actions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unspecified';

CREATE INDEX IF NOT EXISTS idx_actions_user_source ON ci.actions (user_id, source);

-- migrate:down
DROP INDEX IF EXISTS ci.idx_actions_user_source;
ALTER TABLE ci.actions DROP COLUMN IF EXISTS source;
