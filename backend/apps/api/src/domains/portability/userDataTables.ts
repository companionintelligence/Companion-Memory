import type { UserColumn, UserScopedTable } from './types';

/**
 * Tables that must never leave the server or be restored from an archive.
 *
 * Discovery is catalog-driven (every table with a `user_id` or `owner_user_id`),
 * so a new table of memory data is carried by export and import the day it is
 * created. The price is that a new table of AUTHORITY is carried too, and an
 * import writes every column but the owner straight from the archive. Each
 * entry here is a row that grants access, trusts someone, or makes the server
 * act, which only its own screen (and that screen's checks) may create:
 *
 * - credentials: sessions, api keys, connect and signup codes, the account row;
 * - `ci.federated_identities`: an (issuer, subject) bound here signs that
 *   identity into this account on its next CI-Portal or OIDC sign-in;
 * - `ci.mcp_server_configs`: a stdio config is a command the server runs, which
 *   Settings > MCP servers reserves for an administrator;
 * - `ci.peer_links`, `ci.ask_grants`, `ci.household_tiers`: who may ask this
 *   account what, and at which tier;
 * - `ci.push_subscriptions`: an outside URL the server posts notifications to,
 *   bound to one browser and this appliance's push keys;
 * - `ci.pending_actions`: queued tool calls that run as the owner on approval;
 * - `ci.pipeline_dead_letters`: a replay puts the stored event name and payload
 *   back on the job bus verbatim, and the listeners act for whichever account
 *   or record the payload names, so an archive could queue work against
 *   another account's data;
 * - `ci.account_purges`: the record of an account the purge already destroyed.
 */
export const EXCLUDED_TABLES = new Set([
  'ci.sessions',
  'ci.api_keys',
  'ci.connect_codes',
  'ci.signup_codes',
  'ci.users',
  'ci.federated_identities',
  'ci.mcp_server_configs',
  'ci.peer_links',
  'ci.ask_grants',
  'ci.household_tiers',
  'ci.push_subscriptions',
  'ci.pending_actions',
  'ci.pipeline_dead_letters',
  'ci.account_purges',
]);

export const USER_DATA_SCHEMAS = ['ci', 'ci_search', 'hbpe'] as const;

/**
 * One row per (table, user-scoping column) — a table carrying BOTH `user_id`
 * and `owner_user_id` yields two rows, which {@link groupUserTables} folds into
 * one table. Each row also carries the table's full column list (`columns`, in
 * ordinal order): the import path checks every archive row's keys against it
 * before they are interpolated into an INSERT as identifiers. Without that
 * check the column list was built from whatever keys the archive named, which
 * turned the import into an arbitrary-SQL primitive for any signed-in user.
 */
export const DISCOVER_USER_TABLES_SQL = `
  SELECT c.table_schema AS schema,
         c.table_name AS table,
         c.column_name AS user_column,
         (
           SELECT array_agg(cc.column_name::text ORDER BY cc.ordinal_position)
             FROM information_schema.columns cc
            WHERE cc.table_schema = c.table_schema
              AND cc.table_name = c.table_name
         ) AS columns,
         (
           SELECT array_agg(cc.column_name::text ORDER BY cc.ordinal_position)
             FROM information_schema.columns cc
            WHERE cc.table_schema = c.table_schema
              AND cc.table_name = c.table_name
              AND cc.is_generated = 'ALWAYS'
         ) AS generated,
         (
           SELECT array_agg(DISTINCT pn.nspname || '.' || p.relname)
             FROM pg_constraint k
             JOIN pg_class p ON p.oid = k.confrelid
             JOIN pg_namespace pn ON pn.oid = p.relnamespace
            WHERE k.contype = 'f'
              AND k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
              AND k.confrelid <> k.conrelid
              AND NOT k.condeferred
         ) AS parents
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.column_name IN ('user_id', 'owner_user_id')
    AND t.table_type = 'BASE TABLE'
    AND c.table_schema = ANY($1)
  ORDER BY c.table_schema, c.table_name
`;

/**
 * Quote a SQL identifier the way Postgres requires: wrapped in double quotes
 * with any embedded double quote doubled. Every identifier this domain
 * interpolates comes from the catalog (schema, table, column names discovered
 * above), so a stray quote should be impossible — this is the belt to the
 * column allowlist's braces, so a catalog name that ever did carry one could
 * not break out of the identifier position.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(table: Pick<UserScopedTable, 'schema' | 'table'>): string {
  return `${table.schema}.${table.table}`;
}

export function isExcluded(table: Pick<UserScopedTable, 'schema' | 'table'>): boolean {
  return EXCLUDED_TABLES.has(qualifiedName(table));
}

/** One row of {@link DISCOVER_USER_TABLES_SQL}. */
export interface DiscoveredUserColumn {
  schema: string;
  table: string;
  user_column: string;
  columns?: string[] | null;
  /** Columns the database computes; see {@link UserScopedTable.generatedColumns}. */
  generated?: string[] | null;
  /** Tables this one references through a foreign key that is checked at once (not deferred). */
  parents?: string[] | null;
}

/**
 * Fold discovery's one-row-per-(table, user column) output into one entry per
 * table, minus {@link EXCLUDED_TABLES}, with every table after the tables it
 * references (see {@link orderParentsFirst}) and otherwise in discovery order.
 *
 * Five tables carry both columns (`ci.objects`, `ci.receipts`,
 * `ci.receipt_line_items`, `ci.object_observations`, `ci.product_models`).
 * Treated as two tables, export and the pre-import delete each ran once per
 * column, so they also reached rows whose `user_id` is another account's, and
 * the import set only ONE of the two columns to the importer: the stream path
 * kept whichever entry a `Map` saw last, and the JSON path inserted each row
 * twice. The other column came from the archive, so an import could put rows
 * into someone else's account.
 *
 * Grouped, each table has one owning column ({@link UserScopedTable.userColumn}:
 * `user_id` where the table has it, since `owner_user_id` there is an
 * attribution that the schema nulls on delete) and the full list of user
 * columns, every one of which the import sets to the importer.
 */
export function groupUserTables(rows: readonly DiscoveredUserColumn[]): UserScopedTable[] {
  const byName = new Map<string, UserScopedTable>();
  const parents = new Map<string, string[]>();

  for (const row of rows) {
    if (isExcluded(row)) {
      continue;
    }

    if (Array.isArray(row.parents)) {
      parents.set(qualifiedName(row), row.parents);
    }

    const column = row.user_column as UserColumn;
    const existing = byName.get(qualifiedName(row));

    if (existing) {
      if (!existing.userColumns.includes(column)) {
        existing.userColumns = [...existing.userColumns, column];
      }

      if (column === 'user_id') {
        existing.userColumn = 'user_id';
      }

      continue;
    }

    byName.set(qualifiedName(row), {
      schema: row.schema,
      table: row.table,
      userColumn: column,
      userColumns: [column],
      // Fail closed: a row without a column list can accept no imported rows.
      columns: Array.isArray(row.columns) ? row.columns : [],
      generatedColumns: Array.isArray(row.generated) ? row.generated : [],
    });
  }

  return orderParentsFirst([...byName.values()], parents);
}

/**
 * Put every table after the tables it references, keeping discovery order
 * wherever the foreign keys leave a choice.
 *
 * Export writes tables in this order and import inserts rows in the order the
 * archive gives them (and deletes in the reverse). Import can only switch
 * foreign-key checks off with `session_replication_role`, which the app's role
 * may not set, so a child written before its parent failed the whole import:
 * alphabetically `ci.messages` comes before `ci.threads`, and
 * `ci_search.mobile_search_documents` before `ci_search.vectors`. Deferred
 * constraints are checked at commit and do not count. A cycle, if one ever
 * appears, falls back to discovery order for the tables in it.
 */
export function orderParentsFirst(
  tables: readonly UserScopedTable[],
  parents: ReadonlyMap<string, readonly string[]>,
): UserScopedTable[] {
  const names = new Set(tables.map(qualifiedName));
  const placed = new Set<string>();
  const ordered: UserScopedTable[] = [];
  const pending = [...tables];

  while (pending.length > 0) {
    const ready = pending.findIndex((table) =>
      (parents.get(qualifiedName(table)) ?? []).every((parent) => !names.has(parent) || placed.has(parent)),
    );
    const [next] = pending.splice(ready === -1 ? 0 : ready, 1);

    ordered.push(next);
    placed.add(qualifiedName(next));
  }

  return ordered;
}
