-- Plan 09: user consent and privacy preferences.
--
-- Stores per-user data-retention preferences and right-to-erasure requests.
-- One row per user; INSERT OR UPDATE (upsert) semantics in the service layer.
--
-- data_categories:  JSONB map of category name → { enabled: bool, retentionDays: int|null }
-- erasure_requested_at: set by the user via POST /me/erase; null until requested.
-- erasure_completed_at: set by background job once all personal data is purged.

CREATE TABLE IF NOT EXISTS ci.user_consent_preferences (
  user_id              UUID        NOT NULL PRIMARY KEY REFERENCES ci.users(id) ON DELETE CASCADE,
  data_categories      JSONB       NOT NULL DEFAULT '{}',
  erasure_requested_at TIMESTAMPTZ,
  erasure_completed_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  ci.user_consent_preferences IS 'Per-user data retention and consent preferences (plan 09).';
COMMENT ON COLUMN ci.user_consent_preferences.data_categories IS 'Map of category → { enabled, retentionDays }';
COMMENT ON COLUMN ci.user_consent_preferences.erasure_requested_at IS 'Timestamp when user invoked right-to-erasure; null if not requested.';
COMMENT ON COLUMN ci.user_consent_preferences.erasure_completed_at IS 'Timestamp when erasure job finished; null while pending.';
