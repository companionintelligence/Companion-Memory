# macos_activity.ts

## Purpose
Register the macOS activity snapshot as a normal import connection. Recognition
requires a bounded, versioned manifest instead of guessing from arbitrary SQLite.

## Components
- `readManifest`: reads bounded JSON. Recognition claims the format marker even
  for an unsupported version, preventing generic fallback from importing raw
  SQLite. Import validates version, device identity and distinct known sources.
- `MacosActivityFileImporter`: streams read-only snapshots through the existing
  staging writer, reports drops, honors timeframes, and yields for heartbeats.

## Contracts
| Dependent | Expects | Breaking changes |
| --- | --- | --- |
| Export CLI | Fixed `<source>.sqlite` names and v1 manifest | Format changes |
| ParseStage | Counts, drop ledger, visible partial errors | Swallowing errors |
| PushStage | Standard Item records, source_system macos_activity | Source name changes |

## Notes
Only snapshot directories are accepted; the original macOS databases must never
be passed to the importer's move-based inbox. Missing/unavailable/unsupported
sources produce a visible partial error after readable sources have been staged.
Database paths are fixed and realpath-contained; manifests cannot name arbitrary
files. No raw SQLite file becomes content or a model input.
