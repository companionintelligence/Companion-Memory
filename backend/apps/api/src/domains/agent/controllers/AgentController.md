# AgentController.ts

## Purpose
Exposes the external read-only `/agent/v1` HTTP surface consumed by `ci-mcp`. Every route is protected by the service-key guard and delegates to `AgentReadService`.

## Components

### `getCapabilities`, `getContext`
- **Does**: Returns discovery metadata and the owner context snapshot
- **Interacts with**: `AgentReadService`

### `search`, `readGraph`, `getRecentActivity`
- **Does**: Exposes the bounded search and graph/activity reads
- **Interacts with**: `ValidationPipe`, request schemas from `types.ts`

### `getThread`, `getDocument`
- **Does**: Exposes thread/document reads with query-bounded expansions
- **Interacts with**: `AgentReadService`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `backend/apps/mcp` | Route paths stay under `/agent/v1/*` | Renaming routes or changing auth header expectations |
| `AgentServiceAuthGuard` | Controller always runs with an injected owner context | Removing the guard |

## Notes
- The controller intentionally does not expose GraphQL passthrough or mutations.
