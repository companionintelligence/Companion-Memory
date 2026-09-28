import type { UserScopedTable } from './types';

/** Tables that must never leave the server or be restored from an archive. */
export const EXCLUDED_TABLES = new Set([
  'ci.sessions',
  'ci.api_keys',
  'ci.connect_codes',
  'ci.signup_codes',
  'ci.users',
]);

export const USER_DATA_SCHEMAS = ['ci', 'ci_search', 'hbpe'] as const;

/**
 * One row per (table, user-scoping column) — a table carrying BOTH `user_id`
 * and `owner_user_id` yields two rows, exactly as it always has. Each row also
 * carries the table's full column list (`columns`, in ordinal order): the
 * import path checks every archive row's keys against it before they are
 * interpolated into an INSERT as identifiers. Without that check the column
 * list was built from whatever keys the archive named, which turned the
 * import into an arbitrary-SQL primitive for any signed-in user.
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
         ) AS columns
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
