/**
 * A keyset seek over ANY total order, not just `(time, id)`.
 *
 * `keysetSeekExact` pages a `(time DESC, id DESC)` order. The people and places
 * lists are ordered by name — a plausibility rank, then the trimmed name with
 * NULLs last, then `created_at DESC`, then the id — and that order mixes
 * directions and admits NULLs, which a single row-value comparison cannot
 * express. This builds the expanded form instead: a row sorts after the cursor
 * row when it is past it on the first key, or equal on the first and past it
 * on the second, and so on down to the id, which makes the order total.
 *
 * NULLs are placed the way the ORDER BY places them (Postgres' default is last
 * for ASC and first for DESC; `nulls` overrides). A NULL on the cursor row is
 * handled by shape, not by a parameter: nothing is "greater than NULL", so with
 * NULLs at the end the rows after a NULL on that key are the other NULLs,
 * decided by the later keys, and with NULLs at the start they are every non-NULL
 * row.
 *
 * Backward paging flips every key — direction AND null placement — so the same
 * builder serves both: `reverse: true` is "the rows before the cursor, read
 * from the far end", and the caller turns the page back round.
 */

export type SeekDirection = 'ASC' | 'DESC';
export type SeekValue = string | number | null;

export interface SeekKey {
  /** The ORDER BY expression, exactly as the page query writes it. */
  expr: string;
  order: SeekDirection;
  /** Where NULLs sort on this key. Postgres' default when absent: last for ASC, first for DESC. */
  nulls?: 'FIRST' | 'LAST';
  /** The key can be NULL. Equality is then `IS NOT DISTINCT FROM`, and a NULL cursor value is seeked past correctly. */
  nullable?: boolean;
  /**
   * How to read the cursor row's value for this key when that differs from `expr`:
   * `CAST(col AS text)` for a `timestamptz`, so the value binds back at full precision
   * (see `keysetSeekExact` for why a `Date` cannot carry it).
   */
  read?: string;
}

/** The ORDER BY for `keys`, flipped when `reverse`. */
export function seekOrder(
  keys: readonly SeekKey[],
  reverse: boolean,
): Array<{ expr: string; order: SeekDirection; nulls: 'NULLS FIRST' | 'NULLS LAST' }> {
  return keys.map((key) => {
    const order = flip(key.order, reverse);

    return { expr: key.expr, order, nulls: nullsLast(key, reverse) ? 'NULLS LAST' : 'NULLS FIRST' };
  });
}

/**
 * The `andWhere` arguments that keep only rows strictly past the cursor row,
 * whose key values are `values` (one per key, in order, as the database read
 * them). Spread it: `qb.andWhere(...multiKeySeek(keys, values, reverse))`.
 *
 * The parameters are named `<prefix>0..n`; pick a prefix no other clause uses.
 */
export function multiKeySeek(
  keys: readonly SeekKey[],
  values: readonly SeekValue[],
  reverse: boolean,
  prefix = 'seek',
): [sql: string, params: Record<string, SeekValue>] {
  if (keys.length !== values.length) {
    throw new Error(`multiKeySeek: ${keys.length} keys but ${values.length} cursor values`);
  }

  const params: Record<string, SeekValue> = {};
  const arms: string[] = [];

  keys.forEach((key, i) => {
    const value = values[i];
    const name = `${prefix}${i}`;
    const past = pastClause(key, value, reverse, name);

    if (past == null) {
      return;
    }

    if (value != null) {
      params[name] = value;
    }

    const equalities = keys.slice(0, i).map((earlier, j) => equalClause(earlier, values[j], `${prefix}${j}`));
    // An earlier key's equality binds its parameter even when its own arm was skipped.
    keys.slice(0, i).forEach((_, j) => {
      if (values[j] != null) {
        params[`${prefix}${j}`] = values[j];
      }
    });

    arms.push([...equalities, past].join(' AND '));
  });

  if (arms.length === 0) {
    // The cursor row is the last one the order can produce: nothing follows it.
    return ['1 = 0', {}];
  }

  return [`(${arms.map((arm) => `(${arm})`).join(' OR ')})`, params];
}

function flip(order: SeekDirection, reverse: boolean): SeekDirection {
  return reverse ? (order === 'ASC' ? 'DESC' : 'ASC') : order;
}

/** Whether NULLs sort at the END of this key's order (after flipping for `reverse`). */
function nullsLast(key: SeekKey, reverse: boolean): boolean {
  const last = key.nulls ? key.nulls === 'LAST' : key.order === 'ASC';

  return reverse ? !last : last;
}

/** Rows strictly past `value` on this key alone, or `null` when no row can be. */
function pastClause(key: SeekKey, value: SeekValue, reverse: boolean, param: string): string | null {
  const atEnd = nullsLast(key, reverse);

  if (value == null) {
    // Past a NULL: nothing when NULLs sort last; every non-NULL row when they sort first.
    return atEnd ? null : `${key.expr} IS NOT NULL`;
  }

  const comparison = `${key.expr} ${flip(key.order, reverse) === 'ASC' ? '>' : '<'} :${param}`;

  // A NULL row sorts after every value when NULLs are at the end.
  return key.nullable && atEnd ? `(${comparison} OR ${key.expr} IS NULL)` : comparison;
}

function equalClause(key: SeekKey, value: SeekValue, param: string): string {
  if (value == null) {
    return `${key.expr} IS NULL`;
  }

  return key.nullable ? `${key.expr} IS NOT DISTINCT FROM :${param}` : `${key.expr} = :${param}`;
}
