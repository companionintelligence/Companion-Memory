# application.ts

## Purpose
Bootstraps the main Nest application by assembling all domain modules, middleware, global guards, and filters.

## Components

### `App`
- **Does**: Registers infrastructure and domain modules, configures request middleware, and logs lifecycle events
- **Interacts with**: every imported domain module, including `AgentModule`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.ts` | `App` remains the root Nest module | Renaming/export changes |
| All HTTP routes | Middleware and global filters apply consistently | Reordering or removing middleware/guards |

## Notes
- `AgentModule` is imported here so the new `/agent/v1` service-auth API is available in the main app.
