/**
 * The offline Memory list: a page of device records from this phone's synced
 * `mobile_search_documents`, for the explorer (`/memory`) when the appliance
 * does not answer. The header box's suggestions are `localSearch.ts`; this is
 * the committed search and the browse behind it, with paging, a sort, and the
 * filters the device can honour.
 *
 * Every explorer filter but semantic search applies offline, each read the
 * way the appliance reads it: the text query (FTS5, prefix-matched like the
 * suggestions), the type scope, tags (EVERY listed label, through the synced
 * `entity_tag` and `tags` — `TagService.getEntitiesForTags`), a date range
 * over `occurred_at`, and the structured filters over the record's `detail`:
 *
 * - connectors: `source_system`, on every type that has one.
 * - direction: a message's `direction`; pins the scope to messages. Indexed
 *   with time so its count is index-only.
 * - eventTypes: an event's `event_type`; pins the scope to events.
 * - fileKinds: a file's `content_type` family; pins the scope to files.
 * - people: names, matched as substrings against the phone's person records,
 *   whose ids are then looked for on the record — a message's `from_id` /
 *   `to_ids` (direction binds the role: received FROM, sent TO), an event's
 *   `people`. Pins the scope to messages and events. Two plans, chosen by
 *   how many records name the person — see {@link planPeople}.
 * - places: names against the phone's place records (`location_id`) or the
 *   event's own `location_name`; hasLocation and map areas: `lat` / `lng`.
 *   All three pin the scope to events.
 *
 * Semantic search needs the appliance's embeddings and is reported back as
 * ignored, so the view can say so.
 *
 * Sort: `relevance` is bm25 with the title over the body and is only
 * meaningful with a query — a browse with no query sorts newest first.
 * `newest` / `oldest` order by `occurred_at`, undated rows last.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import {
  type DocumentRow,
  FTS_RANK_WEIGHTS,
  ftsMatchExpression,
  type LocalDocument,
  likePrefix,
  toLocalDocument,
} from './localSearch';
import { DOCUMENTS_GEO_INDEX, DOCUMENTS_FTS_TABLE, DOCUMENTS_TABLE, PEOPLE_FTS_TABLE } from './searchIndex';

/**
 * Every type the device holds a record for (search-next DEVICE_INDEXED_ENTITIES).
 * The header box renders a subset (`LOCAL_RESULT_TYPENAMES`); the list renders
 * all of them, each with its own row.
 */
export const LOCAL_LIST_TYPES = [
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'file-chunk',
  'item',
  'note',
  'person',
  'place',
  'product',
  'receipt',
  'task',
  'thread',
] as const;

export type LocalListEntityType = (typeof LOCAL_LIST_TYPES)[number];

export type LocalListSort = 'relevance' | 'newest' | 'oldest';

export interface LocalListQuery {
  /** Free text; empty means browse. */
  query: string;
  /** Lower-case entity types. An include list wins over `excludeTypes`. */
  includeTypes?: string[];
  excludeTypes?: string[];
  /** Tag labels the record must ALL carry. */
  tags?: string[];
  /** ISO instants; inclusive bounds on `occurred_at`. */
  from?: string;
  to?: string;
  sort: LocalListSort;
  /** `source_system` values, any of. */
  connectors?: string[];
  /** `inbound` or `outbound`; messages only. */
  direction?: string;
  /** Event kinds, any of; events only. */
  eventTypes?: string[];
  /** `image` / `video` / `audio` / `document`, any of; files only. */
  fileKinds?: string[];
  /** Person names, any of, as substrings. */
  people?: string[];
  /** Place names, any of, as substrings. */
  places?: string[];
  /** Only records with coordinates. */
  hasLocation?: boolean;
  /** Map rectangles `[minLon, minLat, maxLon, maxLat]`, any of. */
  areas?: number[][];
  /**
   * Only photos and videos with a preview on the appliance (`preview_id`):
   * the offline gallery's set. A photo is usually two records, its content
   * row and its file row, sharing one preview; the file row is left out
   * when its content row is in scope, so the gallery shows each photo once.
   */
  hasPreview?: boolean;
}

/** The types a filter pins the scope to, as the appliance does (SearchResolver). */
const PEOPLE_LINKED_TYPES = ['communication', 'event'] as const;

/**
 * How the Who filter finds a person's records, decided per query by
 * {@link planPeople}. `ids` are the matching person records' ids (names are
 * resolved first, in their own query, so the predicate below is literal:
 * a subquery per row re-ran the name match 589k times, 12 s). `columns` are
 * the roles the direction allows. `via`:
 *
 * - `walk`: for someone who is in many records (a spouse: 158k of 589k).
 *   The list walks the time index and tests each row with `instr` over the
 *   id columns; the first page is in the first few hundred rows. The FTS
 *   plan here would join and sort every match: 6 s.
 * - `fts`: for someone in few records (an old correspondent: 153). The FTS
 *   index over the id columns yields the rowids at once; the walk would
 *   have tested most of the table to find them: 12 s.
 *
 * With a text query the text and the ids are one MATCH, which is cheap
 * either way, so `via` only matters for a browse.
 */
export interface PeoplePlan {
  ids: string[];
  columns: Array<'from_id' | 'to_ids' | 'people'>;
  via: 'walk' | 'fts';
  /** How many records the FTS index says name one of the ids in one of the columns. */
  matches: number;
}

/**
 * Above this many records naming the person, the walk wins. At the
 * threshold the walk tests about 589k × 30 / 2,000 ≈ 9k rows for a page
 * (~0.2 s), while the FTS plan sorts 2k matches (~0).
 */
export const PEOPLE_WALK_THRESHOLD = 2_000;

/** A uuid as the FTS phrase its tokens form: unicode61 splits it on the hyphens. */
export function ftsIdPhrase(id: string): string {
  return `"${id.split('-').join(' ')}"`;
}

/** The column-scoped MATCH for any of the ids in any of the columns. */
export function peopleMatchExpression(plan: Pick<PeoplePlan, 'ids' | 'columns'>): string {
  return `{${plan.columns.join(' ')}}: (${plan.ids.map(ftsIdPhrase).join(' OR ')})`;
}

/** The roles a direction allows: received FROM, sent TO, or any. */
export function peopleColumns(direction: string | undefined): PeoplePlan['columns'] {
  if (direction === 'inbound') {
    return ['from_id'];
  }

  if (direction === 'outbound') {
    return ['to_ids'];
  }

  return ['from_id', 'to_ids', 'people'];
}

/**
 * Resolve the Who filter's names to person ids and pick the plan. `null`
 * when the filter is not set; a plan with no ids when no person matches
 * (the list is then empty, as on the appliance).
 */
export async function planPeople(
  db: AbstractPowerSyncDatabase,
  options: LocalListQuery,
): Promise<PeoplePlan | null> {
  const names = clean(options.people);

  if (names.length === 0) {
    return null;
  }

  const rows = await db.getAll<{ entity_id: string }>(
    `SELECT entity_id FROM ${DOCUMENTS_TABLE}
      WHERE entity_type = 'person' AND (${names.map(() => "title LIKE ? ESCAPE '\\'").join(' OR ')})`,
    names.map(namePattern),
  );
  const ids = [...new Set(rows.map((row) => row.entity_id))];
  const columns = peopleColumns(options.direction);

  if (ids.length === 0) {
    return { ids, columns, via: 'fts', matches: 0 };
  }

  const counted = await db.getOptional<{ n: number }>(
    `SELECT count(*) AS n FROM ${PEOPLE_FTS_TABLE} WHERE ${PEOPLE_FTS_TABLE} MATCH ?`,
    [peopleMatchExpression({ ids, columns })],
  );
  const matches = counted?.n ?? 0;

  return { ids, columns, via: matches > PEOPLE_WALK_THRESHOLD ? 'walk' : 'fts', matches };
}

/**
 * Whether the Who filter is the only thing narrowing the list besides the
 * type scope it pins: then the FTS match count IS the total, since only
 * messages and events carry the id columns.
 */
function onlyPeopleNarrow(options: LocalListQuery): boolean {
  return (
    options.query.trim().length === 0 &&
    clean(options.tags).length === 0 &&
    !options.from &&
    !options.to &&
    clean(options.connectors).length === 0 &&
    clean(options.eventTypes).length === 0 &&
    clean(options.fileKinds).length === 0 &&
    clean(options.places).length === 0 &&
    !options.hasLocation &&
    !options.hasPreview &&
    !(options.areas ?? []).some((area) => area.length === 4) &&
    resolveListTypes(options.includeTypes, options.excludeTypes).length === LOCAL_LIST_TYPES.length
  );
}

const FILE_KIND_PREFIXES: Record<string, string> = { image: 'image/%', video: 'video/%', audio: 'audio/%' };

export interface LocalListPage {
  documents: LocalDocument[];
}

export const LOCAL_LIST_PAGE_SIZE = 30;

/**
 * An ISO instant as a bound on the stored `occurred_at`, which PowerSync
 * sends as Postgres text: `YYYY-MM-DD HH:MM:SS[.ffffff]Z` — a space, not a
 * `T`. A `T` compares above a space, so an ISO lower bound would skip every
 * row on its own first day. Both bounds are cut to the second and carry no
 * suffix: the lower one is inclusive (`>=`, a row's fraction or `Z` sorts
 * above the bare second) and the upper one is the NEXT second, exclusive
 * (`<`), so a row anywhere inside the last second is still in. Null for text
 * that is not an instant.
 */
export function occurredAtBound(iso: string, edge: 'lower' | 'upper'): string | null {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const seconds = Math.floor(date.getTime() / 1000) + (edge === 'upper' ? 1 : 0);

  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** The entity types a list is scoped to, after include/exclude, in lower case. */
export function resolveListTypes(includeTypes?: string[], excludeTypes?: string[]): LocalListEntityType[] {
  const all = [...LOCAL_LIST_TYPES];
  const normalize = (types: string[]) => new Set(types.map((type) => type.toLowerCase()));

  if (includeTypes && includeTypes.length > 0) {
    const include = normalize(includeTypes);

    return all.filter((type) => include.has(type));
  }

  const exclude = normalize(excludeTypes ?? []);

  return all.filter((type) => !exclude.has(type));
}

interface Clause {
  sql: string;
  params: unknown[];
}

/**
 * The FROM and WHERE shared by the page and the count, or null when nothing
 * can match (an empty type scope). The text query decides the FROM: with one,
 * the FTS index drives the scan; without, the documents table alone.
 */
/** The order a query actually gets: relevance needs a query to rank by; a browse is newest first. */
function effectiveSort(options: LocalListQuery): LocalListSort {
  return options.sort === 'relevance' && options.query.trim().length === 0 ? 'newest' : options.sort;
}

/**
 * The types that are nearly all the rows (messages, events, content: 95% of
 * Kyle's corpus). A scope that keeps any of them is broad: walking the time
 * index backwards finds a page in the first few rows. A scope without them is
 * narrow, and its own `(entity_type, occurred_at)` range is the fast path.
 */
const BULK_TYPES: ReadonlySet<string> = new Set(['communication', 'event', 'content']);

/**
 * The type predicate, written to steer SQLite's planner, which has no
 * statistics on the device and chooses badly on its own (measured 2026-10-22
 * on the S23U). Offered the `(entity_type, occurred_at)` index it takes it:
 * for a text query it then scans every row of the chosen types and probes
 * the FTS index per row — 15 s for "lunch" against ~0 the other way round —
 * and for a broad time-ordered scope it sorts every matching row in a temp
 * b-tree — 2.4 s for a year of messages against ~0 walking the time index.
 *
 * The unary plus is SQLite's documented way to keep a term off any index. It
 * is applied whenever a text query must drive (always: the FTS scan is the
 * selective one), and when rows are ordered by time over a broad scope. The
 * term stays bare for the two cases that index serves well: a narrow scope
 * in time order, whose own range beats a walk past every other row, and a
 * count with no query, which it answers from the index alone.
 */
function typeTerm(
  types: readonly string[],
  ordered: boolean,
  sort: LocalListSort,
  hasQuery: boolean,
  hasIndexedFilter: boolean,
): string {
  // A text query, or a filter with an index of its own (a connector, an event
  // kind, a place, coordinates), is the selective side and must drive: the
  // place filter's two partial indexes served it in ~0 with the type term off
  // the type index, and in 20 s with the type index walking every event.
  if (hasQuery || hasIndexedFilter) {
    return '+d.entity_type';
  }

  const timeOrdered = ordered && sort !== 'relevance';
  // One type is one range of (entity_type, occurred_at), already in time
  // order — walking the whole time index past every other type instead took
  // 6.6 s for "sent messages". Several bulk types would need their ranges
  // merged, which is the temp b-tree the hint avoids.
  const broad = types.length > 1 && types.some((type) => BULK_TYPES.has(type));

  return timeOrdered && broad ? '+d.entity_type' : 'd.entity_type';
}

const clean = (values: string[] | undefined): string[] => [
  ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
];

/** The type scope after the filters that pin it, as the appliance pins them. */
export function pinnedListTypes(options: LocalListQuery): LocalListEntityType[] {
  let types = resolveListTypes(options.includeTypes, options.excludeTypes);
  const keep = (allowed: readonly string[]) => {
    types = types.filter((type) => allowed.includes(type));
  };

  if (options.direction) {
    keep(['communication']);
  }

  if (clean(options.eventTypes).length > 0) {
    keep(['event']);
  }

  if (clean(options.fileKinds).length > 0) {
    keep(['file']);
  }

  if (clean(options.people).length > 0) {
    keep(PEOPLE_LINKED_TYPES);
  }

  if (
    clean(options.places).length > 0 ||
    options.hasLocation ||
    (options.areas ?? []).some((area) => area.length === 4)
  ) {
    keep(['event']);
  }

  if (options.hasPreview) {
    keep(['content', 'file']);
  }

  return types;
}

/** A name as the appliance's case-insensitive substring pattern, its own wildcards escaped. */
function namePattern(name: string): string {
  return `%${likePrefix(name)}%`;
}

/**
 * A `detail` field as the generated column searchIndex.ts declares for it,
 * so the filter can use that column's index. A filter over the JSON itself
 * is a `json_extract` per scanned row: 20 s for a place name over 224k
 * events on the S23U, against ~0 through the partial index. Partial indexes
 * only apply when the query says `IS NOT NULL` itself, hence the `present`
 * guard on the sparse fields.
 *
 * With a text query the FTS scan must drive and every other field is a
 * filter on its hits: offered the connector index for "spotify, youtube"
 * (290k rows) the planner took it and probed FTS per row, 22 s. The unary
 * plus keeps the field off its index then, as `typeTerm` does for the type.
 */
function fieldRefs(hasQuery: boolean) {
  const field = (name: string) => `${hasQuery ? '+' : ''}d.${name}`;
  const present = (name: string) => `${field(name)} IS NOT NULL`;

  return { field, present };
}

function listClauses(options: LocalListQuery, ordered: boolean, people: PeoplePlan | null): Clause | null {
  const types = pinnedListTypes(options);
  const textMatch = ftsMatchExpression(options.query);
  const hasQuery = options.query.trim().length > 0;

  if (types.length === 0 || (hasQuery && textMatch == null) || (people != null && people.ids.length === 0)) {
    return null;
  }

  // The text and, on the FTS plan, the people are each an index lookup, in
  // their own FTS tables (searchIndex.ts: the text is stemmed, the ids are
  // not). Whichever exists drives the scan; both together is the text scan
  // with the people as a rowid probe into the id index. On the walk plan the
  // people are a row test below.
  const peopleMatch = people?.via === 'fts' ? peopleMatchExpression(people) : null;
  const match = textMatch ?? peopleMatch;
  const { field, present } = fieldRefs(match != null);

  const where: string[] = [];
  const params: unknown[] = [];
  const labels = [...new Set((options.tags ?? []).map((label) => label.trim()).filter(Boolean))];

  // Every label, not any: the same HAVING count the appliance applies. Which
  // side drives decides everything (S23U, 589k rows): a subquery per document
  // over the whole table took 29 s, and a plain JOIN let the planner scan the
  // documents and probe the tagged set, 10 s. Without a text query the small
  // tagged set must drive the join into the documents (through the entity_id
  // index) — CROSS JOIN is SQLite's way to fix that loop order. With a text
  // query the FTS scan drives and the same subquery is a per-hit index probe,
  // which is the cheap direction (~0 for a rare word, 2.9 s for "the").
  const labelList = labels.map(() => '?').join(', ');
  const taggedOn = 'tagged.entity_type = d.entity_type AND tagged.entity_id = d.entity_id';

  let from: string;

  if (match != null) {
    const driver = textMatch != null ? DOCUMENTS_FTS_TABLE : PEOPLE_FTS_TABLE;

    from = `FROM ${driver}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${driver}.rowid`;
    where.push(`${driver} MATCH ?`);
    params.push(match);

    if (textMatch != null && peopleMatch != null) {
      where.push(`d.rowid IN (SELECT rowid FROM ${PEOPLE_FTS_TABLE} WHERE ${PEOPLE_FTS_TABLE} MATCH ?)`);
      params.push(peopleMatch);
    }

    if (labels.length > 0) {
      where.push(
        `(SELECT count(DISTINCT t.label)
            FROM entity_tag et
            JOIN tags t ON t.id = et.tag_id
           WHERE et.entity_type = d.entity_type
             AND et.entity_id = d.entity_id
             AND t.deleted_at IS NULL
             AND t.label IN (${labelList})) = ?`,
      );
      params.push(...labels, labels.length);
    }
  } else if (labels.length > 0) {
    from = `FROM (SELECT et.entity_type, et.entity_id
                    FROM entity_tag et
                    JOIN tags t ON t.id = et.tag_id
                   WHERE t.deleted_at IS NULL
                     AND t.label IN (${labelList})
                   GROUP BY et.entity_type, et.entity_id
                  HAVING count(DISTINCT t.label) = ?) tagged
            CROSS JOIN ${DOCUMENTS_TABLE} d ON ${taggedOn}`;
    params.push(...labels, labels.length);
  } else {
    from = `FROM ${DOCUMENTS_TABLE} d`;
  }

  const hasIndexedFilter =
    Boolean(options.direction) ||
    clean(options.connectors).length > 0 ||
    clean(options.eventTypes).length > 0 ||
    clean(options.places).length > 0 ||
    Boolean(options.hasLocation) ||
    Boolean(options.hasPreview) ||
    (options.areas ?? []).some((area) => area.length === 4);

  where.push(
    `${typeTerm(types, ordered, effectiveSort(options), match != null, hasIndexedFilter)} IN (${types.map(() => '?').join(', ')})`,
  );
  params.push(...types);

  const lower = options.from ? occurredAtBound(options.from, 'lower') : null;
  const upper = options.to ? occurredAtBound(options.to, 'upper') : null;

  if (lower) {
    where.push('d.occurred_at >= ?');
    params.push(lower);
  }

  if (upper) {
    where.push('d.occurred_at < ?');
    params.push(upper);
  }

  const connectors = clean(options.connectors);

  if (connectors.length > 0) {
    where.push(`${field('source_system')} IN (${connectors.map(() => '?').join(', ')})`);
    params.push(...connectors);
  }

  if (options.direction) {
    where.push(`${field('direction')} = ?`);
    params.push(options.direction);
  }

  const eventTypes = clean(options.eventTypes);

  if (eventTypes.length > 0) {
    where.push(
      `${present('event_type')} AND ${field('event_type')} IN (${eventTypes.map(() => '?').join(', ')})`,
    );
    params.push(...eventTypes);
  }

  const fileKinds = clean(options.fileKinds);

  if (fileKinds.length > 0) {
    // The appliance's rule (files/fileKinds.ts): a media prefix, or
    // `document` for everything that is none of the three.
    const kinds = fileKinds.map((kind) =>
      kind === 'document'
        ? `(${field('content_type')} IS NULL OR (${Object.values(FILE_KIND_PREFIXES)
            .map(() => `${field('content_type')} NOT LIKE ?`)
            .join(' AND ')}))`
        : `${field('content_type')} LIKE ?`,
    );

    where.push(`(${kinds.join(' OR ')})`);

    for (const kind of fileKinds) {
      params.push(
        ...(kind === 'document'
          ? Object.values(FILE_KIND_PREFIXES)
          : [FILE_KIND_PREFIXES[kind] ?? `${kind}/%`]),
      );
    }
  }

  if (people?.via === 'walk') {
    // A row test with literal ids: the sender by equality, the id lists by a
    // plain substring search of their JSON text (a uuid cannot straddle two
    // array entries).
    const roles = people.columns.map((column) =>
      column === 'from_id'
        ? `${field('from_id')} IN (${people.ids.map(() => '?').join(', ')})`
        : `(${present(column)} AND (${people.ids.map(() => `instr(${field(column)}, ?) > 0`).join(' OR ')}))`,
    );

    where.push(`(${roles.join(' OR ')})`);

    for (let index = 0; index < people.columns.length; index += 1) {
      params.push(...people.ids);
    }
  }

  const places = clean(options.places);

  if (places.length > 0) {
    // Both branches qualified for their partial indexes, so SQLite's
    // multi-index OR serves each from its own.
    where.push(
      `((${present('location_id')} AND ${field('location_id')} IN (SELECT p.entity_id FROM ${DOCUMENTS_TABLE} p
                                      WHERE p.entity_type = 'place' AND (${places.map(() => "p.title LIKE ? ESCAPE '\\'").join(' OR ')})))
        OR (${present('location_name')} AND (${places.map(() => `${field('location_name')} LIKE ? ESCAPE '\\'`).join(' OR ')})))`,
    );
    params.push(...places.map(namePattern), ...places.map(namePattern));
  }

  const areas = (options.areas ?? []).filter((area) => area.length === 4);

  if (options.hasLocation || areas.length > 0) {
    where.push(present('lat'));
  }

  if (options.hasPreview) {
    where.push(present('preview_id'));

    if (types.includes('content') && types.includes('file')) {
      where.push(
        `NOT (d.entity_type = 'file' AND EXISTS (SELECT 1 FROM ${DOCUMENTS_TABLE} c
                                                  WHERE c.entity_type = 'content' AND c.preview_id = d.preview_id))`,
      );
    }
  }

  if (areas.length > 0) {
    where.push(
      `(${areas.map(() => `(${field('lng')} BETWEEN ? AND ? AND ${field('lat')} BETWEEN ? AND ?)`).join(' OR ')})`,
    );

    for (const [minLon, minLat, maxLon, maxLat] of areas) {
      params.push(minLon, maxLon, minLat, maxLat);
    }
  }

  return { sql: `${from}\n WHERE ${where.join('\n   AND ')}`, params };
}

function orderBy(options: LocalListQuery): string {
  switch (effectiveSort(options)) {
    case 'relevance':
      return `ORDER BY bm25(${DOCUMENTS_FTS_TABLE}, ${FTS_RANK_WEIGHTS}), d.id`;

    case 'oldest':
      return 'ORDER BY d.occurred_at ASC NULLS LAST, d.id';

    default:
      return 'ORDER BY d.occurred_at DESC NULLS LAST, d.id';
  }
}

/**
 * The SQL and parameters for one page. Exported for the test; `listLocal`
 * runs it, after {@link planPeople} when the Who filter is set.
 */
export function localListStatement(
  options: LocalListQuery,
  page: { limit: number; offset: number },
  people: PeoplePlan | null = null,
): { sql: string; params: unknown[] } | null {
  const clauses = listClauses(options, true, people);

  if (clauses == null) {
    return null;
  }

  return {
    sql: `SELECT d.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.related_id, d.detail
            ${clauses.sql}
            ${orderBy(options)}
            LIMIT ? OFFSET ?`,
    params: [...clauses.params, page.limit, page.offset],
  };
}

/** The matching-record count for the same filters. */
export function localListCountStatement(
  options: LocalListQuery,
  people: PeoplePlan | null = null,
): { sql: string; params: unknown[] } | null {
  const clauses = listClauses(options, false, people);

  if (clauses == null) {
    return null;
  }

  return { sql: `SELECT count(*) AS n ${clauses.sql}`, params: clauses.params };
}

/** The most pins the map reads from the phone — the appliance's `mapPins` default (`MAP_PIN_DEFAULT_LIMIT`). */
export const LOCAL_PINS_LIMIT = 10_000;

/** A located record as the map plots it offline: the marker's fields and nothing else. */
export interface LocalPin {
  id: string;
  entityType: string;
  entityId: string;
  title: string | null;
  occurredAt: string | null;
  lat: number;
  lng: number;
}

/**
 * The located records for the same filters, newest first — what the map plots
 * offline. Located means `hasLocation`, which pins the scope to events, as the
 * appliance's `mapPins` does. Exported for the test; `listLocalPins` runs it.
 */
export function localPinsStatement(
  options: LocalListQuery,
  limit: number,
  people: PeoplePlan | null = null,
): { sql: string; params: unknown[] } | null {
  const clauses = listClauses({ ...options, hasLocation: true }, false, people);

  if (clauses == null) {
    return null;
  }

  // The set is small (2.7k located rows of 589k on the S23U) and the geo
  // index holds exactly it, but offered the time index for the ORDER BY the
  // planner walks the whole table in time order, testing `lat` — a JSON
  // extraction — on every row: 37 s. Named outright, the index hands over
  // the located rows and the sort is of those alone: well under a second.
  // Only when the plain table drives; behind a text query the FTS scan must
  // (`INDEXED BY` would refuse that plan), and behind a tag filter the
  // tagged set does.
  const plainFrom = `FROM ${DOCUMENTS_TABLE} d\n`;
  const sql = clauses.sql.startsWith(plainFrom)
    ? `FROM ${DOCUMENTS_TABLE} d INDEXED BY ${DOCUMENTS_GEO_INDEX}\n${clauses.sql.slice(plainFrom.length)}`
    : clauses.sql;

  return {
    sql: `SELECT d.id, d.entity_type, d.entity_id, d.title, d.occurred_at, d.lat, d.lng
            ${sql}
            ORDER BY d.occurred_at DESC NULLS LAST, d.id
            LIMIT ?`,
    params: [...clauses.params, limit],
  };
}

export async function listLocalPins(
  db: AbstractPowerSyncDatabase,
  options: LocalListQuery,
  limit = LOCAL_PINS_LIMIT,
): Promise<{ pins: LocalPin[]; totalCount: number; truncated: boolean }> {
  const located: LocalListQuery = { ...options, hasLocation: true };
  const statement = localPinsStatement(located, limit, await planPeople(db, located));

  if (statement == null) {
    return { pins: [], totalCount: 0, truncated: false };
  }

  const rows = await db.getAll<{
    id: string;
    entity_type: string;
    entity_id: string;
    title: string | null;
    occurred_at: string | null;
    lat: number;
    lng: number;
  }>(statement.sql, statement.params);
  const pins = rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    occurredAt: row.occurred_at,
    lat: row.lat,
    lng: row.lng,
  }));
  // The count is a second walk; only pay for it when the page may have been cut.
  const totalCount = pins.length < limit ? pins.length : ((await countLocal(db, located)) ?? pins.length);

  return { pins, totalCount, truncated: pins.length < totalCount };
}

export async function listLocal(
  db: AbstractPowerSyncDatabase,
  options: LocalListQuery,
  page: { limit?: number; offset?: number } = {},
): Promise<LocalListPage> {
  const limit = page.limit ?? LOCAL_LIST_PAGE_SIZE;
  const offset = page.offset ?? 0;
  const statement = localListStatement(options, { limit, offset }, await planPeople(db, options));

  if (statement == null) {
    return { documents: [] };
  }

  const rows = await db.getAll<DocumentRow>(statement.sql, statement.params);

  return { documents: rows.map(toLocalDocument) };
}

/**
 * How many records match, for the footer's "30 of 1,204". Separate from the
 * page on purpose: a count over a date range is a walk of every matching row
 * (5 s for 52k dated rows on the S23U, through SQLCipher), and the first page
 * must not wait for it. `null` when nothing can match.
 */
export async function countLocal(
  db: AbstractPowerSyncDatabase,
  options: LocalListQuery,
): Promise<number | null> {
  const people = await planPeople(db, options);

  // A walk-plan count would test every row (10 s for a spouse's messages on
  // the S23U) and, through the plugin's one thread, hold up every query after
  // it. The FTS count is exact when the Who filter is the only narrowing;
  // otherwise the total goes unknown and the footer says "30 loaded".
  if (people?.via === 'walk') {
    return onlyPeopleNarrow(options) ? people.matches : null;
  }

  const statement = localListCountStatement(options, people);

  if (statement == null) {
    return 0;
  }

  const row = await db.getOptional<{ n: number }>(statement.sql, statement.params);

  return row?.n ?? null;
}
