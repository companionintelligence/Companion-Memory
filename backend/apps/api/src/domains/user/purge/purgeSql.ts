import type { PurgeScope, TableRef } from './types';

/**
 * SQL rendering for the purge plan. Pure and separate from the executor so the
 * exact statements a destructive job runs can be asserted in a unit test
 * instead of being discovered in production.
 *
 * Every statement takes the account id as `$1`.
 */

/**
 * Catalog identifiers are not user input, but they are interpolated into SQL,
 * so they are validated rather than trusted. A name that cannot appear in this
 * schema is a bug or a compromise; either way the purge should stop.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to build purge SQL for unsafe identifier: ${name}`);
  }

  return `"${name}"`;
}

export function quoteTable(ref: TableRef): string {
  return `${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.table)}`;
}

/** Renders a scope to a boolean expression over the given table's columns. */
export function renderScope(scope: PurgeScope): string {
  if (scope.kind === 'owned') {
    return `${quoteIdentifier(scope.column)} = $1`;
  }

  const parent = quoteTable(scope.parent);
  const parentColumn = quoteIdentifier(scope.parent.column);

  return `${quoteIdentifier(scope.column)} IN (SELECT ${parentColumn} FROM ${parent} WHERE ${renderScope(scope.parentScope)})`;
}

/**
 * One bounded delete.
 *
 * `ctid IN (… LIMIT n)` rather than a plain `DELETE … LIMIT` (which Postgres
 * does not have) or a primary-key keyset (which several of these tables do not
 * have — TimescaleDB requires the partitioning column in any unique index, so
 * some hypertables carry no usable single-column key).
 *
 * `ctid` is only unique **within one physical table**, which is why hypertables
 * are batched chunk by chunk: running this against a hypertable's parent would
 * collect ctids from every chunk and match them against each chunk in turn,
 * deleting rows that merely share a tuple address. See
 * {@link AccountPurgeService} for the chunk expansion.
 */
export function renderBatchedDelete(target: TableRef, scope: PurgeScope, batchSize: number): string {
  const table = quoteTable(target);

  return countingWrapper(
    `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${renderScope(scope)} LIMIT ${assertBatchSize(batchSize)})`,
  );
}

/**
 * One bounded null-out.
 *
 * The `IS NOT NULL` guard is load-bearing, not tidiness: a null step whose scope
 * is not the column it nulls (`ci.users.entity_id` was once nulled by `id = $1`)
 * still matches the row afterwards. Without the guard the batch loop would keep
 * matching the same row, always report a full batch, and never terminate.
 */
export function renderBatchedNull(
  target: TableRef,
  column: string,
  scope: PurgeScope,
  batchSize: number,
): string {
  const table = quoteTable(target);
  const quotedColumn = quoteIdentifier(column);

  return countingWrapper(
    `UPDATE ${table} SET ${quotedColumn} = NULL WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${nullPredicate(quotedColumn, scope)} LIMIT ${assertBatchSize(batchSize)})`,
  );
}

/**
 * One unbatched delete, for a compressed TimescaleDB chunk.
 *
 * A compressed chunk has no `ctid` to batch on (TimescaleDB answers
 * "transparent decompression only supports tableoid system column"), but it
 * does take an ordinary `DELETE … WHERE`, decompressing only the batches the
 * predicate touches. One chunk is one time slice of one hypertable, so the
 * statement is bounded by the chunk rather than by a `LIMIT`.
 */
export function renderUnbatchedDelete(target: TableRef, scope: PurgeScope): string {
  return countingWrapper(`DELETE FROM ${quoteTable(target)} WHERE ${renderScope(scope)}`);
}

/** {@link renderBatchedNull} for a compressed chunk; see {@link renderUnbatchedDelete}. */
export function renderUnbatchedNull(target: TableRef, column: string, scope: PurgeScope): string {
  const quotedColumn = quoteIdentifier(column);

  return countingWrapper(
    `UPDATE ${quoteTable(target)} SET ${quotedColumn} = NULL WHERE ${nullPredicate(quotedColumn, scope)}`,
  );
}

/** The final statement. Unbatched — it is exactly one row. */
export function renderDeleteUser(target: TableRef): string {
  return countingWrapper(`DELETE FROM ${quoteTable(target)} WHERE ${quoteIdentifier('id')} = $1`);
}

/**
 * Wraps a writing statement so it reports its own row count as a `SELECT`.
 *
 * The batch loop terminates on "this batch affected fewer rows than the limit",
 * so the count has to be exact. Reading it from the driver's result would mean
 * depending on the shape TypeORM hands back for `DELETE`/`UPDATE`, which differs
 * between statement kinds; a CTE that ends in `SELECT count(*)` always comes
 * back as ordinary rows.
 */
function countingWrapper(statement: string): string {
  return `WITH purge_batch AS (${statement} RETURNING 1) SELECT count(*)::int AS count FROM purge_batch`;
}

/** The rows a null step still has to touch; see {@link renderBatchedNull} for why the guard matters. */
function nullPredicate(quotedColumn: string, scope: PurgeScope): string {
  return `${renderScope(scope)} AND ${quotedColumn} IS NOT NULL`;
}

function assertBatchSize(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100_000) {
    throw new Error(`Invalid purge batch size: ${batchSize}`);
  }

  return batchSize;
}
