# AgentOwnerService.ts

## Purpose
Resolves which CI-Server user the external agent surface should act as. It honors `CI_OWNER_USER_ID` when configured and falls back to the first onboarded user so the Hub integration can still work in single-user installs.

## Components

### `AgentOwnerService`
- **Does**: Resolves the effective owner id and reports whether it was configured or auto-selected
- **Interacts with**: `AgentServiceAuthGuard`, `AgentReadService`, `UserEntity`
- **Rationale**: Hub packaging does not currently provide a clean per-install owner-id input, so a pragmatic single-user fallback is needed

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AgentServiceAuthGuard` | `resolveOwner()` returns a usable owner id or explicit unavailability | Changing return shape |
| `AgentReadService` | Owner selection metadata is stable for capabilities reporting | Renaming selection values |

## Notes
- The fallback is intentionally conservative: first onboarded user, oldest first.
