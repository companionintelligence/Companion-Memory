/** Anything that can run parameterised SQL: a `DataSource`, an `EntityManager` or a `QueryRunner`. */
interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** What {@link removeFromAskAudit} did to `ci.ask_audit`. */
export interface AskAuditRemoval {
  /** Rows no other account here is a party to, deleted. */
  deleted: number;
  /** Rows another account here is a party to, kept with this account's side removed. */
  detached: number;
}

/**
 * Take one account out of `ci.ask_audit`, the disclosure record of the asks
 * between accounts (and peers).
 *
 * The table has no foreign key to `ci.users`, on purpose: its migration says the
 * record "must survive deletion of the ask and of either party", because it is
 * the OTHER party's evidence of what was asked of them and what they disclosed.
 * So neither the user row's delete nor the catalog-driven purge (which finds
 * `user_id` / `owner_user_id` columns) ever reached it, and a deleted account's
 * questions and disclosed entity ids stayed behind for good.
 *
 * Both halves of the contract are kept:
 *
 * - **No other account here is a party** (this account asked a peer, a peer
 *   asked this account, or it asked itself): the row is this account's record
 *   alone, read by nobody once it is gone, and is deleted.
 * - **This account ASKED another account**: the row is the responder's
 *   disclosure history and stays. What this account wrote goes: its id, the
 *   prompt text, the filters and the declared actor. The category (`queryType`,
 *   `dataClass`) stays, so the responder's history still says what kind of
 *   question it was. The disclosed entities are the responder's own and stay.
 * - **This account ANSWERED another account**: the row stays for the asker.
 *   This account's id goes, and so do the ids of its entities that were
 *   disclosed or read (`disclosed_entities`, `backing_entities`) and the grant
 *   it answered under (`consent_basis`). The asker's question and the count of
 *   what crossed stay.
 *
 * Idempotent: a second run finds nothing that names the account.
 */
export async function removeFromAskAudit(executor: SqlExecutor, userId: string): Promise<AskAuditRemoval> {
  const [row] = (await executor.query(REMOVE_FROM_ASK_AUDIT_SQL, [userId])) as Array<{
    deleted: number;
    detached: number;
  }>;

  return { deleted: Number(row?.deleted ?? 0), detached: Number(row?.detached ?? 0) };
}

// The three statements touch disjoint rows, so one statement can hold them all.
const REMOVE_FROM_ASK_AUDIT_SQL = `
  WITH own AS (
    DELETE FROM ci.ask_audit
     WHERE (asker_user_id = $1 OR responder_user_id = $1)
       AND (asker_user_id IS NULL OR asker_user_id = $1)
       AND (responder_user_id IS NULL OR responder_user_id = $1)
    RETURNING 1
  ), asked AS (
    UPDATE ci.ask_audit
       SET asker_user_id = NULL,
           query = jsonb_strip_nulls(jsonb_build_object(
             'queryType', query->'queryType',
             'dataClass', query->'dataClass',
             'prompt', ''
           ))
     WHERE asker_user_id = $1
       AND responder_user_id IS NOT NULL
       AND responder_user_id <> $1
    RETURNING 1
  ), answered AS (
    UPDATE ci.ask_audit
       SET responder_user_id = NULL,
           disclosed_entities = '[]'::jsonb,
           backing_entities = '[]'::jsonb,
           consent_basis = NULL
     WHERE responder_user_id = $1
       AND asker_user_id IS NOT NULL
       AND asker_user_id <> $1
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM own)::int AS deleted,
         ((SELECT count(*) FROM asked) + (SELECT count(*) FROM answered))::int AS detached
`;
