import type { TimeFormat } from '@ci/domains/user';

/** Portable archive written by legacy GET /api/account/export (small accounts). */
export interface UserDataArchive {
  version: 1;
  exportedAt: string;
  userId: string;
  profile: UserProfileSnapshot | null;
  tables: Record<string, Record<string, unknown>[]>;
  fileBlobs: FileBlobSnapshot[];
}

export interface UserProfileSnapshot {
  id: string;
  name: string;
  email: string;
  entityId: string | null;
  onboarded: boolean;
  onboardedAt: string | null;
  timezone: string;
  timeFormat: TimeFormat;
  onboardingProgress: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileBlobSnapshot {
  id: string;
  bucket: string;
  key: string;
  contentBase64: string;
}

/** The columns that say which account a row belongs to. */
export type UserColumn = 'user_id' | 'owner_user_id';

export interface UserScopedTable {
  schema: string;
  table: string;
  /**
   * The column that says whose row this is: `user_id` when the table has it,
   * else `owner_user_id`. Export, the pre-import delete and the import's owner
   * stamp all go through this one.
   */
  userColumn: UserColumn;
  /**
   * Every user column the table has (one or both of `user_id`,
   * `owner_user_id`). The import sets each of them to the importer on every
   * row, so no column an archive supplies can name another account.
   */
  userColumns: readonly UserColumn[];
  /**
   * Every column the table has, from the catalog. An archive row may only name
   * columns in this list — the import refuses anything else before it reaches
   * SQL. Empty when discovery could not read the column list, which fails
   * closed (no row for that table can be imported).
   */
  columns: readonly string[];
  /**
   * Columns the database computes (`GENERATED ALWAYS AS (…) STORED`). An export
   * carries their values, but an INSERT naming one is refused, so the import
   * leaves them out and lets the database compute them again.
   */
  generatedColumns?: readonly string[];
  /**
   * Nullable columns that point at another row of the same table (a reply's
   * `parent_message_id`, a merged person's `merged_into_entity_id`), with the
   * column they point at. An export lists rows in storage order, which is not
   * creation order once a row is updated: an edited message moves after the
   * reply to it. So the import holds a row back until the row it names is in,
   * and links what never arrives once every row is in.
   */
  selfReferences?: ReadonlyArray<{ column: string; key: string }>;
  /**
   * Nullable references into a table the import fills AFTER this one, which
   * only a foreign-key cycle produces (`ci.objects.acquisition_line_item_id`
   * while `ci.receipt_line_items.minted_object_id` points back). The import
   * leaves them empty on insert and sets them once every row is in, by
   * {@link primaryKey}.
   */
  laterReferences?: ReadonlyArray<{
    column: string;
    parent: { schema: string; table: string; key: string; userColumn: UserColumn };
  }>;
  /** The table's primary key when it is one column, else null. */
  primaryKey?: string | null;
}

export interface ImportResult {
  tablesImported: number;
  rowsImported: number;
  filesRestored: number;
  format: 'json' | 'ndjson';
}
