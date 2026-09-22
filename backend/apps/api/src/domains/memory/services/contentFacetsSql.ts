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
 * The How facet: every platform that delivered one of the user's content
 * rows, by the rule {@link effectiveSourceSystemSql} filters with — the
 * ledger's platform where it recorded one, else the row's own
 * `source_system`. Two indexed arms plus the caller-supplied unledgered
 * arm (`$2`, from {@link UNLEDGERED_SOURCE_SYSTEMS_SQL}):
 *
 *  - `ledger`: a loose scan over the platforms the ledger holds for the
 *    user's content rows.
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
    (SELECT platform AS v FROM ci.record_sources
      WHERE user_id = $1 AND record_table = 'content' AND platform IS NOT NULL
      ORDER BY platform LIMIT 1)
    UNION ALL
    SELECT (SELECT r.platform FROM ci.record_sources r
             WHERE r.user_id = $1 AND r.record_table = 'content' AND r.platform > ledger.v
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
