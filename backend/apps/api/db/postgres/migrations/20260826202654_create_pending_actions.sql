-- migrate:up
-- Pending actions — the queue `domains/tools/policy/dispatchPolicy.ts` has always
-- promised and never had.
--
-- `resolveDispatch` returns `decision: 'queue'` with three reasons
-- (destructive-requires-confirmation, external-leaves-appliance,
-- not-local-capable) and its docblock states the product commitment outright:
-- "Both queue for confirmation against the appliance instead." Until now there
-- was nowhere to queue *to*. `resolveDispatch` had exactly one production
-- caller — IntentCatalogService, which only stamps the ruling onto the
-- published manifest — and `ToolRegistry.executeTool` never consulted it at
-- all. `MessagingSendTool`'s docblock asserts "a dispatcher must confirm before
-- this one fires"; nothing did. `ToolRegistry`'s own `privacy.external` branch
-- says of its logger.warn: "It gates nothing today."
--
-- This table is where a queued action is parked so a human can answer it.
--
-- ## Lifecycle
--
--   proposed ──approve──> approved ──execute──> executed   (terminal)
--       │                     │
--       └──decline──> declined (terminal)
--       └──expire───> expired  (terminal)
--
-- Modelled on `ci.asks` and enforced the same way: a pure transition table
-- (`domains/tools/pendingActionStatus.ts`, mirroring `domains/asks/askStatus.ts`)
-- asserted BEFORE any side effect, so an illegal edge throws rather than being
-- silently written.
--
-- `approved` is a real persisted state rather than a moment inside one
-- transaction: the confirmed run goes back through `ToolRegistry.executeTool`,
-- which can fail, refuse, or take as long as the tool takes. A row stuck in
-- `approved` is a run that did not report back, and that is worth being able to
-- see.
--
-- ## Why not an existing table
--
-- `ci.actions` is a dismiss-only feed card with no approve/execute lifecycle
-- (and the summary sidecar's `count_pending_actions_activity` counts THOSE —
-- unrelated to this table despite the shared word). `ci.asks` is an
-- interpersonal question directed at another user's memory, keyed on
-- asker/responder; this is the owner authorising their own appliance to fire an
-- intent. `ci.graph_enrichment_proposals` holds a graph batch to replay through
-- GraphIngestService, not a tool invocation.
--
-- ## Retention
--
-- Two sweeps, both in `PendingActionExpiryCron`, both shipped with this table
-- rather than promised later: overdue `proposed` rows are retired to `expired`,
-- and terminal rows older than 365 days (the house retention convention) are
-- deleted. A confirmation request nobody answered is not an audit record worth
-- keeping forever, and this table accretes one row per queued intent.
CREATE TABLE IF NOT EXISTS ci.pending_actions (
    id           uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id      uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    -- The dotted intent id (`messaging.send`) and the executable tool name
    -- (`messaging_send`). Both are stored: the intent id is what a human-facing
    -- queue should show and what the manifest speaks, the tool name is the key
    -- `ToolRegistry.executeTool` is called back with on approval. Deriving one
    -- from the other at read time would re-implement `intentToolName` in a
    -- second place.
    intent       text NOT NULL,
    tool         text NOT NULL,

    -- The exact tool input, so approving is a replay and never a
    -- re-derivation. `'null'::jsonb` is a legal input; the column is NOT NULL
    -- with a `{}` default so "no input recorded" cannot be confused with
    -- "input was literally null".
    input        jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Why it was queued: a DispatchReason from `resolveDispatch`, or
    -- 'confirmation-required' when the appliance-tier trust dial
    -- (PersonalizationService.decide) asked for review. This is the string a
    -- confirmation prompt shows, which is why the policy reports the MOST
    -- alarming applicable reason rather than the first.
    reason       text NOT NULL,

    -- Which dispatch tier the call arrived from.
    origin       text NOT NULL DEFAULT 'appliance',

    -- The authority the PROPOSING caller held. Recorded because the confirm
    -- path deliberately does NOT reuse it: approval re-runs `capabilityAllows`
    -- against the CONFIRMING principal's capability, so a row proposed by a
    -- full-capability dispatcher does not execute when a read-only key taps
    -- approve. Keeping both sides visible is what makes that auditable.
    actor        text NOT NULL,

    status       text NOT NULL DEFAULT 'proposed',

    created_at   timestamptz NOT NULL DEFAULT now(),
    -- When an unanswered proposal stops being answerable. NULL is allowed and
    -- means "no deadline"; the sweep never touches such a row (a NULL never
    -- satisfies a SQL comparison), matching `ci.asks.expires_at`.
    expires_at   timestamptz,
    resolved_at  timestamptz,

    -- The ToolResult of the confirmed run, so the queue can show what actually
    -- happened rather than only that it was approved.
    result       jsonb,

    CONSTRAINT pending_actions_status CHECK (status IN ('proposed', 'approved', 'executed', 'declined', 'expired')),
    CONSTRAINT pending_actions_origin CHECK (origin IN ('appliance', 'local')),
    CONSTRAINT pending_actions_actor  CHECK (actor IN ('read', 'write', 'full')),
    CONSTRAINT pending_actions_reason CHECK (
        reason IN (
            'destructive-requires-confirmation',
            'external-leaves-appliance',
            'not-local-capable',
            'confirmation-required'
        )
    )
);

COMMENT ON TABLE ci.pending_actions IS
  'Intents ToolRegistry.executeTool refused to run unconfirmed: destructive or external work, or work a local-tier caller may not perform on-device. The owner approves (which replays it through executeTool under the CONFIRMING principal''s capability), declines, or lets it expire. A capability DENIAL is never written here.';

-- The review queue's own read shape: one user's open proposals, newest first.
CREATE INDEX IF NOT EXISTS pending_actions_queue_idx
    ON ci.pending_actions (user_id, status, created_at DESC);

-- The expiry sweep: overdue proposals only. Partial, because the sweep must
-- never scan the terminal rows that make up most of the table over time.
CREATE INDEX IF NOT EXISTS pending_actions_expiry_idx
    ON ci.pending_actions (expires_at)
    WHERE status = 'proposed';

-- The 365-day retention prune.
CREATE INDEX IF NOT EXISTS pending_actions_resolved_idx
    ON ci.pending_actions (resolved_at)
    WHERE resolved_at IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.pending_actions_resolved_idx;
DROP INDEX IF EXISTS ci.pending_actions_expiry_idx;
DROP INDEX IF EXISTS ci.pending_actions_queue_idx;
DROP TABLE IF EXISTS ci.pending_actions;
