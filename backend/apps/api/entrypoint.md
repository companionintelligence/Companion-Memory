# entrypoint.sh

## Purpose
Container entrypoint for the backend API. Loads secrets from the shared secrets volume, exports them for the Node process, and validates the core runtime credentials.

## Components

### Secret loading block
- **Does**: Reads auth, database, object-store, and agent service-key values from the shared secrets file when present
- **Interacts with**: production Docker secrets volume, `configuration.ts`

### Validation block
- **Does**: Hard-fails on core API secrets and warns when the external agent service key is missing
- **Interacts with**: deployment startup diagnostics

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `configuration.ts` | Exported env vars are available before Node boot | Renaming env vars |
| `/agent/v1` routes | `CI_API_SERVICE_KEY` is loaded when configured | Removing the export |

## Notes
- `CI_OWNER_USER_ID` is exported when present but not required at boot because owner selection can fall back to the first onboarded user.
