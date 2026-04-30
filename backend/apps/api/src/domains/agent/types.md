# types.ts

## Purpose
Defines the external `/agent/v1` request schemas and compact response DTOs used by the service-auth agent surface. These shapes are intentionally smaller than the GraphQL types so external MCP calls stay token-efficient.

## Components

### `agentSearchSchema`
- **Does**: Validates external search requests and clamps `maxResults`
- **Interacts with**: `AgentController`, `AgentReadService`

### `agentGraphReadSchema`
- **Does**: Validates graph read requests with bounded traversal
- **Interacts with**: `AgentController`, `AgentReadService`
- **Rationale**: External callers should never control unbounded graph expansion

### `agentRecentActivitySchema`, `agentThreadQuerySchema`, `agentDocumentQuerySchema`
- **Does**: Validates the remaining read endpoints
- **Interacts with**: `AgentController`

### DTO interfaces
- **Does**: Describes the compact payloads returned to `ci-mcp`
- **Interacts with**: `AgentReadService`, `backend/apps/mcp`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AgentController` | Zod schemas enforce request bounds | Renaming fields or widening limits |
| `AgentReadService` | DTOs remain compact and JSON-serializable | Changing field names/types |
| `backend/apps/mcp` | Tool/resource payloads match these DTOs | Removing fields used by MCP responses |

## Notes
- Search mode is limited to the stable public subset even though the internal search service supports additional modes.
