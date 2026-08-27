-- migrate:up
-- One row per tool (intent) invocation: WHO called WHAT, from WHERE, and HOW it
-- ended. Written by ToolInvokedListener off the durable `tool.invoked` event,
-- read by GET /api/tools/invocations, pruned by ToolInvocationRetentionCron.
--
-- WHY THIS EXISTS
-- `ToolRegistry` is the one chokepoint every dispatcher goes through (chat, MCP,
-- the REST intent catalog), and until now the only trace of a call was a
-- `logger.debug` in ToolInvokedListener. That answers "is anything happening"
-- from a live log tail and nothing else: not "which key ran memory.forget last
-- Tuesday", not "why did every messaging.send fail after the BlueBubbles
-- upgrade", not "what did the agent try that it was refused".
--
-- WHAT IS DELIBERATELY NOT HERE: REQUEST AND RESPONSE BODIES
-- No tool input, no tool output, no arguments, no result rows. The cap on
-- `error` (500 chars) exists for the same reason and is enforced by a CHECK
-- rather than by the writer's good intentions, because a tool error message is
-- the one field that can carry a fragment of the user's own content back into
-- this table.
--
-- A table that keeps every payload forever is a SECOND COPY of the user's
-- content with none of the deletion paths the first copy has: the account purge
-- discovers `user_id` (see domains/user/purge/purgeCatalog.ts) and would clear
-- the rows, but a per-item deletion — the user forgetting one memory, purging
-- one connection, redacting one message — reaches the original and never
-- reaches a JSONB blob of the arguments some agent passed six months ago. This
-- is exactly how `ci.api_logs` earned its own deletion in migration
-- 20260225011833: a `content JSONB` column, a GIN index over it, a compression
-- policy, and no retention bound at all.
--
-- THIS IS A TRIAGE / TELEMETRY TABLE, DELIBERATELY NOT AN AUDIT LOG.
-- It is best-effort (the emit is wrapped in a try/catch that swallows, because
-- telemetry must not fail an already-completed tool call), it is lossy at the
-- retention edge, and nothing may be inferred from a MISSING row. CI-Server
-- already has the durable records for the questions an audit log answers:
--   * ci.ask_audit          — consent + peer-ask decisions
--   * ci.graph_deltas       — what actually changed in the user's graph
--   * ci.cron_runs          — what the appliance ran on a schedule
--   * ci.data_deletion_audit — that a deletion request was honoured
-- Do not add a compliance claim to this table; add it to one of those.
CREATE TABLE IF NOT EXISTS ci.tool_invocations (
    id              uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

    -- The account the call ran against. NULL for a system/in-process caller
    -- (a background job acting as the appliance itself). CASCADE so an account
    -- deletion takes its ledger with it.
    user_id         uuid REFERENCES ci.users(id) ON DELETE CASCADE,

    occurred_at     timestamptz NOT NULL DEFAULT now(),

    -- Dotted intent id, e.g. `memory.recall`. For a GraphQL-over-MCP tool this
    -- is the GraphQL operation name, which is the only id that plane has.
    intent          text NOT NULL,
    -- Executable name the caller actually used, e.g. `memory_recall`.
    tool            text NOT NULL,
    -- IntentDomainKey (`memory`, `people`, …). NULL on the GraphQL plane, which
    -- has no domain vocabulary. A code constant, so no CHECK and no FK: adding
    -- a domain is a code change, not a migration.
    domain          text,
    -- Which plane served the call: the registry provider name (`native`,
    -- `mcp-client`, …) or `graphql` for the GraphQL-over-MCP path.
    source          text NOT NULL,

    -- RequestContext.traceId — joins this row to the request's log lines.
    correlation_id  uuid,
    -- WHICH api key authenticated, from ApiKeyStrategy (`ci.api_keys.id`). NULL
    -- for a session/JWT caller or an in-process one. No FK: the ledger row must
    -- outlive a revoked key, which is precisely when you want to read it.
    api_key_id      uuid,
    -- The authority the caller stated (ApiKeyCapability: `read` | `write` |
    -- `full`). Paired with `outcome = 'refused'` this is the whole story of a
    -- denied call.
    capability      text,

    -- Privacy facets of the invoked intent, denormalised so a query can ask
    -- "what left the appliance last week" without re-deriving the catalog as it
    -- stood at the time.
    access          text,
    external        boolean NOT NULL DEFAULT false,
    destructive     boolean NOT NULL DEFAULT false,

    -- success  — the tool ran and returned success
    -- error    — the tool ran and returned (or threw) a failure
    -- timeout  — the failure was a deadline, not a defect (error code ends
    --            _TIMEOUT / TIMEOUT); separated because a timeout is an
    --            operator signal and a plain error usually is not
    -- refused   — the capability check denied the call; NOTHING RAN.
    outcome         text NOT NULL CHECK (outcome IN ('success', 'error', 'timeout', 'refused')),
    -- ToolError.code, e.g. `TOOL_FORBIDDEN`, `TOOL_NOT_FOUND`.
    error_code      text,
    -- ToolError.message, truncated by the writer. The CHECK is the backstop:
    -- this is the only column that can carry user content, so the bound is in
    -- the schema and not only in the code that fills it.
    error           text CHECK (error IS NULL OR char_length(error) <= 500),

    duration_ms     integer
);

-- The two read shapes the endpoint offers: a reverse-chronological page for one
-- account, and the same page filtered to one tool.
CREATE INDEX IF NOT EXISTS tool_invocations_user_time_idx
    ON ci.tool_invocations (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS tool_invocations_tool_time_idx
    ON ci.tool_invocations (tool, occurred_at DESC);

-- Retention prune deletes by age across every account, and the "what was
-- refused / what failed" triage query is a partial scan of the same order.
CREATE INDEX IF NOT EXISTS tool_invocations_occurred_at_idx
    ON ci.tool_invocations (occurred_at);
CREATE INDEX IF NOT EXISTS tool_invocations_outcome_time_idx
    ON ci.tool_invocations (outcome, occurred_at DESC)
    WHERE outcome <> 'success';

-- migrate:down
DROP TABLE IF EXISTS ci.tool_invocations;
