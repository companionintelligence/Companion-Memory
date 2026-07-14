-- migrate:up
-- Two-tier connect-key scopes (ships with deny-by-default api-key enforcement).
--
-- Reissues 20260711134650, which was never released and is deleted in the same
-- change: that version matched on the key NAME (`name LIKE 'app:%'`), and key
-- names are free-form, so it rewrote a user's hand-made `app:home-assistant` key
-- to an empty scope set — which under deny-by-default means FULL ACCESS. A
-- hardening migration silently widening a key its owner had deliberately confined
-- is the opposite of the intent, so no database should ever run it.
--
-- This version keys off `managed_by` (added in 20260713101410), which the connect
-- flow records at mint time. It therefore cannot touch a user's key at all: for keys
-- minted from this release on, provenance is recorded at the source and is not
-- inferable from anything the user controls; for keys that predate the column,
-- 20260713101410's backfill adopts only the `app:<appName>:<store>` names whose
-- <appName> is a real memory consumer, so a hand-made `app:home-assistant:kitchen`
-- is never stamped and never lands in the UPDATEs below.
--
-- Why re-scope at all: before this release every connect key was minted with the
-- single `memory` scope, and scopes were enforced only on the memory endpoints.
-- Now a scope-limited key is confined to routes that grant one of its scopes, so
-- an already-connected app whose key still says `{memory}` would be 403'd on the
-- endpoints it actually uses. Match `scopesForApp` (ConnectService) so live
-- connections keep working across the deploy:
--
--   - Chat agents (CI-OpenClaw, CI-Hermes) use memory + the intent catalog + the
--     MCP endpoint                                    -> {memory,intents,mcp}
--   - The bulk importer (CI-Import-Tools), and any app whose needs we have not
--     narrowed, reach the graph/ingest/files planes    -> {} (full access)
--
-- Guarded on `scopes = '{memory}'` — the only value the previous release minted —
-- so this is idempotent and a no-op on a database that already ran the deleted
-- version (its keys no longer hold that value).
--
-- `split_part(name,':',2)` is the app name, mirroring `appUrn.split(':')[0]` in
-- scopesForApp; connect keys are named `app:<appName>:<store>`.
UPDATE ci.api_keys SET scopes = '{memory,intents,mcp}'
  WHERE managed_by = 'connect'
    AND scopes = '{memory}'
    AND split_part(name, ':', 2) IN ('ci-openclaw', 'ci-hermes');

-- Catch-all over app names, not a named list, so it mirrors scopesForApp's default
-- exactly and never strands an un-analyzed app's key at `{memory}` (which
-- deny-by-default would then 403 outside /memory/*).
UPDATE ci.api_keys SET scopes = '{}'
  WHERE managed_by = 'connect'
    AND scopes = '{memory}'
    AND split_part(name, ':', 2) NOT IN ('ci-openclaw', 'ci-hermes');

-- migrate:down
-- Restore the uniform `{memory}` the previous release minted, but ONLY for the keys
-- this migration widened to the chat-agent set. The ones it set to `{}` are left
-- alone deliberately: an empty scope set is full access under BOTH the old
-- (grandfathered) and new (deny-by-default) enforcement, so reverting them would be
-- actively harmful — it would 403 CI-Import-Tools on graphql/ingest/files/maintenance
-- if the database were rolled back while this release's code was still running.
UPDATE ci.api_keys SET scopes = '{memory}'
  WHERE managed_by = 'connect' AND scopes = '{memory,intents,mcp}';
