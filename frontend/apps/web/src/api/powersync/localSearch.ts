/**
 * Search answered from this device: the synced `documents` rows through the
 * FTS5 index `searchIndex.ts` builds over them.
 *
 * The result is shaped like the GraphQL `search` connection's nodes — the same
 * `__typename` and the few fields the header box's result rows read — so the
 * rows render through the same components whether the answer came from the
 * appliance or from the phone. Only the types those rows can show are
 * returned; a device document of another type is simply not a suggestion.
 *
 * Ranking is `bm25` with the title weighted over the body, which is what the
 * appliance's `ts_rank` weights (A over B–D) do for the same text. Postgres
 * stems and SQLite does not, so every term is matched as a prefix: "running"
 * still finds "run", "runs" and "runner", at the cost of also finding
 * "runway".
 */
import { GlobalUID } from '@ci/common';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { DOCUMENTS_FTS_TABLE, DOCUMENTS_TABLE } from './searchIndex';

/** A synced row as the device holds it (`documents` view; see schema.ts). */
export interface DocumentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  title: string | null;
  body: string | null;
  occurred_at: string | null;
}

/**
 * Document types the header box has a result row for, and the GraphQL type
 * each renders as. `product`, `receipt` and `task` sync too, but the box has no
 * row component for them (the appliance's results for those render blank
 * today as well), so they are left out here rather than shown as empty rows.
 */
export const LOCAL_RESULT_TYPENAMES = {
  communication: 'CommunicationType',
  concept: 'ConceptType',
  content: 'ContentType',
  event: 'EventType',
  file: 'FileType',
  item: 'ItemType',
  note: 'NoteType',
  person: 'PersonType',
  place: 'PlaceType',
  thread: 'ThreadType',
} as const;

export type LocalResultEntityType = keyof typeof LOCAL_RESULT_TYPENAMES;

/** One suggestion, shaped like the node the GraphQL search returns for that type. */
export type LocalSearchNode =
  | { __typename: 'CommunicationType'; id: string; preview: string | null; time: string | null }
  | { __typename: 'ConceptType'; id: string; name: string | null }
  | { __typename: 'ContentType'; id: string; title: string | null }
  | { __typename: 'EventType'; id: string; title: string | null; startTime: string | null }
  | { __typename: 'FileType'; id: string; filename: string | null; previewUrl: string | null }
  | { __typename: 'ItemType'; id: string; name: string | null }
  | { __typename: 'NoteType'; id: string; title: string | null }
  | {
      __typename: 'PersonType';
      id: string;
      name: string | null;
      description: string | null;
      filterName: string | null;
    }
  | { __typename: 'PlaceType'; id: string; name: string | null; filterName: string | null }
  | { __typename: 'ThreadType'; id: string; name: string | null; description: string | null };

export interface LocalSearchOptions {
  query: string;
  /** Lower-case entity types (the GraphQL `includeTypes` convention). Wins over `excludeTypes`. */
  includeTypes?: string[];
  excludeTypes?: string[];
  limit?: number;
}

export interface LocalSearchResult {
  nodes: LocalSearchNode[];
  /** Synced tags whose label starts with the query, as the appliance's `matchingTags`. */
  tags: Array<{ id: string; label: string }>;
}

export const LOCAL_SEARCH_DEFAULT_LIMIT = 25;

/**
 * The FTS5 MATCH expression for a free-text query: each word as a quoted
 * prefix term, OR-joined so a row matching more words ranks higher without a
 * row matching fewer being dropped — the appliance's `websearch_to_tsquery`
 * rewrite does the same. Quoting keeps FTS syntax (`AND`, `NEAR`, `-`, `:`) in
 * the user's text from being read as operators. `null` when nothing is left
 * to search for.
 */
export function ftsMatchExpression(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `"${term}"*`).join(' OR ');
}

/** The entity types a search is scoped to, after include/exclude, in the box's lower-case convention. */
export function resolveLocalTypes(includeTypes?: string[], excludeTypes?: string[]): LocalResultEntityType[] {
  const all = Object.keys(LOCAL_RESULT_TYPENAMES) as LocalResultEntityType[];
  const normalize = (types: string[]) => new Set(types.map((type) => type.toLowerCase()));

  if (includeTypes && includeTypes.length > 0) {
    const include = normalize(includeTypes);

    return all.filter((type) => include.has(type));
  }

  const exclude = normalize(excludeTypes ?? []);

  return all.filter((type) => !exclude.has(type));
}

/** A synced document as the node the header box renders for its type. */
export function documentToNode(row: DocumentRow): LocalSearchNode | null {
  const type = row.entity_type as LocalResultEntityType;
  const typename = LOCAL_RESULT_TYPENAMES[type];

  if (!typename) {
    return null;
  }

  const id = GlobalUID.encode(type, row.entity_id);
  const title = row.title && row.title.length > 0 ? row.title : null;
  const body = row.body && row.body.length > 0 ? row.body : null;

  switch (typename) {
    case 'CommunicationType':
      return { __typename: typename, id, preview: title ?? body, time: row.occurred_at };

    case 'EventType':
      return { __typename: typename, id, title, startTime: row.occurred_at };

    case 'FileType':
      // No signed URL offline; the row falls back to its icon.
      return { __typename: typename, id, filename: title, previewUrl: null };

    case 'ContentType':
    case 'NoteType':
      return { __typename: typename, id, title };

    case 'PersonType':
      return { __typename: typename, id, name: title, description: body, filterName: title };

    case 'PlaceType':
      return { __typename: typename, id, name: title, filterName: title };

    case 'ThreadType':
      return { __typename: typename, id, name: title, description: body };

    case 'ConceptType':
    case 'ItemType':
      return { __typename: typename, id, name: title };

    default:
      return null;
  }
}

/** The SQL and parameters for one search. Exported for the test; `searchLocal` runs it. */
export function localSearchStatement(options: LocalSearchOptions): { sql: string; params: unknown[] } | null {
  const match = ftsMatchExpression(options.query);
  const types = resolveLocalTypes(options.includeTypes, options.excludeTypes);

  if (!match || types.length === 0) {
    return null;
  }

  const placeholders = types.map(() => '?').join(', ');
  const limit = options.limit ?? LOCAL_SEARCH_DEFAULT_LIMIT;

  return {
    // bm25 weights follow DOCUMENTS_FTS_COLUMNS: id (unindexed), title, body.
    sql: `SELECT d.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.id = ${DOCUMENTS_FTS_TABLE}.id
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND d.entity_type IN (${placeholders})
           ORDER BY bm25(${DOCUMENTS_FTS_TABLE}, 0.0, 10.0, 1.0)
           LIMIT ?`,
    params: [match, ...types, limit],
  };
}

export async function searchLocal(
  db: AbstractPowerSyncDatabase,
  options: LocalSearchOptions,
): Promise<LocalSearchResult> {
  const statement = localSearchStatement(options);

  if (!statement) {
    return { nodes: [], tags: [] };
  }

  const [rows, tags] = await Promise.all([
    db.getAll<DocumentRow>(statement.sql, statement.params),
    db.getAll<{ id: string; label: string }>(
      `SELECT id, label FROM tags WHERE deleted_at IS NULL AND label LIKE ? ESCAPE '\\' ORDER BY label LIMIT 5`,
      [`${likePrefix(options.query.trim())}%`],
    ),
  ]);

  return {
    nodes: rows.map(documentToNode).filter((node): node is LocalSearchNode => node != null),
    tags,
  };
}

/** The query as a LIKE prefix: its own `%`, `_` and `\` escaped. */
export function likePrefix(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
