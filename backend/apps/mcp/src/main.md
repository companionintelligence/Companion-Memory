# main.ts

## Purpose
Entry point for the standalone `ci-mcp` process.

## Components

### Startup block
- **Does**: Creates the default app and starts listening on `CI_MCP_PORT`
- **Interacts with**: `config.ts`, `server.ts`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Docker image / runtime | `node dist/src/main.js` starts the MCP service | Changing the entrypoint module path |
