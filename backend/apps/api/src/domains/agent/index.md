# index.ts

## Purpose
Registers the external agent read surface as a standalone Nest module. It wires together the existing read-heavy domain modules with the new controller, auth guard, and owner-resolution service.

## Components

### `AgentModule`
- **Does**: Imports the domain modules needed by `/agent/v1`, registers the controller and services, and provides `UserEntity` repository access for owner resolution
- **Interacts with**: `App`, browser/conversation/file/intelligence/memory/note/search/summary modules

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App` | Importing `AgentModule` enables `/agent/v1/*` routes | Renaming the module export |

## Notes
- The module is read-only by construction; it imports no write-specific controller dependencies.
