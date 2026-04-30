# config.ts

## Purpose
Validates the standalone `ci-mcp` runtime environment. The MCP server is intentionally thin, so all of its behavior is driven from a small env surface.

## Components

### `mcpConfig`
- **Does**: Parses the upstream API URL, service credentials, bearer token, listen port, and optional owner id
- **Interacts with**: `main.ts`, `apiClient.ts`, `server.ts`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.ts` | `CI_API_BASE_URL`, `CI_API_SERVICE_KEY`, and `CI_MCP_AUTH_TOKEN` are present | Renaming env vars |
| Ops/docs | `CI_OWNER_USER_ID` remains optional for display only | Making it hard-required without deployment support |

## Notes
- Owner selection actually happens in `ci-api`; the MCP app keeps the configured owner id only for visibility and debugging.
