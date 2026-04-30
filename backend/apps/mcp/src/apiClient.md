# apiClient.ts

## Purpose
Thin HTTP client for the new `/agent/v1` service-auth API exposed by `ci-api`. This is the only data-access layer used by `ci-mcp`.

## Components

### `CiApiClient`
- **Does**: Wraps the external read endpoints with a small typed interface and injects `X-CI-Service-Key`
- **Interacts with**: `ci-api`, `server.ts`

### `UpstreamApiError`
- **Does**: Preserves upstream HTTP status/body when a call fails
- **Interacts with**: `server.ts` error handling

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `server.ts` | Method names map directly to `/agent/v1/*` routes | Renaming methods or header semantics |
| `ci-api` | Request payloads and query params remain compact JSON | Changing route paths or body shapes |

## Notes
- The client intentionally avoids GraphQL and talks only to the service-auth read API.
