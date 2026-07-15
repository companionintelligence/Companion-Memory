-- migrate:up
-- Record WHO created an api key, instead of inferring it from the key's name.
--
-- Connect keys are named `app:<appName>:<store>`, and the server treated that
-- prefix as proof the Hub owns the key: `isHubManagedKey` matched on it, and revoke
-- and rotate resolved keys by it. But key names are free-form — a user can create
-- `app:home-assistant` by hand — so provenance was a guess about a value the user
-- controls. Two consequences:
--
--   1. Machinery meant for a connect key operated on a user's key. The previous
--      release's re-scoping migration rewrote EVERY `app:%` key that was not
--      openclaw/hermes to an empty scope set, which under deny-by-default means
--      FULL ACCESS — silently widening a key its owner had deliberately confined.
--   2. The victim could not repair it: `isHubManagedKey` also matched, so the API
--      refused to re-scope the key ("managed by Companion Hub"). The only remedy
--      was to delete it.
--
-- `managed_by` makes ownership explicit and unforgeable. NULL = the user made it,
-- and it stays theirs to rename and re-scope; 'connect' = minted by the Companion
-- Memory consent flow, and the Hub owns its lifecycle.
ALTER TABLE ci.api_keys ADD COLUMN IF NOT EXISTS managed_by TEXT;

COMMENT ON COLUMN ci.api_keys.managed_by IS
  'Who owns this key''s lifecycle: NULL = user-created; ''connect'' = minted by the Companion Memory consent flow.';

-- Backfill.
--
-- There is no unforgeable record of provenance for keys minted BEFORE this column
-- existed, so the backfill has to infer it — and inference is exactly what this
-- change exists to abolish. Keep it as narrow as the facts allow: adopt only the
-- names the consent flow could actually have produced by this release, i.e. the
-- full `app:<appName>:<store>` shape (three colon-separated parts, since an AppUrn
-- is `<appName>:<store>`) AND an <appName> that is a real memory consumer.
--
-- The app-name list is what makes this safe. Matching the name SHAPE alone would
-- adopt a hand-made `app:home-assistant:kitchen` — free-form names were legal until
-- this release — and the re-scope migration that follows would then widen that
-- user's deliberately-confined key to full access and lock them out of repairing it.
-- Anything not matched is left NULL: it stays the user's own, editable key, outside
-- the Hub's revoke/rotate paths.
--
-- Failure mode if a consumer is missing from this list: its pre-existing connect key
-- stays NULL, so the Hub cannot revoke or rotate it and the user sees it as their own
-- key. That fails CLOSED (no silent privilege widening) and self-heals the moment the
-- app reconnects, which re-mints the key with `managed_by` stamped at the source.
UPDATE ci.api_keys SET managed_by = 'connect'
  WHERE name LIKE 'app:%'
    AND split_part(name, ':', 2) IN ('ci-openclaw', 'ci-hermes', 'ci-import-tools')
    AND split_part(name, ':', 3) <> '';

-- Revoke and rotate look a connect key up by name; this is the access path for both.
CREATE INDEX IF NOT EXISTS idx_api_keys_managed_by_name
  ON ci.api_keys (managed_by, name)
  WHERE managed_by IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.idx_api_keys_managed_by_name;
ALTER TABLE ci.api_keys DROP COLUMN IF EXISTS managed_by;
