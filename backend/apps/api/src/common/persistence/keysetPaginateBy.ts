import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { type KeysetPage, type KeysetPageArgs, resolvePageShape } from './keysetPaginate';
import { type SeekKey, type SeekValue, multiKeySeek, seekOrder } from './multiKeySeek';
/** A {@link KeysetPage} whose count may not have been taken (`countTotal: false`). */
export interface KeysetByPage<E> extends Omit<KeysetPage<E>, 'totalCount'> {
  /** Every row under `scope`, or `null` when the caller passed `countTotal: false`. */
  totalCount: number | null;
}

/**
 * Keyset pagination pushed into SQL over an arbitrary total order — the
 * name-ordered lists (people, places) that `keysetPaginate`'s fixed
 * `(time, id) DESC` cannot serve. Same contract otherwise: the cursor is the
 * row id the caller decoded, the cursor row's sort keys are looked up with a
 * tiny query, the page is fetched with a seek past them and a real `LIMIT`
 * (+1 sentinel), and a cursor that matches no row yields an empty page rather
 * than the first one.
 *
 * `keys` must end in the id, so the order is total and every row has one
 * position in it. The `COUNT(*)` behind `totalCount` runs only when
 * `countTotal` is true, concurrently with the page.
 */
export interface KeysetByOptions<E extends ObjectLiteral> {
  /** Query alias used in the builder (e.g. 'person'). */
  alias: string;
  /** The order, first key first, ending in the id. */
  keys: readonly SeekKey[];
  /** The id expression the cursor row is looked up by (e.g. 'person.id'). */
  idExpr: string;
  /**
   * The filtering applied to BOTH the count and the page query, so `totalCount`
   * agrees with what the pages yield. Must only add joins/where clauses — never
   * ordering or limits.
   */
  scope: (qb: SelectQueryBuilder<E>) => SelectQueryBuilder<E>;
  /** Run the `COUNT(*)` for `totalCount`. Default true; `null` is reported otherwise. */
  countTotal?: boolean;
}

export async function keysetPaginateBy<E extends ObjectLiteral>(
  repo: Repository<E>,
  args: KeysetPageArgs,
  options: KeysetByOptions<E>,
): Promise<KeysetByPage<E>> {
  const { alias, keys, idExpr, scope } = options;
  const { limit, isBackward } = resolvePageShape(args);

  // Started first and collected last, so it runs while the cursor is resolved
  // and the page read. The no-op handler keeps a rejection that lands mid-flight
  // from being reported as unhandled; the `await` below still sees it.
  const counting: Promise<number | null> =
    (options.countTotal ?? true) ? scope(repo.createQueryBuilder(alias)).getCount() : Promise.resolve(null);
  counting.catch(() => undefined);

  const cursorId = isBackward ? args.beforeId : args.afterId;
  let cursor: SeekValue[] | null = null;

  if (cursorId) {
    let lookup = repo.createQueryBuilder(alias).select(keys[0].read ?? keys[0].expr, 'k0');
    keys.slice(1).forEach((key, i) => {
      lookup = lookup.addSelect(key.read ?? key.expr, `k${i + 1}`);
    });
    const row = await lookup
      .where(`${idExpr} = :cursorId`, { cursorId })
      .getRawOne<Record<string, SeekValue>>();

    if (row) {
      cursor = keys.map((_, i) => row[`k${i}`] ?? null);
    }
  }

  let qb = scope(repo.createQueryBuilder(alias));

  if (cursor) {
    qb = qb.andWhere(...multiKeySeek(keys, cursor, isBackward));
  } else if (cursorId) {
    return { entities: [], hasNextPage: false, hasPreviousPage: isBackward, totalCount: await counting };
  }

  seekOrder(keys, isBackward).forEach((key, i) => {
    qb = i === 0 ? qb.orderBy(key.expr, key.order, key.nulls) : qb.addOrderBy(key.expr, key.order, key.nulls);
  });

  const [rows, totalCount] = await Promise.all([qb.limit(limit + 1).getMany(), counting]);
  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;

  if (isBackward) {
    page.reverse();

    return { entities: page, hasNextPage: args.beforeId != null, hasPreviousPage: hasExtra, totalCount };
  }

  return { entities: page, hasNextPage: hasExtra, hasPreviousPage: args.afterId != null, totalCount };
}
