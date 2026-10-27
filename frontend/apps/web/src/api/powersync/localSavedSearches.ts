/**
 * Saved searches on the phone: the synced `saved_searches` table, read and written locally.
 *
 * Like notes (localNotes.ts), a saved search is something the person authors in this app
 * and may well create or edit offline — "Save this search" from the explorer, a rename, a
 * delete — so on a phone with a replica every saved-search surface reads and writes this
 * table and nothing else, online or off. PowerSync carries the writes up (`connector.ts`
 * replays them through the saved-search mutations, a create with the row's own id so the
 * row that syncs back down is this one) and server changes down. The browser, which
 * syncs nothing, keeps the GraphQL pages.
 *
 * Postgres `text[]` columns and the `filters` jsonb arrive as JSON text and are written
 * back the same way; `is_public` and `is_seed` arrive as 0/1. Sharing is server-managed:
 * the device never writes `is_public` or `share_token`, it only shows them.
 */
import { GlobalUID } from '@ci/common';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { useReplicaQuery } from './replicaQuery';

/** The filter set a saved search stores (mirrors the server's `SavedSearchFilters`). */
export interface LocalSavedSearchFilters {
  eventTypes?: string[] | null;
  datePreset?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  connectors?: string[] | null;
  people?: string[] | null;
  places?: string[] | null;
  hasLocation?: boolean | null;
  semantic?: boolean | null;
  direction?: string | null;
  fileKinds?: string[] | null;
  view?: string | null;
  areas?: number[][] | null;
  bbox?: number[] | null;
}

/** A saved search as the device holds it, with the JSON columns parsed. */
export interface LocalSavedSearch {
  /** The raw uuid, as PowerSync keys the row. */
  id: string;
  name: string | null;
  description: string | null;
  query: string | null;
  entityTypes: string[];
  tags: string[];
  filters: LocalSavedSearchFilters | null;
  isPublic: boolean;
  shareToken: string | null;
  isSeed: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The `saved_searches` row as SQLite hands it back. */
export interface LocalSavedSearchRow {
  id: string;
  name: string | null;
  description: string | null;
  query: string | null;
  entity_types: string | null;
  tags: string | null;
  filters: string | null;
  is_public: number | boolean | string | null;
  is_seed: number | boolean | string | null;
  share_token: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const COLUMNS =
  'id, name, description, query, entity_types, tags, filters, is_public, is_seed, share_token, created_at, updated_at';

/** The list's order: last changed first, as the explorer's Save keeps it ("this search just moved to the top"). */
export const LOCAL_SAVED_SEARCHES_SQL = `SELECT ${COLUMNS} FROM saved_searches ORDER BY updated_at DESC, id DESC`;

export const LOCAL_SAVED_SEARCH_SQL = `SELECT ${COLUMNS} FROM saved_searches WHERE id = ?`;

/** A JSON array of strings, or an empty list for NULL, malformed text or anything that is not one. */
export function parseStringList(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** The filters JSON as an object, or null for NULL, malformed text or a non-object. */
export function parseFilters(text: string | null | undefined): LocalSavedSearchFilters | null {
  if (!text) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as LocalSavedSearchFilters)
      : null;
  } catch {
    return null;
  }
}

/** PowerSync writes a Postgres boolean as 0/1; a local write may have stored a boolean or text. */
export function parseFlag(value: number | boolean | string | null | undefined): boolean {
  return value === 1 || value === true || value === '1' || value === 'true';
}

export function toLocalSavedSearch(row: LocalSavedSearchRow): LocalSavedSearch {
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    query: row.query ?? null,
    entityTypes: parseStringList(row.entity_types),
    tags: parseStringList(row.tags),
    filters: parseFilters(row.filters),
    isPublic: parseFlag(row.is_public),
    shareToken: row.share_token ?? null,
    isSeed: parseFlag(row.is_seed),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Whether `search`'s name, description or tags contain `query` (the appliance's `matchesSavedSearchQuery`). */
export function matchesSavedSearchQuery(search: LocalSavedSearch, query: string): boolean {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return (
    (search.name ?? '').toLowerCase().includes(needle) ||
    (search.description ?? '').toLowerCase().includes(needle) ||
    search.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

/**
 * Every saved search on the phone, kept current as the table changes; filtered in memory
 * like the appliance does (a person's table tops out in the low hundreds). `isSeed`
 * undefined means both the person's own and the starter library.
 */
export function useLocalSavedSearches(options: { query?: string; isSeed?: boolean } = {}): {
  searches: LocalSavedSearch[];
  isLoading: boolean;
  error: Error | undefined;
} {
  const { data, isLoading, error } = useReplicaQuery<LocalSavedSearchRow>(LOCAL_SAVED_SEARCHES_SQL);
  const searches = (data ?? [])
    .map(toLocalSavedSearch)
    .filter((search) => options.isSeed === undefined || search.isSeed === options.isSeed)
    .filter((search) => matchesSavedSearchQuery(search, options.query ?? ''));

  return { searches, isLoading, error };
}

/** One saved search by raw uuid, kept current; `null`/undefined reads nothing. */
export function useLocalSavedSearch(id: string | null | undefined): {
  search: LocalSavedSearch | null;
  isLoading: boolean;
} {
  const enabled = Boolean(id);
  const { data, isLoading } = useReplicaQuery<LocalSavedSearchRow>(
    enabled ? LOCAL_SAVED_SEARCH_SQL : 'SELECT 1 WHERE 0',
    enabled ? [id] : [],
  );
  const row = data?.[0];

  return { search: row ? toLocalSavedSearch(row) : null, isLoading };
}

/** One saved search by raw uuid, once. */
export async function getLocalSavedSearch(
  db: AbstractPowerSyncDatabase,
  id: string,
): Promise<LocalSavedSearch | null> {
  const row = await db.getOptional<LocalSavedSearchRow>(LOCAL_SAVED_SEARCH_SQL, [id]);

  return row ? toLocalSavedSearch(row) : null;
}

/**
 * The shape `applySavedSearchToParams` and the explorer's Save button read: the GraphQL
 * `savedSearch` with its base64 global id. One adapter, so the local row drives the same
 * code the appliance's answer does.
 */
export function toResolvedSavedSearch(search: LocalSavedSearch): {
  id: string;
  name: string | null;
  description: string | null;
  query: string | null;
  entityTypes: string[];
  tags: string[];
  filters: LocalSavedSearchFilters | null;
  isPublic: boolean;
  shareToken: string | null;
  isSeed: boolean;
} {
  return {
    id: GlobalUID.encode('saved-search', search.id),
    name: search.name,
    description: search.description,
    query: search.query,
    entityTypes: search.entityTypes,
    tags: search.tags,
    filters: search.filters,
    isPublic: search.isPublic,
    shareToken: search.shareToken,
    isSeed: search.isSeed,
  };
}

/** An ISO instant the way PowerSync will write it back: it sorts with the server's. */
function now(): string {
  return new Date().toISOString();
}

export interface LocalSavedSearchDefinition {
  name: string;
  description?: string | null;
  query?: string | null;
  entityTypes?: readonly string[] | null;
  tags?: readonly string[] | null;
  filters?: LocalSavedSearchFilters | null;
}

/**
 * Create a saved search under a client-minted id; the id is the search's, permanently.
 * `is_seed` is 0: only the server seeds the starter library.
 */
export async function createLocalSavedSearch(
  db: AbstractPowerSyncDatabase,
  search: LocalSavedSearchDefinition & { id: string },
): Promise<void> {
  const at = now();

  await db.execute(
    `INSERT INTO saved_searches
       (id, name, description, query, entity_types, tags, filters, is_public, share_token, is_seed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`,
    [
      search.id,
      search.name,
      search.description ?? null,
      search.query ?? null,
      JSON.stringify(search.entityTypes ?? []),
      JSON.stringify(search.tags ?? []),
      search.filters ? JSON.stringify(search.filters) : null,
      at,
      at,
    ],
  );
}

/**
 * Overwrite the definition of a saved search. Every stored dimension is written —
 * `null` for an empty query or filter set, `[]` for no tags or types — so "I removed
 * that filter" reaches the row, as the explorer's Update does through GraphQL.
 */
export async function updateLocalSavedSearch(
  db: AbstractPowerSyncDatabase,
  search: LocalSavedSearchDefinition & { id: string },
): Promise<void> {
  await db.execute(
    `UPDATE saved_searches
        SET name = ?, description = ?, query = ?, entity_types = ?, tags = ?, filters = ?, updated_at = ?
      WHERE id = ?`,
    [
      search.name,
      search.description ?? null,
      search.query ?? null,
      JSON.stringify(search.entityTypes ?? []),
      JSON.stringify(search.tags ?? []),
      search.filters ? JSON.stringify(search.filters) : null,
      now(),
      search.id,
    ],
  );
}

/** Rename, or re-describe, without touching what the search does. */
export async function renameLocalSavedSearch(
  db: AbstractPowerSyncDatabase,
  search: { id: string; name: string; description: string | null },
): Promise<void> {
  await db.execute('UPDATE saved_searches SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
    search.name,
    search.description,
    now(),
    search.id,
  ]);
}

export async function deleteLocalSavedSearch(db: AbstractPowerSyncDatabase, id: string): Promise<void> {
  await db.execute('DELETE FROM saved_searches WHERE id = ?', [id]);
}
