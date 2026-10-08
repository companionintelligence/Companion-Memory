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
}

export interface ImportResult {
  tablesImported: number;
  rowsImported: number;
  filesRestored: number;
  format: 'json' | 'ndjson';
}
