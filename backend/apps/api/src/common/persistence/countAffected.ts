import type { EntityManager } from 'typeorm';

/**
 * Run a counting write and return the number of rows it actually touched.
 *
 * `sql` must be the write wrapped in a CTE whose OUTER command is a SELECT:
 *
 *     WITH repointed AS (
 *       UPDATE … RETURNING 1
 *     )
 *     SELECT count(*)::int AS count FROM repointed
 *
 * ── Why never the bare statement ───────────────────────────────────────────
 *
 * `query()` returns the driver's ROWS for a `SELECT` and for an
 * `INSERT … RETURNING`, but for an `UPDATE … RETURNING` or a
 * `DELETE … RETURNING` TypeORM's Postgres runner special-cases the command and
 * resolves the PAIR `[rows, rowCount]` instead
 * (`driver/postgres/PostgresQueryRunner.ts`, typeorm 0.3.30). A bare
 * `UPDATE … RETURNING 1` therefore has `.length === 2` no matter how many rows
 * it hit — including zero — and its `[0]` is the rows array, not the first row.
 * Wrapping makes the outer command a SELECT, so the count is the database's.
 *
 * That constant 2 is not hypothetical: every per-table count
 * `PersonMergeService` and `PlaceMergeService` wrote into
 * `ci.entity_merges.details.counts` was one until this helper replaced
 * `….length`, and a mocked unit suite could not see it — its stub returned rows
 * for a shape the real driver answers with the pair.
 * `domains/memory/services/__tests__/*MergeService.integration.spec.ts` check
 * these counts against rows in Postgres.
 *
 * Anything but exactly one row with an integer `count` THROWS rather than
 * reading as zero: a statement that loses its wrapper must fail the
 * transaction, not record a plausible wrong number in an audit row.
 */
export async function countAffected(
  runner: Pick<EntityManager, 'query'>,
  sql: string,
  params: unknown[],
): Promise<number> {
  const rows: unknown = await runner.query(sql, params);
  const row: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
  const count = row != null && typeof row === 'object' && 'count' in row ? Number(row.count) : Number.NaN;

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      'countAffected expects exactly one row with an integer `count` column; wrap the write as ' +
        '`WITH x AS (… RETURNING 1) SELECT count(*)::int AS count FROM x`',
    );
  }

  return count;
}
