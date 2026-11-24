import { randomBytes } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROWS THAT SHARE AN INSTANT, AND THE WALK THAT MUST SERVE EACH OF THEM ONCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every column a keyset paginates on here is `timestamptz(6)`: microseconds. The
 * node-postgres driver reads one back as a JavaScript `Date`, and a `Date` holds
 * milliseconds, so `00:00:00.123456` comes back as `.123`. A cursor that went
 * through a `Date` therefore names the millisecond that contains its row, not the
 * row's instant, and a seek written against it skips or repeats rows at a page
 * boundary. See `keysetPaginate.subMillisecond.integration.spec.ts`, which found
 * it, and `common/persistence/keysetSeek.ts` for the cure.
 *
 * The paginators that spec could not reach (`FileService.findPage` and the things
 * list) share these datasets, so the three specs break on the same shapes:
 *
 *   ONE INSTANT       seven rows stamped to the same MICROsecond (more than any
 *                     page below), with a neighbour on each side, among them the
 *                     very next millisecond. A bulk import stamps its whole batch
 *                     with one `now()`.
 *   ONE MILLISECOND   six rows in one millisecond at six different microseconds,
 *                     seeded latest first so their ids run AGAINST their times.
 *                     Separate transactions that started in the same millisecond
 *                     leave rows like these. The page is ordered `(col, id)` at
 *                     full precision in SQL, so the seek has to agree with the
 *                     microseconds: a seek that treated the whole millisecond as
 *                     one instant would order them by id instead.
 *
 * Both are walked page by page, at sizes smaller than the cluster so the cursor
 * lands on every position in it, and a walk must serve each row exactly once, in
 * order, with an honest `hasNextPage`.
 */

/** One row a case seeds: a name to read a failure by, and the instant to stamp it with, microseconds and all. */
export interface RowSpec {
  label: string;
  at: string;
}

export interface SeededRow extends RowSpec {
  id: string;
}

export const INSTANT = '2026-05-01T00:00:00.123456Z';

export const ONE_INSTANT: RowSpec[] = [
  { label: 'o1', at: '2026-04-29T09:00:00.100000Z' },
  { label: 'o2', at: '2026-04-30T23:59:59.999000Z' },
  ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((label) => ({ label, at: INSTANT })),
  // The next millisecond: a seek that swallowed the cursor's whole millisecond would drop it.
  { label: 'n', at: '2026-05-01T00:00:00.124000Z' },
  { label: 'w1', at: '2026-05-03T08:00:00.000000Z' },
  { label: 'w2', at: '2026-05-13T20:00:00.500000Z' },
];

export const ONE_MILLISECOND: RowSpec[] = [
  { label: 'o', at: '2026-04-30T12:00:00.000000Z' },
  // Seeded latest first: the ids ascend while the times descend.
  { label: 'm6', at: '2026-05-01T00:00:00.123600Z' },
  { label: 'm5', at: '2026-05-01T00:00:00.123500Z' },
  { label: 'm4', at: '2026-05-01T00:00:00.123400Z' },
  { label: 'm3', at: '2026-05-01T00:00:00.123300Z' },
  { label: 'm2', at: '2026-05-01T00:00:00.123200Z' },
  { label: 'm1', at: '2026-05-01T00:00:00.123100Z' },
  { label: 'w', at: '2026-05-02T12:00:00.000000Z' },
];

export type DatasetName = 'one instant' | 'one millisecond';

export const DATASETS: Record<DatasetName, RowSpec[]> = {
  'one instant': ONE_INSTANT,
  'one millisecond': ONE_MILLISECOND,
};

export const DATASET_NAMES = Object.keys(DATASETS) as DatasetName[];

/** Smaller than the clusters above, so a page boundary falls on every position in them. */
export const PAGE_SIZES = [1, 2, 3, 5];

/** `2026-05-01T00:00:00.123456Z` -> `2026-05-01T00:00:00.123Z`: what the driver reads it back as. */
export const toMilliseconds = (at: string): string => at.replace(/(\.\d{3})\d*Z$/, '$1Z');

/**
 * Ids that ascend in the order they are asked for, in the uuid shape both tables want. The random
 * prefix keeps two runs of a spec off each other's rows; the low digits carry the order.
 */
export function idSequence(): () => string {
  const run = randomBytes(4).toString('hex');
  let counter = 0;

  return () => `${run}-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;
}

/** What a walk reads off a page, whichever way the page was fetched. */
export interface WalkedPage<Cursor> {
  ids: string[];
  hasNextPage: boolean;
  /** What a client passes back to get the page after this one. */
  next: Cursor | null;
}

export type FetchPage<Cursor> = (size: number, after: Cursor | null) => Promise<WalkedPage<Cursor>>;

/**
 * Follow the list the way a client does: ask for `size`, pass back the cursor, stop when the page says
 * there is no more. A seek that cannot get past a cluster re-serves it for ever, so the walk is bounded
 * a little above the longest correct one.
 */
export async function walkForward<Cursor>(
  fetch: FetchPage<Cursor>,
  size: number,
  rowCount: number,
): Promise<Array<WalkedPage<Cursor>>> {
  const pages: Array<WalkedPage<Cursor>> = [];
  let cursor: Cursor | null = null;

  for (let guard = 0; guard < rowCount + 2; guard++) {
    const page = await fetch(size, cursor);

    pages.push(page);

    if (!page.hasNextPage || page.ids.length === 0 || page.next == null) {
      break;
    }

    cursor = page.next;
  }

  return pages;
}

export interface ExpectedPage {
  labels: string[];
  hasNextPage: boolean;
}

/** Oldest first: by the instant the database stored, then by id. Both are fixed-width, so strings compare. */
export const oldestFirst = (rows: SeededRow[]): SeededRow[] =>
  [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

/** The pages a forward walk must return: newest first, `size` at a time, the last one without a next. */
export function expectedForwardWalk(rows: SeededRow[], size: number): ExpectedPage[] {
  const newestFirst = [...oldestFirst(rows)].reverse();
  const pages: ExpectedPage[] = [];

  for (let start = 0; start < newestFirst.length; start += size) {
    pages.push({
      labels: newestFirst.slice(start, start + size).map((row) => row.label),
      hasNextPage: start + size < newestFirst.length,
    });
  }

  return pages;
}

/** What a walk served, read against the rows it was meant to serve. */
export interface WalkReading {
  /** Rows served more than once. */
  repeated: string[];
  /** Rows never served. */
  dropped: string[];
  /** Each page as the list reported it, to hold against {@link expectedForwardWalk}. */
  pages: ExpectedPage[];
}

/**
 * Read a walk by the rows' labels. A spec asserts `repeated` and `dropped` are empty first, so a
 * failure says WHAT went wrong before the diff of `pages` says where.
 */
export function readWalk<Cursor>(pages: Array<WalkedPage<Cursor>>, rows: SeededRow[]): WalkReading {
  const labelOf = new Map(rows.map((row) => [row.id, row.label]));
  const label = (id: string) => labelOf.get(id) ?? id;
  const served = pages.flatMap((page) => page.ids.map(label));

  return {
    repeated: [...new Set(served.filter((name, at) => served.indexOf(name) !== at))],
    dropped: rows.map((row) => row.label).filter((name) => !served.includes(name)),
    pages: pages.map((page) => ({ labels: page.ids.map(label), hasNextPage: page.hasNextPage })),
  };
}
