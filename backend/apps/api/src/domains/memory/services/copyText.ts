import type { CopyColumn } from '../types/bulkIngest';

// =====================================================================
// Postgres COPY text-format encoding (pure, no DB) — unit-tested
// =====================================================================
// The default `COPY ... FROM STDIN` (text) format is tab-separated, one
// row per line, with backslash escapes and `\N` for NULL. Encoding it
// ourselves (rather than COPY CSV) keeps the escaping rules in one tested
// place and sidesteps CSV quoting edge cases.
//
// Reference: https://www.postgresql.org/docs/current/sql-copy.html
//   (text format: \b \f \n \r \t \v and \\ are the recognised escapes;
//    \N is the null marker.)

/** Escape one value into a COPY-text field. `null`/`undefined` ⇒ `\N`. */
export function encodeCopyField(value: unknown): string {
  if (value === null || value === undefined) {
    return '\\N';
  }

  const text =
    typeof value === 'string' ? value : typeof value === 'boolean' ? (value ? 't' : 'f') : String(value);

  // Order matters: escape backslash first, then the whitespace controls that
  // would otherwise be read as row/field delimiters.
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/**
 * Encode one validated record into a COPY-text line (no trailing newline),
 * pulling each column via its spec in COPY order.
 */
export function encodeCopyRow<T>(record: T, columns: ReadonlyArray<CopyColumn<T>>): string {
  return columns.map((column) => encodeCopyField(column.get(record))).join('\t');
}

/** Build the `COPY <table> (col, ...) FROM STDIN` statement for a spec. */
export function buildCopyStatement(stagingTable: string, columns: ReadonlyArray<{ name: string }>): string {
  const columnList = columns.map((column) => `"${column.name}"`).join(', ');

  return `COPY ${stagingTable} (${columnList}) FROM STDIN`;
}

/** Build the `CREATE TEMP TABLE ... ON COMMIT DROP` DDL for a staging table. */
export function buildStagingDdl(
  stagingTable: string,
  columns: ReadonlyArray<{ name: string; ddl: string }>,
): string {
  const columnDefs = columns.map((column) => `"${column.name}" ${column.ddl}`).join(', ');

  // UNLOGGED-equivalent: TEMP tables are not WAL-logged, so the COPY into them
  // is already cheap. ON COMMIT DROP guarantees cleanup even on error paths.
  return `CREATE TEMP TABLE ${stagingTable} (${columnDefs}) ON COMMIT DROP`;
}
