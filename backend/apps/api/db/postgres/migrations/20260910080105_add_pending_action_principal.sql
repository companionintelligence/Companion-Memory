-- migrate:up

-- WHO asked, not just what authority they had.
--
-- `actor` records a capability level and `origin` a dispatch tier, so a card
-- could say "something with full authority wants to send a message" and no more.
-- That is not enough to answer it: the whole point of the managed-app gate is
-- that an installed harness is a different principal from the owner, and the
-- owner deciding whether to allow it needs to know WHICH one is asking.
--
-- Nullable, and NOT backfilled. A row proposed before this column existed has no
-- honest value to give it — 'unknown' would be a guess dressed as a fact, and
-- these rows expire in 24 hours anyway, so the gap closes itself.
--
-- Stores the api-key NAME (`app:ci-openclaw:ci-marketplace`), which is the fact.
-- Turning that into "OpenClaw" is presentation and belongs in the card, not in
-- the row — and the display registry lives in another domain that this one may
-- not reach into.
ALTER TABLE ci.pending_actions
    ADD COLUMN IF NOT EXISTS principal_name text;

COMMENT ON COLUMN ci.pending_actions.principal_name IS
  'api_keys.name of the installed app that proposed this action (app:<urn>), or NULL when the owner proposed it themselves.';

-- migrate:down
ALTER TABLE ci.pending_actions
    DROP COLUMN IF EXISTS principal_name;
