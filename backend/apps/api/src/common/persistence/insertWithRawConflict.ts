import type { InsertQueryBuilder, ObjectLiteral, QueryRunner } from 'typeorm';

/**
 * Runs an INSERT with a raw `ON CONFLICT <clause>` appended before any RETURNING.
 *
 * TypeORM 0.3 had `.onConflict(clause)`, which emitted ` ON CONFLICT <clause>`
 * verbatim. TypeORM 1.x removed it. Its `.orUpdate()` can only express plain
 * `col = EXCLUDED.col` assignments, and the provenance merges in bulk upsert and
 * graph ingest need arbitrary SET expressions (CASE / COALESCE / merge helpers).
 * So the statement is built by the query builder as before, the same raw clause
 * is spliced in, and the result is executed on the builder's own query runner,
 * so it still joins any transaction the caller opened.
 *
 * Returns the RETURNING rows, which is what `execute().raw` gave in 0.3.
 */
export async function executeInsertWithRawConflict<Entity extends ObjectLiteral>(
  qb: InsertQueryBuilder<Entity>,
  conflictClause: string,
): Promise<Array<Record<string, unknown>>> {
  const template = qb.getQuery();
  const clause = ` ON CONFLICT ${conflictClause}`;
  const returningAt = template.lastIndexOf(' RETURNING ');
  const withConflict =
    returningAt === -1
      ? `${template}${clause}`
      : `${template.slice(0, returningAt)}${clause}${template.slice(returningAt)}`;

  // Named parameters (e.g. `:unionKeys`) are escaped together with the spliced
  // clause, so they resolve exactly as they did when TypeORM 0.3 emitted it.
  const [sql, params] = qb.connection.driver.escapeQueryWithParameters(withConflict, qb.getParameters());

  // `queryRunner` is protected in TypeORM 1.x; reading it is the only way to stay
  // on the builder's connection (and transaction) rather than a fresh one.
  const runner = (qb as unknown as { queryRunner?: QueryRunner }).queryRunner;
  const rows: unknown = runner
    ? await runner.query(sql, params)
    : await qb.connection.manager.query(sql, params);

  return (rows as Array<Record<string, unknown>> | undefined) ?? [];
}
