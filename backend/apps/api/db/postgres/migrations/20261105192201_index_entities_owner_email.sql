-- migrate:up
-- The ETL connection syncs (Gmail, Outlook, both calendars) resolve every
-- participant of every message to a Person by email:
--   WHERE owner_user_id = $1 AND properties->>'email' = $2      (PersonService.search)
--   WHERE owner_user_id = $1 AND properties->>'email' IN (...)  (PersonService.findByEmails)
-- Nothing indexed that expression. `ci.entities` has (owner_user_id, is_active,
-- created_at) and the place_id expression index, so each lookup filtered every
-- entity the user owns — once per participant, per message, per sync page.
-- Partial on the expression being present: most entities are not people with
-- an email, and the lookups never ask for a NULL.
CREATE INDEX IF NOT EXISTS entities_owner_email_idx
  ON ci.entities (owner_user_id, (properties->>'email'))
  WHERE properties->>'email' IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.entities_owner_email_idx;
