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

export interface UserScopedTable {
  schema: string;
  table: string;
  userColumn: 'user_id' | 'owner_user_id';
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
