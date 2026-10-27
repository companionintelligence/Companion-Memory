/**
 * The tables a per-connection disconnect purges (`DataDeletionService.disconnectConnection`).
 *
 * A whole-account delete has no hand-kept list any more: `POST /users/me/delete`
 * ends the account and hands its rows to the account purge (`domains/user/purge`),
 * which reads the tables that hold an account's data from the catalog on every run.
 * The list that used to be here duplicated that discovery and had to be kept in step
 * with it by a test. `__tests__/dataDeletionPlan.integration.spec.ts` now checks the
 * purge itself against every column that names an account.
 */

/**
 * Per-connection derived-data tables that carry a direct `connection_id`, so a
 * single connection's derived data can be purged without touching the user's
 * other connections. Ordered children-before-parents (connections last is
 * handled by the service, not here).
 */
export interface ConnectionScopedTable {
  schema: string;
  table: string;
  /** Column holding the connection id (uuid or text). */
  connectionColumn: string;
  /**
   * Set for tables whose rows carry the cross-pipeline identity and are
   * ledgered in ci.record_sources (docs/design/cross-pipeline-identity.md §5).
   * A disconnect then deletes ONLY rows with no remaining ledger evidence
   * from another arrival — a row the Takeout import also delivered survives
   * the disconnect (with its connection_id unlinked) instead of vanishing.
   * `recordTable` is the ledger's record_table value; `pkColumn` the row's
   * primary-key column the ledger's record_id points at.
   */
  recordTable?: string;
  pkColumn?: string;
  /** The table's user-scope column, needed to join the ledger. */
  userColumn?: string;
}

export const CONNECTION_SCOPED_TABLES: readonly ConnectionScopedTable[] = [
  { schema: 'ci_etl', table: 'connection_sync_jobs', connectionColumn: 'connection_id' },
  // The cloud-drive download ledgers. Left behind, they would make a
  // reconnected drive look half-synced to anyone reading them.
  { schema: 'ci_etl', table: 'cloud_file_ingests', connectionColumn: 'connection_id' },
  { schema: 'ci_etl', table: 'cloud_folder_exports', connectionColumn: 'connection_id' },
  // Pointer rows a cloud-drive sync wrote (name, size, link — no bytes here).
  // Only those carry a connection_id; files imported or uploaded do not.
  { schema: 'ci', table: 'files', connectionColumn: 'connection_id' },
  {
    schema: 'ci',
    table: 'communications',
    connectionColumn: 'connection_id',
    recordTable: 'communications',
    pkColumn: 'id',
    userColumn: 'user_id',
  },
  {
    schema: 'ci',
    table: 'content',
    connectionColumn: 'connection_id',
    recordTable: 'content',
    pkColumn: 'id',
    userColumn: 'user_id',
  },
  {
    schema: 'ci',
    table: 'events',
    connectionColumn: 'connection_id',
    recordTable: 'events',
    pkColumn: 'event_id',
    userColumn: 'user_id',
  },
];
