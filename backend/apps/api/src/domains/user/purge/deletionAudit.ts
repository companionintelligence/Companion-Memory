import { v7 as uuidv7 } from 'uuid';

/** Anything that can run parameterised SQL: a `DataSource`, an `EntityManager` or a `QueryRunner`. */
interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Close the `ci.data_deletion_audit` record of an immediate account delete
 * (`POST /users/me/delete`) once the purge has removed the account's last row.
 *
 * That route ends the account in one short transaction and writes a `started`
 * row there; the rows themselves go through this batched purge, inline when it
 * finishes in time and otherwise on a later run (an interrupted purge is picked
 * up by the hourly cron, since its `purge_after` has passed). Whichever run gets
 * to the end appends the `completed` row, with the counts, so the record never
 * depends on the request that started it still being there.
 *
 * A purge that no immediate delete started (the 30-day one) finds no `started`
 * row and writes nothing: `ci.account_purges` is its record. Idempotent: a
 * `started` row already followed by a `completed` one is not completed again.
 *
 * Raw SQL against the privacy domain's table, as `UserService` writes
 * `ci.signup_code`: that domain depends on this one, not the other way round.
 *
 * @returns the id of the `completed` row, or null when there was nothing to close.
 */
export async function completeImmediateDeletionAudit(
  executor: SqlExecutor,
  userId: string,
  deletedRows: Record<string, number>,
): Promise<string | null> {
  const [{ present }] = (await executor.query(
    `SELECT (to_regclass('ci.data_deletion_audit') IS NOT NULL) AS present`,
  )) as Array<{ present: boolean }>;

  if (!present) {
    return null;
  }

  const id = uuidv7();
  const total = Object.values(deletedRows).reduce((sum, count) => sum + count, 0);

  const rows = (await executor.query(
    `WITH started AS (
       SELECT s.requested_by_user_id, s.token_revoked, s.created_at
         FROM ci.data_deletion_audit s
        WHERE s.subject_user_id = $1
          AND s.scope = 'account'
          AND s.status = 'started'
        ORDER BY s.created_at DESC
        LIMIT 1
     ), closed AS (
       INSERT INTO ci.data_deletion_audit
         (id, subject_user_id, requested_by_user_id, scope, token_revoked, deleted_counts, total_deleted, status)
       SELECT $2, $1, started.requested_by_user_id, 'account', started.token_revoked, $3::jsonb, $4, 'completed'
         FROM started
        WHERE NOT EXISTS (
          SELECT 1 FROM ci.data_deletion_audit c
           WHERE c.subject_user_id = $1
             AND c.scope = 'account'
             AND c.status = 'completed'
             AND c.created_at >= started.created_at
        )
       RETURNING id
     )
     SELECT id FROM closed`,
    [userId, id, JSON.stringify(deletedRows), total],
  )) as Array<{ id: string }>;

  return rows[0]?.id ?? null;
}
