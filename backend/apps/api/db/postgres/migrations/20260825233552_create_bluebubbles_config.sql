-- migrate:up
-- Appliance-wide BlueBubbles (https://github.com/BlueBubblesApp/bluebubbles-app)
-- connection config: a single global row, like the Ollama endpoint config —
-- there is one BlueBubbles server per appliance, not one per user. "Single
-- row" is enforced in the service layer (BlueBubblesConfigService.getOrCreate),
-- not by a DB constraint, matching the existing precedent for this shape.
CREATE TABLE ci.bluebubbles_config (
    id UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    use_https BOOLEAN NOT NULL DEFAULT FALSE,
    -- Full-control credential (BlueBubbles' own server password) stored in
    -- plaintext, consistent with this codebase's existing precedent for
    -- single-appliance service credentials (e.g. the LLM endpoint's apiKey).
    password TEXT NOT NULL,
    has_private_api BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,

    -- Random per-row token (crypto.randomBytes(32).toString('hex')) that forms
    -- an unguessable webhook URL path segment: POST /api/bluebubbles/webhook/:secret.
    webhook_secret TEXT NOT NULL,

    last_sync_cursor TIMESTAMPTZ,
    last_webhook_received_at TIMESTAMPTZ,

    connection_status TEXT NOT NULL DEFAULT 'unknown',
    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT bluebubbles_config_connection_status
        CHECK (connection_status IN ('connected', 'error', 'unknown'))
);

-- migrate:down
DROP TABLE IF EXISTS ci.bluebubbles_config;
