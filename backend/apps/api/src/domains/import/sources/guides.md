# guides.ts

## Purpose
Authored acquisition instructions for the import wizard, source catalog and
per-user inbox folders. Each guide describes exactly what its parser consumes.

## Components
- `WIZARD_SOURCES`: source cards, grouped by ecosystem with format, acquisition,
  readiness and limitations. macOS Activity uses the portable snapshot exporter
  and explains historical summary backfill and macOS permissions.
- `UPLOAD_STEP`: shared upload instruction for downloaded archives.

## Contracts
Ready guides must reference an implemented registry source. Inbox paths are
relative service folders, never the live source database paths. Changes to IDs,
importer names or paths affect catalog and inbox discovery.
