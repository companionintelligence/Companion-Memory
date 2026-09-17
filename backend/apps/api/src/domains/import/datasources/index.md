# Datasource registration

## Purpose
Register file/API importers through alphabetized side-effect imports. Includes
`macos_activity` for versioned macOS SQLite snapshots.

## Contracts
Catalog, recognition and ParseStage load this barrel to obtain the complete
registry. Never import it from a helper just to use one parser: that would
register every source and introduce initialization cycles.
