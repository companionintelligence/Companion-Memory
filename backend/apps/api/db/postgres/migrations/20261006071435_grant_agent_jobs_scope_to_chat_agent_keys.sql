-- migrate:up
-- `/v1/agent/jobs` moves off the `memory` scope onto its own `agent-jobs`
-- scope, which ConnectService.scopesForApp now mints for the chat-agent tier
-- (ci-openclaw, ci-hermes) only. Memory-only apps (ci-ha-voice, ci-mentra,
-- ci-glasses-bridge) keep `{memory}` and lose the job routes, which is the point.
--
-- Keys already minted for the two chat agents say `{memory,intents,mcp}` and
-- would be refused on the job routes until CI-Hub rotates them, which it does
-- only once a key is 60 days old. CI-OpenClaw fetches a job's packet and
-- checkpoints it with that key, so dispatch would stop working for up to two
-- months. Add the scope to those keys now instead.
--
-- Same targeting as 20260713102642: `managed_by = 'connect'` (provenance the
-- connect flow records, which a user cannot set), with the app name taken
-- from `app:<appName>:<store>` only once provenance has vouched for it. A
-- user's hand-made key is never touched.
--
-- An EMPTY scope set is left alone: it already reaches every route, and
-- appending a scope would turn it into a scope-limited key confined to the job
-- routes. Idempotent: a key that already holds the scope is skipped.
UPDATE ci.api_keys
   SET scopes = array_append(scopes, 'agent-jobs')
 WHERE managed_by = 'connect'
   AND split_part(name, ':', 2) IN ('ci-openclaw', 'ci-hermes')
   AND cardinality(scopes) > 0
   AND NOT ('agent-jobs' = ANY (scopes));

-- migrate:down
-- Older code requires `memory` on the job routes and never mints this scope,
-- so removing it restores the previous keys exactly.
UPDATE ci.api_keys
   SET scopes = array_remove(scopes, 'agent-jobs')
 WHERE managed_by = 'connect'
   AND 'agent-jobs' = ANY (scopes);
