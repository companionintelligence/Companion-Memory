# server.test.ts

## Purpose
End-to-end protocol coverage for the standalone `ci-mcp` app. The test boots the real Express/MCP server with a stub upstream client and verifies discovery, prompt/resource reads, tool calls, and bearer auth.

## Components

### `supports MCP discovery and tool execution`
- **Does**: Connects via the official Streamable HTTP client transport, then exercises `tools/list`, `resources/list`, `prompts/list`, `resources/read`, `prompts/get`, and `tools/call`
- **Interacts with**: `createApp`, MCP SDK client and schemas

### `rejects unauthenticated MCP requests`
- **Does**: Verifies `/mcp` enforces bearer auth
- **Interacts with**: `authMiddleware` in `server.ts`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| CI for `@ci/be-mcp test` | MCP discovery routes and auth remain functional | Renaming tools/resources/prompts or changing auth behavior |
