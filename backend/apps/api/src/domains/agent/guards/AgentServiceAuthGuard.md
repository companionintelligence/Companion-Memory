# AgentServiceAuthGuard.ts

## Purpose
Protects the external `/agent/v1` API with a dedicated service key and injects the resolved owner user into request context so the existing user-scoped service layer can be reused unchanged.

## Components

### `AgentServiceAuthGuard`
- **Does**: Validates `X-CI-Service-Key`, resolves the effective owner, and writes it into `ContextService`
- **Interacts with**: `AgentOwnerService`, `ContextService`, `AgentController`
- **Rationale**: External agent traffic should not reuse browser JWT auth or anonymous system context

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AgentController` | Guard injects a valid `userId` into request context | Removing the context injection |
| External callers | Header name remains `X-CI-Service-Key` | Renaming the header or changing failure semantics |

## Notes
- Uses constant-time key comparison to avoid obvious timing leaks.
