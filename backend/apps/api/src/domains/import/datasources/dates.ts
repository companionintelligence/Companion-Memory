/**
 * The one "is this value a date?" coercion the importers share.
 *
 * Thirteen datasources carried their own, and they disagreed in ways nobody
 * had chosen: whether a number is epoch seconds or milliseconds (`> 1e12` in
 * four copies, `>= 1e12` in one — a boundary no real stamp sits on), whether
 * an all-digits STRING is an epoch, and whether a zone-less
 * `YYYY-MM-DD HH:MM:SS` is local time (what `Date` does) or UTC (what the
 * export meant). Those are options here, and every call site passes the ones
 * its own copy implemented, so what each importer stores is unchanged.
 *
 * One rule is deliberately uniform: an epoch of zero or below is not a date.
 * No export writes a real stamp before 1970; `0` is the sentinel of a missing
 * value, and three copies turned it into 1970-01-01 (the same class of
 * garbage `fileTimestamp` guards `birthtime` against).
 *
 * Left alone, on purpose: lyft's and uber's parsers (export-specific
 * fallbacks for `YYYY-MM-DD HH:MM:SS +0000 UTC`), letterboxd's
 * (`YYYY-MM-DD` pinned to midnight UTC via a template, which rejects what
 * `Date` would read as local), and email_date.ts (RFC 5322).
 */
export interface FlexibleDateOptions {
  /**
   * How a number is read. `'auto'`: milliseconds when `>= 1e12`, seconds
   * otherwise. `'s'`: always seconds. `'none'` (the default): numbers are not
   * dates — most exports write strings, and a numeric id under a date-like
   * key must not become a stamp.
   */
  epoch?: 'auto' | 's' | 'none';
  /** Read an all-digits string as an epoch, under the `epoch` rule. */
  numericStrings?: boolean;
  /**
   * Pin a zone-less `YYYY-MM-DD HH:MM:SS[.fff]` to UTC. Off, `Date` reads it
   * as local time, which is what every copy but discord's did.
   */
  naiveUtc?: boolean;
}

const NAIVE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function valid(d: Date): Date | undefined {
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `v` as a Date, or undefined when it is not one under `options`. */
export function parseFlexibleDate(v: unknown, options: FlexibleDateOptions = {}): Date | undefined {
  const { epoch = 'none', numericStrings = false, naiveUtc = false } = options;

  if (v == null) {
    return undefined;
  }

  if (typeof v === 'number') {
    if (epoch === 'none' || !Number.isFinite(v) || v <= 0) {
      return undefined;
    }

    return valid(new Date(epoch === 's' || v < 1e12 ? v * 1000 : v));
  }

  if (typeof v !== 'string') {
    return undefined;
  }

  const s = v.trim();

  if (!s) {
    return undefined;
  }

  if (numericStrings && /^\d+$/.test(s)) {
    return parseFlexibleDate(Number(s), { epoch: epoch === 'none' ? 'auto' : epoch });
  }

  if (naiveUtc) {
    const m = NAIVE_RE.exec(s);

    if (m) {
      return valid(new Date(`${m[1]}T${m[2]}Z`));
    }
  }

  return valid(new Date(s));
}

/**
 * The first date among a record's date-looking keys: the first key `keyRe`
 * matches whose value `parse` accepts. Two importers (microsoft_account,
 * roblox) carried this loop for exports whose column names vary.
 */
export function findDateField(
  rec: Record<string, unknown>,
  keyRe: RegExp,
  parse: (v: unknown) => Date | undefined,
): Date | undefined {
  for (const [key, value] of Object.entries(rec)) {
    if (!keyRe.test(key)) {
      continue;
    }

    const d = parse(value);

    if (d) {
      return d;
    }
  }

  return undefined;
}
