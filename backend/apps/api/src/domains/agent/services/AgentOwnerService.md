# AgentOwnerService

## Intent

`AgentOwnerService` resolves the CI user id that the external agent surface is allowed to act as.

## Rationale

The external MCP surface is a cross-boundary read interface. It must not infer ownership from the application database, because doing so can expose the wrong user's data in multi-user environments. Ownership is therefore explicit:

- if `CI_OWNER_USER_ID` is configured, that user is the sole owner for the external agent surface
- if it is not configured, the owner is treated as unavailable and `/agent/v1/*` fails closed

## Contract

- `resolveOwner()` returns `configured` only when `CI_OWNER_USER_ID` is non-empty
- `resolveOwner()` never falls back to "first onboarded user" or any other heuristic
- callers must treat `unavailable` as a configuration error, not as a prompt to guess
