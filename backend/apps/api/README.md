# Companion Intelligence — Backend API

This backend application serves as the API for the Compan Intelligence server.

## Getting started

See the [parent README](../../../README.md) for instructions on how to get all the prerequisites installed.

You can boot the backend development server with:

```bash
yarn dev
```

## Migrations

You can create a new database migration with:

```bash
yarn migrate:make <name>
```

This migration can be applied with:

```bash
yarn migrate

# OR

yarn migrate:up
```

You can rollback a migration with:

```bash
yarn migrate:down
```

## Dependency violations

We use dependency cruiser to validate various imports. If the import check build step fails you should
generally fix these violations. Accepting the new violations you're introducing constitutes an increase
in technical debt. You should comment on this in any PR and decide with your PR reviewer if the trade-off
is worth it.

To accept new violations:

```
yarn depcheck:accept
```

## Bulk import integration (CI-Import-Tools)

CI-Server is the ingestion target for normalized records produced by
`CI-Import-Tools` (including Google Takeout, Apple/iCloud exports, and Facebook
downloads).

### GraphQL bulk mutations

Use these authenticated mutations for high-throughput imports:

- `createContents(input: [CreateContentInput!]!): [ContentType!]!`
- `createEvents(input: [CreateEventInput!]!): [EventType!]!`

Both mutations accept arrays so import tooling can process large exports in
batches instead of single-row mutations.

### Recommended import strategy

1. Parse and normalize raw exports in `CI-Import-Tools`
2. Send records to CI-Server in bounded batches (for example 100-1000 records,
   tuned by payload size, API timeout settings, and server memory/CPU headroom)
3. Include source provenance (`sourceData`, `sourceUrl`, `sourceSystem`) so
   records remain attributable to the origin export
4. Track per-batch success/failure and retry failed batches from the importer

### CI-Import-Tools datasource adapters

Source adapters are maintained in:
`https://github.com/companionintelligence/CI-Import-Tools/tree/main/backend/src/datasources`
