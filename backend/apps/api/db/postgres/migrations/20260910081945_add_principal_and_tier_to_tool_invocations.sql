-- migrate:up

-- The three facts the ledger was throwing away.
--
-- `ci.tool_invocations` recorded WHAT ran and with what authority (`capability`,
-- `access`, `destructive`) but not WHO asked or WHERE from. `ToolRegistry`'s
-- `invocationFacts` had `context.tier`, `context.principal` and
-- `context.principalName` in hand at the moment it built the payload and named
-- none of them, so "what did OpenClaw do on my behalf last Tuesday" — the one
-- question an activity page exists to answer — could not be asked of this table.
--
-- All three nullable and NOT backfilled: a row written before this column
-- existed has no honest value. Absent `tier` reads as `appliance`, which is the
-- same default `ToolInvocationContext.tier` already documents, so the NULLs are
-- not a gap so much as the default left unwritten.
ALTER TABLE ci.tool_invocations
    ADD COLUMN IF NOT EXISTS tier           text,
    ADD COLUMN IF NOT EXISTS principal      text,
    ADD COLUMN IF NOT EXISTS principal_name text;

-- Constrain the two closed vocabularies. `principal_name` is free text (an
-- api-key name) and stays unconstrained.
ALTER TABLE ci.tool_invocations
    ADD CONSTRAINT tool_invocations_tier_check
        CHECK (tier IS NULL OR tier IN ('appliance', 'local')),
    ADD CONSTRAINT tool_invocations_principal_check
        CHECK (principal IS NULL OR principal IN ('owner', 'managed-app'));

COMMENT ON COLUMN ci.tool_invocations.tier IS
  'Dispatch tier the call came from (appliance | local). NULL means appliance — the documented default.';
COMMENT ON COLUMN ci.tool_invocations.principal IS
  'WHO called: owner, or managed-app for something the owner installed. NULL on rows predating the column.';
COMMENT ON COLUMN ci.tool_invocations.principal_name IS
  'api_keys.name of the installed app (app:<urn>) when principal is managed-app. NULL otherwise.';

-- The activity page's primary read is "this account, newest first, refusals
-- included", and its second is "what did this app do". The existing
-- (user_id, occurred_at) index serves the first; this serves the second without
-- making it a sequential scan over a year of rows.
CREATE INDEX IF NOT EXISTS tool_invocations_principal_name_occurred_at_idx
    ON ci.tool_invocations (principal_name, occurred_at DESC)
    WHERE principal_name IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.tool_invocations_principal_name_occurred_at_idx;

ALTER TABLE ci.tool_invocations
    DROP CONSTRAINT IF EXISTS tool_invocations_principal_check,
    DROP CONSTRAINT IF EXISTS tool_invocations_tier_check;

ALTER TABLE ci.tool_invocations
    DROP COLUMN IF EXISTS principal_name,
    DROP COLUMN IF EXISTS principal,
    DROP COLUMN IF EXISTS tier;
