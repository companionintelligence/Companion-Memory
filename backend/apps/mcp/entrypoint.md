# entrypoint.sh

## Purpose
Container entrypoint for `ci-mcp`. Loads secrets, sets reasonable defaults for the internal API URL/port, and validates the two required credentials before starting the Node process.

## Components

### Secret loading block
- **Does**: Reads `CI_API_SERVICE_KEY` and `CI_MCP_AUTH_TOKEN` from the shared secrets file when present
- **Interacts with**: production Docker secrets volume

### Validation block
- **Does**: Fails fast if the upstream service key or inbound MCP bearer token are missing
- **Interacts with**: Docker runtime and deployment diagnostics

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `Dockerfile` | Entry point remains executable and launches `node dist/src/main.js` | Renaming env vars or changing startup contract |
