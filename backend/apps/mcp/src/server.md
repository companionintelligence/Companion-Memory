# server.ts

## Purpose
Hosts the standalone `ci-mcp` HTTP server. It owns inbound bearer auth, MCP session handling, and the translation from MCP tools/resources to `/agent/v1` upstream calls.

## Components

### `createMcpServer`
- **Does**: Registers the public tools, resources, and one usage prompt
- **Interacts with**: `CiApiClient`, MCP SDK `McpServer`
- **Rationale**: The external surface should be explicit and small, not a leak of internal CI-Server tools

### `createApp`
- **Does**: Builds the Express app, exposes `/healthz`, enforces bearer auth on `/mcp`, and manages MCP sessions/transports
- **Interacts with**: `StreamableHTTPServerTransport`, `CiApiClient`

### `createCapabilitiesMarkdown`, `jsonToolResult`, `jsonResource`
- **Does**: Shapes human-readable resource content and machine-friendly JSON payloads
- **Interacts with**: MCP tool/resource callbacks

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Hub MCP registration | `/mcp` stays bearer-protected HTTP and `/healthz` stays unauthenticated | Renaming routes or auth model |
| `tests/server.test.ts` | Session handling follows Streamable HTTP JSON-response mode | Changing transport mode or tool/resource names |

## Notes
- The server returns JSON-response mode over POST rather than long-lived SSE streams to keep the Hub integration simple in v1.
