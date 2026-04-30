# configuration.ts

## Purpose
Parses runtime configuration for the backend API using `config` plus Zod validation.

## Components

### `ConfigSchema`
- **Does**: Validates the full runtime config tree, now including the external agent surface settings
- **Interacts with**: every config consumer in `backend/apps/api`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AgentServiceAuthGuard` | `config.agent.serviceKey` and `config.agent.ownerUserId` exist | Renaming or removing these keys |
| existing API modules | Existing config keys remain stable | Schema shape changes |

## Notes
- `agent.ownerUserId` may be blank at boot; owner resolution can fall back to the first onboarded user.
