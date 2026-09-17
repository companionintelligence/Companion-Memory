# export_activity.py

## Purpose
Acquire a portable `ci-macos-activity` v1 snapshot on the Mac that owns the data.
Uses Python's standard library; the server can run on another OS or in Docker.

## Components
- `snapshot`: read-only SQLite online backup, including committed WAL data,
  with a deadline and explicit URI parsing for `mode=ro`. Converts the
  destination to a standalone database.
- `export_activity`: fixed source allowlist, stable hashed device/account label,
  per-source status, private permissions, atomic publication into a new folder.
- `main`: CLI; exit 0 for complete acquisition, 2 for partial/unavailable sources,
  1 for an invalid destination. Never uploads or changes macOS permissions.

## Contracts
| Dependent | Expects | Breaking changes |
| --- | --- | --- |
| `macos_activity.ts` | `macos-activity.json`, version 1, fixed `<source>.sqlite` names | Format/filename changes |
| Operators | Original databases stay in place; repeat device label per account | Device identity changes cause separate records |

## Notes
Snapshot folders contain private data and should be removed after import.
No raw database, path, credentials, or hardware identifier is committed to git.
See `docs/import/macos-activity.md` for supported sources and activation.
