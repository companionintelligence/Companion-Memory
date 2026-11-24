import { v7 as uuidv7 } from 'uuid';

/** Anything that can run parameterised SQL: a `DataSource`, an `EntityManager` or a `QueryRunner`. */
interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Close the `ci.data_deletion_audit` record of an account delete once the purge
 * has removed the account's last row.
 *
 * Both deletes write a `started` row in the transaction that ends the account
 * (the immediate `POST /users/me/delete`, and `DELETE /account` when it revokes
 * the provider grants). The rows themselves go through this batched purge:
 * inline for the immediate delete when it finishes in time, and otherwise on a
 * later run (the hourly cron picks up any account whose `purge_after` has
 * passed). Whichever run gets to the end appends the `completed` row, with the
 * counts, so the record never depends on the request that started it still
 * being there.
 *
 * A purge with no `started` row (an account ended before deletes wrote one)
 * writes nothing: `ci.account_purges` is its record. Idempotent: a `started`
 * row already followed by a `completed` one is not completed again.
 *
 * The `completed` row carries the final revocation outcome of each connection,
 * read from the latest `connection` row written for it since the `started` one
 * (`DataDeletionService.revokePendingGrants` writes one per attempt), with the
 * counts, in `revocations`; and `token_revoked` true only when every grant that
 * needed revoking was revoked (false when any failed, null when there was
 * nothing to revoke). The `started` row of the same delete lists the same
 * connections, every one pending.
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
     ), outcomes AS (
       SELECT DISTINCT ON (a.connection_id)
              a.connection_id,
              a.provider_id,
              CASE
                WHEN a.status = 'failed' THEN 'failed'
                WHEN a.token_revoked IS TRUE THEN 'revoked'
                ELSE 'not_applicable'
              END AS outcome
         FROM ci.data_deletion_audit a, started
        WHERE a.subject_user_id = $1
          AND a.scope = 'connection'
          AND a.connection_id IS NOT NULL
          AND a.created_at >= started.created_at
        ORDER BY a.connection_id, a.created_at DESC, a.id DESC
     ), summary AS (
       SELECT count(*) FILTER (WHERE outcome = 'revoked')::int        AS revoked,
              count(*) FILTER (WHERE outcome = 'not_applicable')::int AS not_applicable,
              count(*) FILTER (WHERE outcome = 'failed')::int         AS failed,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object('connectionId', connection_id, 'providerId', provider_id, 'outcome', outcome)
                  ORDER BY connection_id
                ) FILTER (WHERE connection_id IS NOT NULL),
                '[]'::jsonb
              ) AS connections
         FROM outcomes
     ), closed AS (
       INSERT INTO ci.data_deletion_audit
         (id, subject_user_id, requested_by_user_id, scope, token_revoked, revocations,
          deleted_counts, total_deleted, status)
       SELECT $2, $1, started.requested_by_user_id, 'account',
              CASE
                WHEN summary.failed > 0 THEN false
                WHEN summary.revoked > 0 THEN true
                ELSE NULL
              END,
              jsonb_build_object(
                'revoked', summary.revoked,
                'notApplicable', summary.not_applicable,
                'failed', summary.failed,
                'pending', 0,
                'connections', summary.connections
              ),
              $3::jsonb, $4, 'completed'
         FROM started, summary
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

/**
 * Append the `failed` account-level row of a deletion request that was refused before anything
 * was written (no grant revoker could be resolved). Raw SQL for the reason above. Best-effort:
 * never rejects, so it never hides the refusal it records.
 */
export async function recordRefusedAccountDeletion(
  executor: SqlExecutor,
  userId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  try {
    await executor.query(
      `INSERT INTO ci.data_deletion_audit
         (id, subject_user_id, requested_by_user_id, scope, deleted_counts, total_deleted, status, error)
       VALUES ($1, $2, $2, 'account', '{}'::jsonb, 0, 'failed', $3)`,
      [uuidv7(), userId, message.slice(0, 2000)],
    );
  } catch {
    // The refusal itself is thrown to the caller; the record of it is a courtesy.
  }
}
