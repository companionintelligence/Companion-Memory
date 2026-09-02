export {
  bulkInsertIdempotent,
  chunkedConflictInsert,
  computeChunkSize,
  conflictUpdateSetClause,
} from './bulkUpsert';
export type { BulkInsertResult, ConflictMergeKind, SourceLedgerOptions, SourceTriple } from './bulkUpsert';
export { appendRecordSources } from './recordSources';
export type { RecordSourceRow } from './recordSources';
export { INGEST_MERGE_KINDS, INGEST_REFRESH_COLUMNS, INGEST_SCHEMA_VERSION } from './ingestRefreshColumns';
export type { IngestEntityKind } from './ingestRefreshColumns';
export { keysetPaginate, resolvePageShape, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './keysetPaginate';
export type { KeysetPageArgs, KeysetPage } from './keysetPaginate';
export {
  assertSchemaIntegrity,
  currentStackKey,
  describeSchemaIntegrity,
  diffMigrations,
  inspectSchemaIntegrity,
  migrationVersionsOnDisk,
  resolveMigrationsDir,
  verifyDatabaseSchema,
  STACK_KEY_SETTING,
} from './schemaIntegrity';
export type {
  DatabaseConnection,
  MigrationDrift,
  SchemaIntegrityInput,
  SchemaIntegrityReport,
  SchemaProbe,
} from './schemaIntegrity';
