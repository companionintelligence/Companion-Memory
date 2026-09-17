# macOS summary and HBPE regression tests

## Purpose
Verify original occurrence windows, clipped durations, privacy/tenancy and
generated-event exclusions, and readable macOS fields in the bounded prompt.
Exercise forced-summary label invalidation and stale-label prevention in actual
PostgreSQL using the migration and the production tokenizer label writer.
An injected classifier verifies that a macOS-enriched narrative reaches both
HBPE classification steps and becomes ordinary 0.7-confidence bucket tokens.

## Contract
The SQL cases require `MACOS_TEST_DATABASE_URL` pointing to an empty disposable
database. They create `ci`/`hbpe` schemas transactionally, refuse existing schemas,
and roll everything back. No live database or model is accessed.
