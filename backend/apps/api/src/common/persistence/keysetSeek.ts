/**
 * The seek half of the search browse's composite keyset `(time, id)`, in either
 * direction.
 *
 * ── What it replaces ───────────────────────────────────────────────────────
 * Every `getEntitiesFor*` method behind the timed browse used to carry its own
 * copy of
 *
 *     (t < :afterTime OR (t = :afterTime AND id < :afterId))   ORDER BY t DESC, id DESC
 *
 * with the direction written into the operator and the tiebreak. The primary
 * column could be flipped through an `order` option, but the seek and the id
 * tiebreak could not, so nothing could page UPWARDS: "Oldest first" asked for
 * `ORDER BY t ASC, id DESC` past a `<` cursor, and the resolver sorted whatever
 * came back. This is the one place the direction now lives.
 *
 * ── Why the seek is a millisecond BUCKET, not a point ──────────────────────
 * The columns the browse pages on are `timestamptz(6)`: microseconds. The cursor
 * that comes back is built from a JavaScript `Date`, and the driver TRUNCATES
 * to milliseconds on the way in (`10:00:00.123456` is read as `.123`). So the
 * cursor does not name the row's instant; it names the millisecond that
 * contains it, and the order the merged page is built in is `(that
 * millisecond, id)`. A seek written against a point is wrong in both
 * directions:
 *
 *   - `t = :afterTime` matches nothing at all for a microsecond value, so the
 *     descending seek lost every row of the cursor's millisecond that sorted
 *     after it. A bulk import stamps a whole batch with one `now()`, so "the
 *     cursor's millisecond" is routinely the rest of a page-sized batch;
 *   - `t > :afterTime` matches the cursor row's own millisecond, so the
 *     ascending mirror re-served the row it started from, and a batch larger
 *     than a page re-served the same page for ever.
 *
 * So the cursor's millisecond is `[:afterTime, :afterTimeEnd)`, a half-open
 * range, and the seek is: strictly later buckets, or this bucket and past the
 * id. Both bounds are plain comparisons on the bare column, so the btree
 * behind `(user_id, <time> DESC)` keeps serving the order and the range.
 *
 *   DESC   t < :afterTime            OR  (t in bucket AND id < :afterId)
 *   ASC    t >= :afterTimeEnd        OR  (t in bucket AND id > :afterId)
 *
 * Each also carries its far bound as a top-level conjunct (`t < :afterTimeEnd`
 * for DESC, `t >= :afterTime` for ASC). It excludes nothing the disjunction
 * lets through; it exists so the planner sees one index range rather than an
 * OR it has to plan arm by arm.
 *
 * ── What it assumes ────────────────────────────────────────────────────────
 * The page is ordered `(t, id)` in SQL and `(millisecond, id)` in the merge. Those
 * are the same order whenever the rows that share a millisecond share their
 * microseconds too, which is true of everything the browse holds: a source-dated
 * row has no sub-millisecond part, and a `now()`-stamped batch has an identical
 * one. They could differ only for rows of ONE type, in ONE millisecond, with
 * different microseconds that sort against their ids, and only matter if more
 * than `first * 4` of them straddle a page: the per-type over-fetch absorbs
 * anything smaller.
 *
 * ── When the cursor's time can be read EXACTLY: `keysetSeekExact` ───────────
 * All of the above is forced by a cursor a client holds: a `(Date, id)` pair
 * that cannot spell a microsecond. `keysetPaginate` has no such cursor. Its
 * cursor is a row id, the server looks that row up itself, and nothing has to
 * pass through a `Date`: the lookup reads the ordering column as TEXT
 * (`CAST(col AS text)`), which Postgres prints to the microsecond, and the seek
 * binds that string back, so Postgres parses it as the column's own type. The
 * cursor is then the row's exact `(col, id)`.
 *
 * That is not only tidier, it is the only form that is right there.
 * `keysetPaginate` orders in SQL by `(col, id)` at full precision, and nothing
 * sorts its page again, so its seek has to agree with THAT order. A millisecond
 * bucket does not: it puts every row of one millisecond in id order, so rows
 * that share a millisecond at different microseconds, with ids running against
 * their times, are skipped and repeated at a page boundary (the "one
 * millisecond" cases of `keysetPaginate.subMillisecond.integration.spec.ts` fail
 * under the bucket and pass here). The bucket gets away with it above only
 * because the browse merges the types and re-sorts the merge by
 * `(millisecond, id)`, over-fetching `first * 4` rows of each to absorb the
 * difference. Nothing absorbs it in `keysetPaginate`.
 *
 *   DESC   t <= :afterTime  AND (t < :afterTime  OR (t = :afterTime AND id < :afterId))
 *   ASC    t >= :afterTime  AND (t > :afterTime  OR (t = :afterTime AND id > :afterId))
 *
 * The first conjunct is redundant here too, and for the same reason: it is what
 * turns the `OR` into one index range. Without it Postgres walks the user's
 * index from the newest row and discards every row newer than the cursor, on
 * every page.
 *
 * ── When the index carries the id too: a row-value comparison ───────────────
 * That range is on the TIME column alone. Postgres still reads every row of the
 * cursor's instant that was already served, and discards it, on every page: a
 * cursor halfway through a batch import stamped to one instant reads half the
 * batch each time. Where the index is `(owner, time DESC, id DESC)`, as
 * `objects_live_keyset_idx` is, `(t, id) < (:afterTime, :afterId)` is ONE index
 * condition on both columns and reads none of them (50,001 rows against none,
 * for a cursor 50,000 deep in a 100,000-item same-instant batch, on a clone of
 * `ci.objects` holding 1,300,000 rows). It takes the same exact text, so it is
 * the same cure with a different predicate: `ItemService.findPage` uses it, and
 * `FileService.findPage` always has. Where the index holds the time alone the
 * two have the same range to work with.
 */

export type KeysetOrder = 'ASC' | 'DESC';

/**
 * The direction an `order` option asks for: `'ASC'` / `'asc'`, or an order object
 * like `{ startTime: 'ASC' }` (the first key decides, as it does for the SQL's
 * primary sort). Anything else, including no order at all, is `'DESC'`: newest
 * first, which is what every caller that passes nothing has always got.
 */
export function keysetOrderOf(order: unknown): KeysetOrder {
  const first = typeof order === 'object' && order !== null ? Object.values(order)[0] : order;

  return typeof first === 'string' && first.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

/** What {@link keysetSeek} binds. `afterTimeEnd` is the first instant of the millisecond after the cursor's. */
export interface KeysetSeekParams {
  afterTime: Date;
  afterTimeEnd: Date;
  afterId: string;
}

/**
 * The `andWhere` arguments that page strictly past `(afterTime, afterId)` in `order`.
 *
 * Spread it: `query.andWhere(...keysetSeek('file.updated_at', 'file.id', order, afterTime, afterId))`.
 * `timeExpr` and `idExpr` are the column expressions the query orders by, exactly as the ORDER BY
 * writes them (a receipt's is `COALESCE(purchased_at, updated_at)`).
 */
export function keysetSeek(
  timeExpr: string,
  idExpr: string,
  order: KeysetOrder,
  afterTime: Date,
  afterId: string,
): [sql: string, params: KeysetSeekParams] {
  const inBucket = `${timeExpr} >= :afterTime AND ${timeExpr} < :afterTimeEnd`;
  const params: KeysetSeekParams = {
    afterTime,
    afterTimeEnd: new Date(afterTime.getTime() + 1),
    afterId,
  };

  if (order === 'ASC') {
    return [
      `(${timeExpr} >= :afterTime AND (${timeExpr} >= :afterTimeEnd OR (${inBucket} AND ${idExpr} > :afterId)))`,
      params,
    ];
  }

  return [
    `(${timeExpr} < :afterTimeEnd AND (${timeExpr} < :afterTime OR (${inBucket} AND ${idExpr} < :afterId)))`,
    params,
  ];
}

/** What {@link keysetSeekExact} binds. `afterTime` is the database's own spelling of the cursor's instant. */
export interface KeysetSeekExactParams {
  afterTime: string;
  afterId: string;
}

/**
 * The `andWhere` arguments that page strictly past `(afterTime, afterId)` in `order`, for a cursor
 * whose time was read from the database as text, microseconds and all.
 *
 * Spread it: `query.andWhere(...keysetSeekExact('c.created_at', 'c.id', order, afterTime, afterId))`.
 * `afterTime` is what Postgres printed for the cursor row's ordering column (`CAST(col AS text)`).
 * The placeholders carry no cast of their own, so Postgres reads the string as the column's type and
 * the comparison is exact. `timeExpr` and `idExpr` are the column expressions the query orders by,
 * exactly as the ORDER BY writes them.
 */
export function keysetSeekExact(
  timeExpr: string,
  idExpr: string,
  order: KeysetOrder,
  afterTime: string,
  afterId: string,
): [sql: string, params: KeysetSeekExactParams] {
  const params: KeysetSeekExactParams = { afterTime, afterId };

  if (order === 'ASC') {
    return [
      `(${timeExpr} >= :afterTime AND (${timeExpr} > :afterTime OR (${timeExpr} = :afterTime AND ${idExpr} > :afterId)))`,
      params,
    ];
  }

  return [
    `(${timeExpr} <= :afterTime AND (${timeExpr} < :afterTime OR (${timeExpr} = :afterTime AND ${idExpr} < :afterId)))`,
    params,
  ];
}
