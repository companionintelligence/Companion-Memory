import type { FkDeleteAction, FkEdge, TableRef, UserRefColumn } from './types';

/**
 * Reads the shape of the schema the purge has to work through, straight from
 * the Postgres catalog.
 *
 * Discovery — rather than a table list committed to the repo — is the whole
 * point: a list is wrong the day someone adds the next user-scoped table, and it
 * is wrong *silently*, because the purge still reports success. Reading the
 * catalog means a new table is covered the run after it is created.
 */

/** Anything that can run parameterised SQL — `DataSource` or a `QueryRunner`. */
export interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Schemas that never hold account data. Everything else is scanned, so a new
 * schema is covered without anyone remembering to add it here.
 */
const IGNORED_SCHEMA_PATTERNS = ['pg\\_%', 'information\\_schema', '\\_timescaledb%', 'timescaledb\\_%'];

/**
 * Column names that mean "this row belongs to this account" on tables with no
 * foreign key to `ci.users`. The convention is consistent across the schema;
 * these two names cover all fourteen such tables today.
 */
const CONVENTION_COLUMNS = ['user_id', 'owner_user_id'];

/**
 * Columns that look user-scoped and are not.
 *
 * `ci.account_purges.user_id` names the account a purge destroyed. It matches
 * the convention exactly — a `uuid user_id` with no foreign key, because a
 * foreign key to a row this job deletes is impossible — so discovery classified
 * it as account data and the purge deleted its own audit record on the way past,
 * leaving no evidence that the deletion had been honoured. Excluded here rather
 * than left to `accountDeletion.purge.excludedColumns`, because it is a property
 * of this feature and not of any one deployment's configuration.
 *
 * Anything added here needs the same kind of note: why the column is not the
 * account's data. Silence would be a retention hole with a config file in front
 * of it.
 */
const BUILT_IN_EXCLUSIONS = ['ci.account_purges.user_id'];

const USER_REF_FK_SQL = `
  SELECT con.conname                       AS constraint_name,
         child_ns.nspname                  AS schema,
         child.relname                     AS "table",
         att.attname                       AS column,
         con.confdeltype                   AS delete_action
  FROM pg_constraint con
  JOIN pg_class child           ON child.oid = con.conrelid
  JOIN pg_namespace child_ns    ON child_ns.oid = child.relnamespace
  JOIN pg_attribute att         ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
  WHERE con.contype = 'f'
    AND con.confrelid = $1::regclass
    AND cardinality(con.conkey) = 1
    AND child_ns.nspname NOT LIKE ALL ($2::text[])
  ORDER BY 2, 3, 4
`;

/**
 * User-scoped columns Postgres knows nothing about. `ci_search.embeddings`,
 * `ci_search.vectors`, `ci.browser_activity` and eleven others carry a `uuid`
 * `user_id` with no foreign key — the vector form of the user's memories, their
 * browsing capture, their file chunks. Anything that trusted foreign keys alone
 * would leave all of it behind and call the account deleted.
 */
const USER_REF_CONVENTION_SQL = `
  SELECT ns.nspname   AS schema,
         c.relname    AS "table",
         a.attname    AS column
  FROM pg_attribute a
  JOIN pg_class c        ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
  JOIN pg_namespace ns   ON ns.oid = c.relnamespace
  WHERE a.attname = ANY ($3::text[])
    AND NOT a.attisdropped
    AND a.atttypid = 'uuid'::regtype
    AND ns.nspname NOT LIKE ALL ($2::text[])
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.conrelid = c.oid
        AND con.confrelid = $1::regclass
        AND a.attnum = ANY (con.conkey)
    )
  ORDER BY 1, 2, 3
`;

const FK_EDGE_SQL = `
  SELECT con.conname                AS constraint_name,
         child_ns.nspname           AS child_schema,
         child.relname              AS child_table,
         child_att.attname          AS child_column,
         parent_ns.nspname          AS parent_schema,
         parent.relname             AS parent_table,
         parent_att.attname         AS parent_column,
         con.confdeltype            AS delete_action
  FROM pg_constraint con
  JOIN pg_class child           ON child.oid = con.conrelid
  JOIN pg_namespace child_ns    ON child_ns.oid = child.relnamespace
  JOIN pg_class parent          ON parent.oid = con.confrelid
  JOIN pg_namespace parent_ns   ON parent_ns.oid = parent.relnamespace
  JOIN pg_attribute child_att   ON child_att.attrelid = con.conrelid AND child_att.attnum = con.conkey[1]
  JOIN pg_attribute parent_att  ON parent_att.attrelid = con.confrelid AND parent_att.attnum = con.confkey[1]
  WHERE con.contype = 'f'
    AND cardinality(con.conkey) = 1
    AND child_ns.nspname NOT LIKE ALL ($1::text[])
    AND parent_ns.nspname NOT LIKE ALL ($1::text[])
  ORDER BY con.conname
`;

export async function readUserRefColumns(
  executor: SqlExecutor,
  usersTable: TableRef,
  excluded: string[] = [],
): Promise<UserRefColumn[]> {
  const usersRegclass = `${usersTable.schema}.${usersTable.table}`;
  const excludedSet = new Set([...BUILT_IN_EXCLUSIONS, ...excluded]);

  const fkRows = (await executor.query(USER_REF_FK_SQL, [usersRegclass, IGNORED_SCHEMA_PATTERNS])) as Array<{
    constraint_name: string;
    schema: string;
    table: string;
    column: string;
    delete_action: string;
  }>;

  const conventionRows = (await executor.query(USER_REF_CONVENTION_SQL, [
    usersRegclass,
    IGNORED_SCHEMA_PATTERNS,
    CONVENTION_COLUMNS,
  ])) as Array<{ schema: string; table: string; column: string }>;

  const columns: UserRefColumn[] = [
    ...fkRows.map((row) => ({
      schema: row.schema,
      table: row.table,
      column: row.column,
      deleteAction: row.delete_action as FkDeleteAction,
      constraintName: row.constraint_name,
    })),
    ...conventionRows.map((row) => ({
      schema: row.schema,
      table: row.table,
      column: row.column,
      deleteAction: null,
      constraintName: null,
    })),
  ];

  return columns.filter((column) => !excludedSet.has(`${column.schema}.${column.table}.${column.column}`));
}

export async function readFkEdges(executor: SqlExecutor): Promise<FkEdge[]> {
  const rows = (await executor.query(FK_EDGE_SQL, [IGNORED_SCHEMA_PATTERNS])) as Array<{
    constraint_name: string;
    child_schema: string;
    child_table: string;
    child_column: string;
    parent_schema: string;
    parent_table: string;
    parent_column: string;
    delete_action: string;
  }>;

  return rows.map((row) => ({
    constraintName: row.constraint_name,
    childSchema: row.child_schema,
    childTable: row.child_table,
    childColumn: row.child_column,
    parentSchema: row.parent_schema,
    parentTable: row.parent_table,
    parentColumn: row.parent_column,
    deleteAction: row.delete_action as FkDeleteAction,
  }));
}

/**
 * The physical tables a logical target expands to.
 *
 * For an ordinary table that is the table itself. For a TimescaleDB hypertable
 * it is the chunk list, because the batch loop keys on `ctid` and a `ctid` is
 * only unique inside one physical table — batching against the hypertable's
 * parent would match tuple addresses collected from one chunk against the rows
 * of another. Chunks are plain tables, so per-chunk batching is both correct and
 * cheaper to plan.
 *
 * Returns `[target]` unchanged when TimescaleDB is not installed, which is what
 * makes the same code path work against a test database without the extension.
 */
export async function expandToPhysicalTables(executor: SqlExecutor, target: TableRef): Promise<TableRef[]> {
  const installed = (await executor.query(
    `SELECT 1 AS present FROM pg_extension WHERE extname = 'timescaledb'`,
  )) as unknown[];

  if (installed.length === 0) {
    return [target];
  }

  const chunks = (await executor.query(
    `SELECT chunk_schema AS schema, chunk_name AS "table"
       FROM timescaledb_information.chunks
      WHERE hypertable_schema = $1 AND hypertable_name = $2
      ORDER BY 1, 2`,
    [target.schema, target.table],
  )) as Array<{ schema: string; table: string }>;

  return chunks.length > 0 ? chunks : [target];
}
