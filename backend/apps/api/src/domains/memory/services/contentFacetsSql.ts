/**
 * The SQL behind {@link ContentService.getFacets}: what the content library's
 * three pickers can offer, read along indexes rather than by scanning the
 * library.
 *
 * Every statement here is a loose index scan — a recursive CTE that asks the
 * index for the smallest value, then repeatedly for the smallest value above
 * the last one — so the cost is one probe per DISTINCT value, not one row per
 * row. The previous shape (`SELECT DISTINCT … LEFT JOIN ci.events`) hashed
 * every content row against every event three times per page load, in
 * parallel workers whose hash tables live in the container's /dev/shm;
 * measured 2026-09-22 on a 132k-row library that was ~240 ms, ~44 MB of
 * shared memory and, once anything else was running, "could not resize
 * shared memory segment" on every load. The same answers now take well under
 * a millisecond each and touch no shared memory. The indexes are in
 * 20260922180450_add_content_facet_indexes.
 *
 * The soft-deleted-event rule (a media row that exists only as the plumbing
 * of a deleted event must not be offered) is kept, but inverted: instead of
 * joining every event to prove each row is live, start from the deleted
 * events — a handful, reached through a partial index — collect the values
 * their media carries, and prove liveness only for those "suspect" values.
 * Every other value is offered on sight, because a value no deleted event
 * touches cannot be hidden by one.
 *
 * `$1` is always the owning user's id.
 */

/**
 * Predicate matching content rows whose EFFECTIVE source system passes
 * `membership` — the same value {@link PLATFORMS_SQL} offers, so every place
 * the How filter narrows content agrees with the picker that fed it.
 *
 * A row's effective systems are the platforms the `ci.record_sources` ledger
 * recorded for it, and only when the ledger recorded none, its own
 * `source_system`. The two arms are exclusive on purpose: a Google Photos
 * photo is `file` in the column and `google_photos` in the ledger, and picking
 * "file" must not sweep it in — "file" is the honest bucket only for a row no
 * platform claims. Both EXISTS probes hit `record_sources_record_idx`
 * `(user_id, record_table, record_id)`.
 *
 * `membership` turns a column expression into the caller's own "is one of the
 * selected sources" test, so the query builder (named parameters) and raw SQL
 * (positional ones) share the one rule.
 */
export function effectiveSourceSystemPredicate(
  alias: string,
  membership: (expression: string) => string,
): string {
  const ledger = `SELECT 1 FROM ci.record_sources rs WHERE rs.user_id = ${alias}.user_id AND rs.record_table = 'content' AND rs.record_id = ${alias}.id`;

  return (
    `(EXISTS (${ledger} AND ${membership('rs.platform')})` +
    ` OR (${membership(`${alias}.source_system`)} AND NOT EXISTS (${ledger} AND rs.platform IS NOT NULL)))`
  );
}

/** The two columns a picker can walk; anything else is a caller bug, not a query. */
export type ContentFacetColumn = 'type' | 'mimetype';

const FACET_COLUMNS: ReadonlySet<ContentFacetColumn> = new Set(['type', 'mimetype']);

/** A user's distinct, non-null values of `column`, sorted, minus those found only on deleted-event media. */
export function distinctColumnSql(column: ContentFacetColumn): string {
  if (!FACET_COLUMNS.has(column)) {
    throw new Error(`Not a content facet column: ${String(column)}`);
  }

  return `
    WITH RECURSIVE vals AS (
      (SELECT ${column} AS v FROM ci.content
        WHERE user_id = $1 AND ${column} IS NOT NULL
        ORDER BY ${column} LIMIT 1)
      UNION ALL
      SELECT (SELECT c.${column} FROM ci.content c
               WHERE c.user_id = $1 AND c.${column} > vals.v
               ORDER BY c.${column} LIMIT 1)
        FROM vals WHERE vals.v IS NOT NULL
    ), suspect AS (
      SELECT DISTINCT c.${column} AS v
        FROM ci.events e
        JOIN ci.content c ON c.event_id = e.event_id
       WHERE e.user_id = $1 AND e.is_deleted
         AND c.user_id = $1 AND c.${column} IS NOT NULL
    )
    SELECT v FROM vals
     WHERE v IS NOT NULL
       AND (v NOT IN (SELECT v FROM suspect)
            OR EXISTS (SELECT 1 FROM ci.content c
                         LEFT JOIN ci.events e ON e.event_id = c.event_id
                        WHERE c.user_id = $1 AND c.${column} = vals.v
                          AND (c.event_id IS NULL OR e.is_deleted = false)))
     ORDER BY v`;
}

/**
 * The `source_system` of every content row the ledger never saw — no
 * `ci.record_sources` row at all, whatever its platform.
 *
 * This is the one arm of the How facet that has no index to walk: "no row in
 * another table" is an anti-join over the whole library, and nothing short of
 * a denormalised flag would make it cheaper. It exists for rows that predate
 * the ledger (docs/design/cross-pipeline-identity.md §5; the import doctor
 * calls them out the same way) — every write path since appends the ledger in
 * the same transaction as the row, so on a converged library this returns
 * nothing, and on a legacy one its answer changes only when an import
 * re-delivers those rows. {@link ContentService.getFacets} therefore runs it
 * once per user and keeps the answer for a few minutes.
 *
 * Run with parallelism off (the caller sets `max_parallel_workers_per_gather
 * = 0` for the statement): a serial hash anti-join over 132k ids is ~70 ms in
 * process-local memory, where the parallel plan is faster only by putting an
 * 11 MB hash table in /dev/shm, which is the failure this file exists to end.
 */
export const UNLEDGERED_SOURCE_SYSTEMS_SQL = `
  SELECT DISTINCT c.source_system AS v
    FROM ci.content c
   WHERE c.user_id = $1 AND c.source_system IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ci.record_sources rs
                      WHERE rs.user_id = c.user_id AND rs.record_table = 'content' AND rs.record_id = c.id)
   ORDER BY v`;

/**
 * The ledger row still names a content row. `ci.record_sources` has no FK:
 * deleting a content item (`ContentService.remove`) and the ingest reset's
 * TRUNCATE both leave its ledger rows behind, and a platform held only by
 * those would be offered and then match nothing. One primary-key probe per
 * row the loose scan visits — on a converged library, one per distinct
 * platform; orphans are stepped past in index order until a live row turns up.
 */
const LIVE_LEDGER_RECORD_SQL = (alias: string) =>
  `EXISTS (SELECT 1 FROM ci.content lc WHERE lc.id = ${alias}.record_id AND lc.user_id = ${alias}.user_id)`;

/**
 * The How facet: every platform that delivered one of the user's content
 * rows, by the rule {@link effectiveSourceSystemSql} filters with — the
 * ledger's platform where it recorded one, else the row's own
 * `source_system`. Two indexed arms plus the caller-supplied unledgered
 * arm (`$2`, from {@link UNLEDGERED_SOURCE_SYSTEMS_SQL}):
 *
 *  - `ledger`: a loose scan over the platforms the ledger holds for the
 *    user's content rows — rows that still exist, see
 *    {@link LIVE_LEDGER_RECORD_SQL}.
 *  - `unplatformed`: records whose ledger rows all carry a NULL platform —
 *    a federated kind whose producer could not name one — reached through
 *    the partial index on exactly those rows; their column stands in.
 *
 * The deleted-event rule is applied the same inverted way as for columns:
 * only a value some deleted event's media carries has to prove it also has
 * a live row, and that proof uses the filter's own predicate so the picker
 * never offers a value the filter would then match nothing with.
 */
export const PLATFORMS_SQL = `
  WITH RECURSIVE ledger AS (
    (SELECT r.platform AS v FROM ci.record_sources r
      WHERE r.user_id = $1 AND r.record_table = 'content' AND r.platform IS NOT NULL
        AND ${LIVE_LEDGER_RECORD_SQL('r')}
      ORDER BY r.platform LIMIT 1)
    UNION ALL
    SELECT (SELECT r.platform FROM ci.record_sources r
             WHERE r.user_id = $1 AND r.record_table = 'content' AND r.platform > ledger.v
               AND ${LIVE_LEDGER_RECORD_SQL('r')}
             ORDER BY r.platform LIMIT 1)
      FROM ledger WHERE ledger.v IS NOT NULL
  ), unplatformed AS (
    SELECT DISTINCT c.source_system AS v
      FROM ci.record_sources n
      JOIN ci.content c ON c.id = n.record_id AND c.user_id = n.user_id
     WHERE n.user_id = $1 AND n.record_table = 'content' AND n.platform IS NULL
       AND c.source_system IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ci.record_sources p
                        WHERE p.user_id = n.user_id AND p.record_table = 'content'
                          AND p.record_id = n.record_id AND p.platform IS NOT NULL)
  ), cand AS (
    SELECT v FROM ledger WHERE v IS NOT NULL
    UNION SELECT v FROM unplatformed
    UNION SELECT unnest($2::text[])
  ), suspect AS (
    SELECT rs.platform AS v
      FROM ci.events e
      JOIN ci.content c ON c.event_id = e.event_id
      JOIN ci.record_sources rs ON rs.user_id = c.user_id AND rs.record_table = 'content' AND rs.record_id = c.id
     WHERE e.user_id = $1 AND e.is_deleted AND c.user_id = $1 AND rs.platform IS NOT NULL
    UNION
    SELECT c.source_system
      FROM ci.events e
      JOIN ci.content c ON c.event_id = e.event_id
     WHERE e.user_id = $1 AND e.is_deleted AND c.user_id = $1 AND c.source_system IS NOT NULL
  )
  SELECT v FROM cand
   WHERE v NOT IN (SELECT v FROM suspect)
      OR EXISTS (SELECT 1 FROM ci.content c
                   LEFT JOIN ci.events e ON e.event_id = c.event_id
                  WHERE c.user_id = $1
                    AND (c.event_id IS NULL OR e.is_deleted = false)
                    AND (EXISTS (SELECT 1 FROM ci.record_sources rs
                                  WHERE rs.user_id = c.user_id AND rs.record_table = 'content'
                                    AND rs.record_id = c.id AND rs.platform = cand.v)
                         OR (c.source_system = cand.v
                             AND NOT EXISTS (SELECT 1 FROM ci.record_sources rs
                                              WHERE rs.user_id = c.user_id AND rs.record_table = 'content'
                                                AND rs.record_id = c.id AND rs.platform IS NOT NULL))))
   ORDER BY v`;

/**
 * The kinds the Content type picker offers in place of the raw `media` type.
 *
 * Every imported file is `type = 'media'` — 130k rows on the measured library:
 * photos, videos, Spotify plays, Netflix and Prime watches, PDFs — and the
 * only rows typed `video` or `image` are a handful of Reddit posts. Offering
 * the raw column made "Content type: video" select one Reddit GIF and none of
 * the 519 video files (2026-09-22). So a `media` row is offered by what its
 * mimetype says it is, and the raw type of the few rows that already say it
 * folds into the same word: picking `video` selects both.
 */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** `media` rows that are none of the kinds: watch and listen records, documents. */
export const OTHER_MEDIA_TYPE = 'media';

function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

const OTHER_MEDIA_MIMETYPE_SQL = (alias: string) =>
  `(${alias}.mimetype IS NULL OR (${MEDIA_KINDS.map((kind) => `${alias}.mimetype NOT LIKE '${kind}/%'`).join(' AND ')}))`;

/**
 * Which of {@link MEDIA_KINDS}, and whether {@link OTHER_MEDIA_TYPE}, the
 * user's live `media` rows carry. One EXISTS per kind over the
 * `(user_id, mimetype)` index — a range scan that stops at the first live row,
 * with the same deleted-event guard the column facets apply, so a kind that
 * survives only on a deleted event's media is not offered.
 */
export const MEDIA_KINDS_SQL = `
  SELECT kind AS v
    FROM (VALUES ${MEDIA_KINDS.map((kind) => `('${kind}', '${kind}/%')`).join(', ')}) AS kinds(kind, pattern)
   WHERE EXISTS (SELECT 1 FROM ci.content c
                   LEFT JOIN ci.events e ON e.event_id = c.event_id
                  WHERE c.user_id = $1 AND c.type = 'media' AND c.mimetype LIKE kinds.pattern
                    AND (c.event_id IS NULL OR e.is_deleted = false))
  UNION ALL
  SELECT '${OTHER_MEDIA_TYPE}'
   WHERE EXISTS (SELECT 1 FROM ci.content c
                   LEFT JOIN ci.events e ON e.event_id = c.event_id
                  WHERE c.user_id = $1 AND c.type = 'media' AND ${OTHER_MEDIA_MIMETYPE_SQL('c')}
                    AND (c.event_id IS NULL OR e.is_deleted = false))`;

/**
 * The Content type facet as offered: the raw types the column facet found,
 * with `media` replaced by the kinds the media rows carry. Sorted, unique, so a
 * raw `video` row and a `media` row with a video mimetype are one option.
 */
export function contentTypeOptions(rawTypes: readonly string[], mediaKinds: readonly string[]): string[] {
  const options = new Set<string>(rawTypes.filter((type) => type !== 'media'));

  for (const kind of mediaKinds) {
    options.add(kind);
  }

  return [...options].sort();
}

/**
 * The WHERE clause for a Content type selection, the inverse of
 * {@link contentTypeOptions}: a kind matches its raw type OR a `media` row of
 * that mimetype; `media` matches the rows no kind claims; anything else is
 * the raw type. `alias` is the content table's alias; the parameters are
 * returned keyed for TypeORM's named binding.
 */
export function contentTypeFilterSql(
  alias: string,
  types: readonly string[],
): { sql: string; parameters: Record<string, unknown> } {
  const raw: string[] = [];
  const clauses: string[] = [];

  for (const type of types) {
    if (isMediaKind(type)) {
      clauses.push(`(${alias}.type = 'media' AND ${alias}.mimetype LIKE '${type}/%')`);
      raw.push(type);
    } else if (type === OTHER_MEDIA_TYPE) {
      clauses.push(`(${alias}.type = 'media' AND ${OTHER_MEDIA_MIMETYPE_SQL(alias)})`);
    } else {
      raw.push(type);
    }
  }

  if (raw.length > 0) {
    clauses.push(`${alias}.type IN (:...contentTypes)`);
  }

  return { sql: `(${clauses.join(' OR ')})`, parameters: raw.length > 0 ? { contentTypes: raw } : {} };
}
