import type { ObjectLiteral, Repository } from 'typeorm';

/**
 * Keyset (seek) pagination pushed into SQL — replaces the load-the-whole-table
 * then slice-in-JS `Paginator.paginate` for large tables. The query fetches only
 * one page (+1 sentinel row) with a real `LIMIT`, ordered by `(timeProp, id)`
 * DESC, so cost is bounded regardless of table size.
 *
 * The cursor stays the row id (callers pass the DECODED id of the after/before
 * row), so cursors are byte-identical to the in-memory paginator's and the two
 * can coexist across resolvers with no client-visible change. The cursor row's
 * sort key is resolved with a tiny `findOne`, then the page is fetched with a
 * `(time, id)` seek predicate.
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
  const { limit, isBackward } = resolvePageShape(args);

  const totalCount = await repo
    .createQueryBuilder(alias)
    .where(`${alias}.${userIdProp} = :userId`, { userId })
    .getCount();

  const cursorId = isBackward ? args.beforeId : args.afterId;
  let cursor: { time: unknown; id: string } | null = null;

  if (cursorId) {
    const cursorRow = await repo
      .createQueryBuilder(alias)
      .select([`${alias}.id`, `${alias}.${timeProp}`])
      .where(`${alias}.id = :cursorId`, { cursorId })
      .getOne();

    if (cursorRow) {
      cursor = { time: (cursorRow as ObjectLiteral)[timeProp], id: (cursorRow as ObjectLiteral).id };
    }
  }

  // The query walks the composite (time, id) key. Forward pages read newest→oldest
  // (DESC) with a `<` seek; backward pages read oldest→newest (ASC) with a `>` seek
  // and are reversed back to DESC before returning.
  const direction = isBackward ? 'ASC' : 'DESC';
  const seekOp = isBackward ? '>' : '<';

  const qb = repo
    .createQueryBuilder(alias)
    .where(`${alias}.${userIdProp} = :userId`, { userId })
    .orderBy(`${alias}.${timeProp}`, direction)
    .addOrderBy(`${alias}.id`, direction)
    .limit(limit + 1);

  if (cursor) {
    qb.andWhere(
      `(${alias}.${timeProp} ${seekOp} :cursorTime OR (${alias}.${timeProp} = :cursorTime AND ${alias}.id ${seekOp} :cursorRowId))`,
      { cursorTime: cursor.time, cursorRowId: cursor.id },
    );
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
