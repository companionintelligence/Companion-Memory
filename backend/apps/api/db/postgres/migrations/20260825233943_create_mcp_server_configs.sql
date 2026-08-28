-- migrate:up
-- User-configured connections to external Model Context Protocol servers (stdio or HTTP), which
-- the chat assistant treats as a SECOND tool provider alongside CI-Server's native tools.
--
-- Row-per-server-config, not a JSONB blob on ci.users: connection state
-- (connection_status/last_connected_at/last_error/discovered_tools) is written on every
-- connect/disconnect/error transition by McpClientManagerService, independent of whatever else is
-- happening to the user's settings, and the settings list view reads that state directly rather
-- than live-probing every configured server just to render a status badge.
--
-- Secrets: `env`/`auth` are per-field-encrypted JSONB, not whole-column-encrypted — both mix
-- secret values (an API token) and plain ones (a flag, a hostname) in the same array/object, and a
-- column-level encrypt would force the plain fields through the same decrypt-to-read path for no
-- reason. See McpSecretCodec for the field walk that does the encrypt/decrypt.
CREATE TABLE IF NOT EXISTS ci.mcp_server_configs (
    id                   uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id              uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    name                 text NOT NULL,
    -- URL/tool-namespacing-safe identifier ([a-zA-Z0-9_-] enforced in application code), e.g.
    -- `mcp.<slug>.<toolName>` for a discovered tool's dotted intent id.
    slug                 text NOT NULL,

    transport            text NOT NULL,
    -- stdio
    command              text,
    args                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Array of {key, value, secret, label?}. `value` is ciphertext (McpSecretCodec) when
    -- secret=true, plaintext otherwise.
    env                  jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- http
    url                  text,
    -- {type: 'bearer'|'basic'|'api_key', ...secret fields encrypted per McpSecretCodec}
    auth                 jsonb,

    enabled              boolean NOT NULL DEFAULT true,

    -- Where this config came from. 'catalog' rows additionally carry which suggested-catalog
    -- entry seeded them, so the settings UI can show "added from catalog" and so
    -- McpServerConfigService can re-validate the high-risk acknowledgement independently of
    -- whatever the client claims (see catalog_slug below).
    source               text NOT NULL DEFAULT 'user_added',
    catalog_slug         text,

    -- Cached last successful tools/list response: [{name, description, inputSchema}]. Read by
    -- listTools()/McpToolProvider when the server is not currently connected, so the tool
    -- catalog and the settings UI both have something to show between connection attempts.
    discovered_tools     jsonb,

    connection_status    text NOT NULL DEFAULT 'disconnected',
    last_connected_at    timestamptz,
    last_error           text,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mcp_server_configs_transport_check
        CHECK (transport IN ('stdio', 'http')),
    CONSTRAINT mcp_server_configs_source_check
        CHECK (source IN ('user_added', 'catalog')),
    CONSTRAINT mcp_server_configs_connection_status_check
        CHECK (connection_status IN ('disconnected', 'connecting', 'connected', 'error')),
    -- A stdio config without a command, or an http config without a url, is not a draft — it is
    -- a config that can never connect. Caught here rather than left to the application layer to
    -- remember on every write path (create, update, catalog-seed).
    CONSTRAINT mcp_server_configs_transport_fields_check
        CHECK (
            (transport = 'stdio' AND command IS NOT NULL) OR
            (transport = 'http' AND url IS NOT NULL)
        ),

    CONSTRAINT mcp_server_configs_user_slug_uniq UNIQUE (user_id, slug)
);

COMMENT ON TABLE ci.mcp_server_configs IS
  'User-configured external MCP (Model Context Protocol) servers the chat assistant connects out to as a second tool provider. Never re-exposed on CI-Server''s own outbound /api/intents or MCP server surface.';

-- The settings list view's read shape, and the set onModuleInit sweeps on boot.
CREATE INDEX IF NOT EXISTS mcp_server_configs_user_enabled_idx
    ON ci.mcp_server_configs (user_id, enabled);

-- migrate:down
DROP INDEX IF EXISTS ci.mcp_server_configs_user_enabled_idx;
DROP TABLE IF EXISTS ci.mcp_server_configs;
