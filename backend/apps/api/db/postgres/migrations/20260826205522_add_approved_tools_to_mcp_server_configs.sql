-- migrate:up
-- Tool-level approval for external MCP servers.
--
-- Before this column, `discovered_tools` was the ONLY tool state on the row: McpClientManagerService
-- ran tools/list on every connect/reconnect, wrote the answer straight into `discovered_tools`, and
-- McpToolProvider rebuilt the assistant's tool cache from that column with nothing to compare it
-- against. Adding the server was therefore a standing grant over whatever that server chose to offer
-- later — a renamed argument, a widened schema, or an entirely new tool appeared in chat silently.
--
-- `approved_tools` is the grant. It holds the set a human actually reviewed:
--   [{"name": "...", "schemaDigest": "<sha256 hex>", "approvedAt": "<iso8601>", "approvedBy": "<uuid>"}]
--
-- schemaDigest is sha256 over the CANONICALISED inputSchema (recursively sorted object keys, every
-- `description`/`title` stripped, array order preserved) — see `services/mcpToolDigest.ts`. Prose
-- churn upstream is not a capability change and must not read as drift, or the UI cries wolf and
-- people switch the gate off.
--
-- NULL vs '[]' is load-bearing and is NOT a "column added, backfill later" gap:
--   NULL -> a row that predates this migration. Its tools keep working (legacy passthrough in
--           `isToolApproved`) until McpClientManagerService's next successful connect, which
--           grandfathers whatever that server currently offers into an explicit approved set
--           stamped `approvedBy: 'legacy:grandfathered'`. From that point drift is caught.
--   '[]'  -> gated with nothing approved. Every config created after this migration starts here,
--           so a newly added server contributes ZERO tools to chat until someone approves them.
-- A SQL backfill is deliberately not attempted: the digest has to match the TypeScript
-- canonicalisation byte for byte, and a second implementation in plpgsql would be a second source
-- of truth that silently disagrees.
ALTER TABLE ci.mcp_server_configs
    ADD COLUMN IF NOT EXISTS approved_tools jsonb;

COMMENT ON COLUMN ci.mcp_server_configs.approved_tools IS
  'Human-approved tool set: [{name, schemaDigest, approvedAt, approvedBy}]. McpToolProvider intersects discovered_tools against this, so an unapproved or schema-drifted tool is invisible to chat, not merely flagged. NULL means a pre-approval-gate row, grandfathered on next connect; ''[]'' means gated with nothing approved.';

-- migrate:down
ALTER TABLE ci.mcp_server_configs
    DROP COLUMN IF EXISTS approved_tools;
