import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { keysetSeekExact } from './keysetSeek';

/**
 * Keyset (seek) pagination pushed into SQL — replaces the load-the-whole-table
 * then slice-in-JS `Paginator.paginate` for large tables. The query fetches only
 * one page (+1 sentinel row) with a real `LIMIT`, ordered by `(timeProp, id)`
 * DESC, so cost is bounded regardless of table size.
 *
 * The cursor stays the row id (callers pass the DECODED id of the after/before
 * row), so cursors are byte-identical to the in-memory paginator's and the two
 * can coexist across resolvers with no client-visible change. The cursor row's
 * sort key is resolved with a tiny lookup, then the page is fetched with a
 * `(time, id)` seek predicate.
 *
 * The lookup reads the sort key as TEXT, not as the entity's `Date`. Every
 * column callers page on is `timestamptz(6)`: microseconds. The driver
 * TRUNCATES a `Date` to milliseconds, so a cursor built from one named the
 * millisecond that contains its row, not the row's instant, and a seek written
 * against that point matched the wrong rows: paging down skipped every row of
 * the cursor's instant that sorted after the page boundary (`t = :cursor` is
 * false for `.123456` against `.123`), and paging up re-served the cursor's own
 * millisecond for ever (`t > :cursor` is true for it). A `now()`-stamped column
 * carries microseconds and a bulk import stamps a whole batch with one, so when
 * a page boundary fell inside such a batch of Content (`created_at`), the rest of
 * the batch was never served. The text is exact; see `keysetSeekExact` for the
 * predicate.
 */

/** Hard cap on page size — a client asking for `first: 100000` still gets one page. */
export const MAX_PAGE_SIZE = 200;
/** Page size when the caller passes neither `first` nor `last`. */
export const DEFAULT_PAGE_SIZE = 50;

export interface KeysetPageArgs {
  first?: number;
  /** Decoded row id of the `after` cursor (forward pagination). */
  afterId?: string | null;
  last?: number;
  /** Decoded row id of the `before` cursor (backward pagination). */
  beforeId?: string | null;
}

export interface KeysetPage<E> {
  /** Entities for this page, always in `(timeProp, id)` DESC order. */
  entities: E[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalCount: number;
}

interface KeysetOptions {
  /** Query alias used in the builder (e.g. 'c'). */
  alias: string;
  /** Entity PROPERTY name of the time-ish sort column (e.g. 'time', 'createdAt'). TypeORM maps it to the DB column. */
  timeProp: string;
  /** The owner scoping value; every query is filtered to this user. */
  userId: string;
  /**
   * Entity PROPERTY name of the owner column. Defaults to 'userId'; some entities
   * name the property 'user_id' (matching the column), so it is overridable.
   */
  userIdProp?: string;
  /**
   * Extra filtering applied to BOTH the count and the page query, so `totalCount`
   * agrees with what the pages actually yield (e.g. hiding rows whose parent was
   * soft-deleted). Must only add joins/where clauses — never ordering or limits.
   */
  scope?: <T extends ObjectLiteral>(qb: SelectQueryBuilder<T>) => SelectQueryBuilder<T>;
}

/**
 * Resolve the effective page size and direction from Relay args. Pure and
 * exported for unit testing.
 */
export function resolvePageShape(args: KeysetPageArgs): { limit: number; isBackward: boolean } {
  const isBackward = args.last != null || args.beforeId != null;
  const requested = isBackward ? args.last : args.first;
  const limit = Math.min(Math.max(requested ?? DEFAULT_PAGE_SIZE, 0), MAX_PAGE_SIZE);

  return { limit, isBackward };
}

export async function keysetPaginate<E extends ObjectLiteral>(
  repo: Repository<E>,
  args: KeysetPageArgs,
  options: KeysetOptions,
): Promise<KeysetPage<E>> {
  const { alias, timeProp, userId } = options;
  const userIdProp = options.userIdProp ?? 'userId';
  const scope = options.scope ?? ((qb) => qb);
  const { limit, isBackward } = resolvePageShape(args);

  const totalCount = await scope(
    repo.createQueryBuilder(alias).where(`${alias}.${userIdProp} = :userId`, { userId }),
  ).getCount();

  const cursorId = isBackward ? args.beforeId : args.afterId;
  let cursor: { time: string; id: string } | null = null;

  if (cursorId) {
    // Raw, and CAST to text: an entity read would hand the sort key back as a `Date`, which
    // is milliseconds (see the header). The text is Postgres' own spelling, microseconds included.
    const cursorRow = await repo
      .createQueryBuilder(alias)
      .select(`${alias}.id`, 'cursor_id')
      .addSelect(`CAST(${alias}.${timeProp} AS text)`, 'cursor_time')
      .where(`${alias}.id = :cursorId`, { cursorId })
      .getRawOne<{ cursor_id: string; cursor_time: string }>();

    if (cursorRow) {
      cursor = { time: cursorRow.cursor_time, id: cursorRow.cursor_id };
    }
  }

  // The query walks the composite (time, id) key. Forward pages read newest→oldest
  // (DESC), seeking to rows that sort after the cursor; backward pages read
  // oldest→newest (ASC), seeking to rows that sort before it, and are reversed
  // back to DESC before returning.
  const direction = isBackward ? 'ASC' : 'DESC';

  const qb = scope(repo.createQueryBuilder(alias).where(`${alias}.${userIdProp} = :userId`, { userId }))
    .orderBy(`${alias}.${timeProp}`, direction)
    .addOrderBy(`${alias}.id`, direction)
    .limit(limit + 1);

  if (cursor) {
    qb.andWhere(...keysetSeekExact(`${alias}.${timeProp}`, `${alias}.id`, direction, cursor.time, cursor.id));
  } else if (cursorId) {
    // A cursor was supplied but no matching row exists — return an empty page
    // rather than silently falling back to the first page.
    return { entities: [], hasNextPage: false, hasPreviousPage: isBackward, totalCount };
  }

  const rows = await qb.getMany();
  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;

  if (isBackward) {
    page.reverse();

    return {
      entities: page,
      hasNextPage: args.beforeId != null,
      hasPreviousPage: hasExtra,
      totalCount,
    };
  }

  return {
    entities: page,
    hasNextPage: hasExtra,
    hasPreviousPage: args.afterId != null,
    totalCount,
  };
}
