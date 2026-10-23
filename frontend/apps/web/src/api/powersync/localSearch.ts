/**
 * Search answered from this device: the synced `mobile_search_documents` rows through the
 * FTS5 index `searchIndex.ts` builds over them.
 *
 * The result is shaped like the GraphQL `search` connection's nodes — the same
 * `__typename` and the few fields the header box's result rows read — so the
 * rows render through the same components whether the answer came from the
 * appliance or from the phone. Only the types those rows can show are
 * returned; a device document of another type is simply not a suggestion.
 *
 * Ranking is `bm25` with the title weighted over the body, which is what the
 * appliance's `ts_rank` weights (A over B–D) do for the same text. The index
 * stems (FTS5 `porter`, see searchIndex.ts) as Postgres' `english`
 * configuration does, and every term is still matched as a prefix of its stem,
 * so "running" finds "run", "runs" and "runner" — and "runway", the cost of the
 * prefix. Postgres also drops its stopwords before ranking; so does
 * {@link ftsMatchExpression}, from the same list.
 */
import { GlobalUID } from '@ci/common';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { DOCUMENTS_FTS_COLUMNS, DOCUMENTS_FTS_TABLE, DOCUMENTS_TABLE } from './searchIndex';

/** A synced row as the device holds it (the `mobile_search_documents` raw table; see searchIndex.ts). */
export interface DocumentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  title: string | null;
  body: string | null;
  occurred_at: string | null;
  /** The row this one belongs with (a message's conversation, a sub-event's parent ...), or null. */
  related_id: string | null;
  /** The per-type display fields, as the JSON text the sync sent, or null when the type has none. */
  detail: string | null;
}

/**
 * The per-type display fields of a device record, parsed. Which keys appear
 * depends on the type — `direction` and `participants` on a communication,
 * `end_time` and `location_name` on an event, `size` and `content_type` on a
 * file — see the server's `entityDeviceRecordSql` for the full list. Nothing
 * filters or sorts on these, which is why they travel as one JSON value.
 */
export type DocumentDetail = Record<string, unknown>;

/** A device record: the synced row with its `detail` parsed. What the offline pages render. */
export interface LocalDocument {
  id: string;
  entityType: string;
  entityId: string;
  title: string | null;
  body: string | null;
  occurredAt: string | null;
  relatedId: string | null;
  detail: DocumentDetail | null;
}

/** `detail` as an object, or null for no detail or text that is not a JSON object. */
export function parseDetail(text: string | null | undefined): DocumentDetail | null {
  if (text == null || text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DocumentDetail)
      : null;
  } catch {
    return null;
  }
}

/** A synced row as a device record. */
export function toLocalDocument(row: DocumentRow): LocalDocument {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title && row.title.length > 0 ? row.title : null,
    body: row.body && row.body.length > 0 ? row.body : null,
    occurredAt: row.occurred_at,
    relatedId: row.related_id,
    detail: parseDetail(row.detail),
  };
}

/**
 * Document types the header box has a result row for, and the GraphQL type
 * each renders as. `product`, `receipt`, `task`, `browser-activity` and
 * `file-chunk` sync too, but the box has no row component for them (the
 * appliance's results for those render blank today as well; browser activity
 * the box also hides by default, see `useSearchService`), so they are left out
 * here rather than shown as empty rows. The Memory list (`localList.ts`)
 * renders every synced type.
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
  /**
   * The same hits as device records, in the same order, including types the
   * header box has no row for. The offline Memory list renders from these.
   */
  documents: LocalDocument[];
  /** Synced tags whose label starts with the query, as the appliance's `matchingTags`. */
  tags: Array<{ id: string; label: string }>;
}

export const LOCAL_SEARCH_DEFAULT_LIMIT = 25;

/**
 * The FTS5 MATCH for a free-text query: each word a quoted prefix term, OR-joined
 * — the appliance rewrites its tsquery's AND to OR for the same reason, so a
 * two-word query matches a record carrying one of them, and the rank rewards
 * both. Quoting keeps FTS5 operators in the text (AND, NEAR, a colon) from being
 * read as syntax. Stopwords go the way Postgres' `english` configuration drops
 * them — a stemmed index matches "the" in nearly every row and the rank drowns —
 * unless the query is nothing but stopwords, which then searches as typed.
 * `null` when nothing is left to search for.
 */
export function ftsMatchExpression(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return null;
  }

  const meaningful = terms.filter((term) => !ENGLISH_STOPWORDS.has(term));
  const searched = meaningful.length > 0 ? meaningful : terms;

  return searched.map((term) => `"${term}"*`).join(' OR ');
}

/**
 * Postgres' `english` text search configuration's stopword list (the Snowball
 * English list, `english.stop`), which the appliance drops from every query and
 * every indexed text before ranking.
 */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  'i',
  'me',
  'my',
  'myself',
  'we',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'he',
  'him',
  'his',
  'himself',
  'she',
  'her',
  'hers',
  'herself',
  'it',
  'its',
  'itself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'a',
  'an',
  'the',
  'and',
  'but',
  'if',
  'or',
  'because',
  'as',
  'until',
  'while',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'to',
  'from',
  'up',
  'down',
  'in',
  'out',
  'on',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  's',
  't',
  'can',
  'will',
  'just',
  'don',
  'should',
  'now',
]);

/**
 * `bm25()` weights for the text index's columns, in their order: the title
 * over the body, which is what the appliance's `ts_rank` weights (A over B–D)
 * do for the same text.
 */
export const FTS_RANK_WEIGHTS = DOCUMENTS_FTS_COLUMNS.map((column) =>
  column === 'title' ? '10.0' : '1.0',
).join(', ');

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
    // bm25 weights follow DOCUMENTS_FTS_COLUMNS: title, body. The index is
    // external-content, keyed by the documents table's rowid. The unary plus
    // keeps the type term off the (entity_type, occurred_at) index: offered
    // it, SQLite's planner scans every row of those types and probes the FTS
    // index per row — 15 s per keystroke for "lunch" on the S23U, ~0 with
    // the FTS scan driving (see localList.ts, typeTerm).
    sql: `SELECT d.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.related_id, d.detail
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${DOCUMENTS_FTS_TABLE}.rowid
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND +d.entity_type IN (${placeholders})
           ORDER BY bm25(${DOCUMENTS_FTS_TABLE}, ${FTS_RANK_WEIGHTS})
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
    return { nodes: [], documents: [], tags: [] };
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
    documents: rows.map(toLocalDocument),
    tags,
  };
}

/** The query as a LIKE prefix: its own `%`, `_` and `\` escaped. */
export function likePrefix(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
