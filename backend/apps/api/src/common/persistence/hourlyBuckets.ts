/**
 * What an hourly activity provider is asked for.
 *
 * Without `changedSince`: every (user, hour) bucket of the table, in full.
 * With it: only the buckets that hold at least one row changed at or after
 * that instant — each counted IN FULL, and reported with a `count` of 0 when
 * every row in it has stopped counting (deleted, cancelled, deactivated), so
 * the rollup can prune the bucket. A bucket nothing changed in is left out.
 */
export interface HourlyActivityOptions {
  changedSince?: Date;
}

/**
 * The touched-bucket predicate of an incremental hourly rollup.
 *
 * Keeps the rows of every (user, hour) bucket that holds at least one row
 * whose `changed` expression is at or after `:changedSince` — the caller binds
 * it — so the bucket is recounted in full, with whatever was added, edited or
 * soft-deleted in it since. The outer expressions are the query builder's
 * (property paths it maps); the source ones are raw columns of `source.table`
 * under the alias `src`, which `changed` may use (`src.updated_at`, or
 * `GREATEST(src.updated_at, src.deleted_at)` for a table that soft-deletes
 * without touching `updated_at`).
 *
 * Why buckets and not rows: a bucket's count is every row in it, so a row that
 * arrived or changed cannot be added to the stored count — the bucket is
 * counted again. And why the change column rather than the bucket column: an
 * import lands rows whose event time is years old, and a filter on the bucket
 * column would not see them until the next full pass.
 */
export function touchedHourlyBucketsSql(
  outer: { user: string; bucket: string },
  source: { table: string; userColumn: string; bucketColumn: string; changed: string },
): string {
  return (
    `(${outer.user}, date_trunc('hour', ${outer.bucket}, 'UTC')) IN (` +
    `SELECT src.${source.userColumn}, date_trunc('hour', src.${source.bucketColumn}, 'UTC') ` +
    `FROM ${source.table} src WHERE ${source.changed} >= :changedSince)`
  );
}
