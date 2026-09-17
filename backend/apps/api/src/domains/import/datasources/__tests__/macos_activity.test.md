# macOS ETL regression tests

## Purpose
Create synthetic SQLite snapshots and exercise recognition, streaming import,
canonical routing and actual destination DTOs. Verify repeat/device identity,
Apple epoch conversion, timeframe/drop reporting and visible partial errors.

## Contracts
No private Mac databases are read. Schema validation and symlink containment
must fail visibly; app spans, Safari titles and call direction/duration must
survive the canonical boundary used by PushStage.
Unsupported manifest versions stay claimed by the specialized importer and fail
validation rather than allowing generic raw-file ingestion.
Optional web metadata, readable boolean states, reversed spans and resolved
out-of-root symlinks have explicit regression cases.
The suite runs under the API's normal Jest and lint configurations.
