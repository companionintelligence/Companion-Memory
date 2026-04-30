# AgentController.test.ts

## Purpose
Exercises the external `/agent/v1` controller wiring: service-key auth and owner-context injection. These tests avoid the real data layer and focus on the public HTTP contract.

## Components

### `Agent routes`
- **Does**: Verifies valid and invalid service-key behavior plus owner scoping into `AgentReadService`
- **Interacts with**: `AgentModule`, `AgentServiceAuthGuard`, `ContextService`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| CI for `@ci/be-api test` | Guard returns 401 on missing/invalid keys and passes resolved owner context on success | Changing route auth behavior or guard injection semantics |

## Notes
- The test dynamically imports `AgentModule` after setting env vars so config-dependent guard behavior matches production wiring.
