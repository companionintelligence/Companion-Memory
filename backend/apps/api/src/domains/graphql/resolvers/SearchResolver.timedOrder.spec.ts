import type { RequestContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import type { SearchInput } from '../types/SearchInput';

import { SearchResolver } from './SearchResolver';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "OLDEST FIRST" MUST START AT THE OLDEST ROW AND WALK FORWARD, ONE PAGE AT A TIME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEM-15. On /memory, a When filter spanning two months with Sort set to
 * "Oldest first" opened on May 3-5 although rows existed from Apr 29, and the
 * next page jumped BACK to Apr 29 - May 1, so the list read "MAY 2026" above
 * "APRIL 2026". `search` with `sortBy: time, sortOrder: asc` returned page 1 =
 * 05-03..05-05, page 2 = 04-29..05-01, page 3 = 04-29..04-30.
 *
 * The timed browse merges one SQL window per entity type. Every one of those
 * windows was fetched newest-first with a newest-first keyset cursor, and
 * ascending was produced by sorting that window in memory — so "oldest first"
 * meant "the oldest of the NEWEST `first * 4` rows of each type", and a
 * cursor taken from the end of that page then walked backwards from there.
 *
 * The services stubbed below honour the contract the real ones now implement:
 * `order` sets the direction of both the ORDER BY and the seek, so a page is
 * the first rows of each type PAST the cursor in that direction. Against the
 * old resolver, which asked every service for DESC whatever the sort, the
 * ascending cases below fail exactly the way the tester saw it.
 */

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT = { userId: USER } as RequestContext;

const WINDOW = { startTime: '2026-04-29T00:00:00.000Z', endTime: '2026-05-13T23:59:59.999Z' };

interface Row {
  id: string;
  type: RowType;
  time: Date;
}

/** Which timestamp field each type's resolved entity carries (what getEntityTimestamp reads). */
const TIME_FIELD: Record<string, string> = {
  event: 'startTime',
  communication: 'time',
  'browser-activity': 'time',
  note: 'updatedAt',
  content: 'updatedAt',
  file: 'updatedAt',
};

const TYPES = ['event', 'communication', 'browser-activity', 'note', 'content', 'file'] as const;
type RowType = (typeof TYPES)[number];
/**
 * Events dominate a real library (every photo and calendar entry is one), and that
 * is what the bug needs: it only shows once ONE type has more rows in range than a
 * page's per-type fetch window, `first * 4` (120 at the app's page size of 30).
 * Below that every window swallows its whole type and ascending looks fine.
 */
const EVENTS = 150;
const OTHERS = 8;
const HOUR_MS = 3_600_000;
const FIRST_MS = Date.parse(WINDOW.startTime);
/** Two instants at which EVERY type has a row. */
const TIE_HOURS = [118, 295];

const uuid = (n: number) => `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * 204 rows over 14.5 days, six types interleaved, straddling the month boundary.
 *
 * - 150 events spread across the whole range, one every ~2.3 hours.
 * - 8 each of the other five types at scattered hours.
 * - A six-way tie at two instants (one row of every type at the same millisecond),
 *   with ids running against the type order, so the tiebreak decides the order of
 *   the tie and a page boundary can land inside it.
 * - One note a millisecond before midnight on the 30th and one event on the stroke
 *   of the 1st.
 */
function buildRows(): Row[] {
  const rows: Row[] = [];
  let next = 1;
  const id = () => uuid(next++);

  for (let j = 0; j < EVENTS; j++) {
    rows.push({ id: id(), type: 'event', time: new Date(FIRST_MS + Math.floor(j * 2.31 * HOUR_MS) + j) });
  }

  TYPES.slice(1).forEach((type, offset) => {
    const t = offset + 1;

    for (let j = 0; j < OTHERS; j++) {
      rows.push({
        id: id(),
        type,
        time: new Date(FIRST_MS + ((j * 53 + t * 17) % 347) * HOUR_MS + t * 1_000 + j),
      });
    }
  });

  for (const hours of TIE_HOURS) {
    // Walking the types backwards hands the LAST type the lowest id, so the tie sorts by id
    // in the opposite order to the one the services' results are concatenated in.
    [...TYPES].reverse().forEach((type) => {
      rows.push({ id: id(), type, time: new Date(FIRST_MS + hours * HOUR_MS) });
    });
  }

  rows.push(
    { id: uuid(900), type: 'note', time: new Date('2026-04-30T23:59:59.999Z') },
    { id: uuid(901), type: 'event', time: new Date('2026-05-01T00:00:00.000Z') },
  );

  return rows;
}

const ROWS = buildRows();

const byTimeThenId = (a: Row, b: Row) => a.time.getTime() - b.time.getTime() || (a.id < b.id ? -1 : 1);
const ASCENDING = [...ROWS].sort(byTimeThenId);
const DESCENDING = [...ASCENDING].reverse();

type TimedOptions = {
  limit?: number;
  order?: unknown;
  startTime?: Date;
  endTime?: Date;
  afterTime?: Date;
  afterId?: string;
};

/** `'ASC'`, or a FindOptionsOrder like `{ startTime: 'ASC' }`: the direction either way. */
function directionOf(order: unknown): 'ASC' | 'DESC' {
  const raw = typeof order === 'string' ? order : Object.values((order ?? {}) as object)[0];

  return String(raw).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

const inWindow = (row: Row, options: Pick<TimedOptions, 'startTime' | 'endTime'>) =>
  (options.startTime == null || row.time >= options.startTime) &&
  (options.endTime == null || row.time <= options.endTime);

/** What `getEntitiesForX` does in SQL: window, seek past the cursor in `order`, order, limit. */
function serve(type: IndexableEntity, options: TimedOptions): EntityIdentifier<IndexableEntity>[] {
  const sign = directionOf(options.order) === 'ASC' ? 1 : -1;
  const { afterTime, afterId } = options;

  return ROWS.filter((row) => row.type === type && inWindow(row, options))
    .filter((row) => {
      if (!afterTime || !afterId) {
        return true;
      }

      return (
        sign * (row.time.getTime() - afterTime.getTime()) > 0 ||
        (row.time.getTime() === afterTime.getTime() && sign * (row.id < afterId ? -1 : 1) > 0)
      );
    })
    .sort((a, b) => sign * byTimeThenId(a, b))
    .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER)
    .map((row) => ({ id: row.id, type }));
}

function makeResolver() {
  const calls: Partial<Record<IndexableEntity, TimedOptions[]>> = {};

  const timed = (type: IndexableEntity, fetch: string) => {
    const count = fetch.replace('getEntitiesFor', 'countEntitiesFor');

    return {
      [fetch]: jest.fn(async (_context: unknown, options: TimedOptions) => {
        (calls[type] ??= []).push(options);

        return serve(type, options);
      }),
      [count]: jest.fn(
        async (_context: unknown, options: TimedOptions) =>
          ROWS.filter((row) => row.type === type && inWindow(row, options)).length,
      ),
    };
  };

  const empty = (fetch: string) => ({
    [fetch]: jest.fn(async () => []),
    [fetch.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
  });

  const entityResolutionService = {
    resolve: jest.fn(async (_context: unknown, identifiers: EntityIdentifier<IndexableEntity>[]) => {
      const resolved = new Map<string, unknown>();

      for (const identifier of identifiers) {
        const row = ROWS.find((candidate) => candidate.id === identifier.id)!;

        resolved.set(`${identifier.type}:${identifier.id}`, {
          type: identifier.type,
          id: identifier.id,
          entity: { id: row.id, [TIME_FIELD[identifier.type]]: row.time, tags: [] },
        });
      }

      return resolved;
    }),
  };

  const resolver = new SearchResolver(
    timed('browser-activity', 'getEntitiesForBrowserActivities') as never,
    timed('communication', 'getEntitiesForCommunications') as never,
    empty('getEntitiesForConcepts') as never,
    { findEventIdsForMedia: jest.fn(async () => []), ...timed('content', 'getEntitiesForContents') } as never,
    entityResolutionService as never,
    timed('event', 'getEntitiesForEvents') as never,
    timed('file', 'getEntitiesForFiles') as never,
    empty('getEntitiesForFileChunks') as never,
    empty('getEntitiesForItems') as never,
    timed('note', 'getEntitiesForNotes') as never,
    empty('getEntitiesForPeople') as never,
    empty('getEntitiesForPlaces') as never,
    empty('getEntitiesForProducts') as never,
    empty('getEntitiesForReceipts') as never,
    empty('getEntitiesForAnswers') as never,
    {} as never,
    {
      authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
      recordRead: jest.fn().mockResolvedValue(undefined),
    } as never,
    { search: jest.fn(async () => []) } as never,
    { getEntitiesForTags: jest.fn(async () => []), searchByLabel: jest.fn(async () => []) } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { resolver, calls };
}

type Page = Awaited<ReturnType<SearchResolver['search']>>;

const rowOf = (node: unknown): Row => {
  const { id } = GlobalUID.decode((node as { id: string }).id);

  return ROWS.find((row) => row.id === id)!;
};

const stamp = (row: Row) => `${row.time.toISOString()} ${row.id}`;

/** Page through `search` the way the client does — `after: endCursor` — until it says there is no more. */
async function walk(resolver: SearchResolver, input: Partial<SearchInput>) {
  const pages: Page[] = [];
  let after: string | null | undefined;

  for (let guard = 0; guard < 500; guard++) {
    const page = await resolver.search(CONTEXT, { ...input, ...(after ? { after } : {}) } as SearchInput);

    pages.push(page);

    if (!page.pageInfo.hasNextPage) {
      break;
    }

    after = page.pageInfo.endCursor;
  }

  return { pages, rows: pages.flatMap((page) => page.edges.map((edge) => rowOf(edge.node))) };
}

function decodeCursor(cursor: string): { time: string; globalId: string } {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const separator = decoded.indexOf('::');

  return { time: decoded.slice(0, separator), globalId: decoded.slice(separator + 2) };
}

describe('SearchResolver timed browse, oldest first', () => {
  it('has the shape the scenario needs: six types, a month boundary, ties across types', () => {
    expect(new Set(ROWS.map((row) => row.type)).size).toBe(6);
    expect(ASCENDING.some((row) => row.time.toISOString() < '2026-05-01')).toBe(true);
    expect(ASCENDING.some((row) => row.time.toISOString() >= '2026-05-01')).toBe(true);

    const instants = ROWS.map((row) => row.time.getTime());

    expect(instants.length - new Set(instants).size).toBeGreaterThan(0);

    // One type outgrows the per-type fetch window at the app's own page size (30 * 4 = 120):
    // without that, the old resolver never truncated anything and the bug could not show.
    expect(ROWS.filter((row) => row.type === 'event').length).toBeGreaterThan(30 * 4);
  });

  it.each([30, 100, 7, 1])(
    'pages the window oldest to newest with first=%i: ascending, contiguous, nothing repeated or missed',
    async (first) => {
      const { resolver } = makeResolver();

      const { pages, rows } = await walk(resolver, { ...WINDOW, first, sortBy: 'time', sortOrder: 'asc' });

      // Exactly the window's rows, in exactly ascending (time, id) order: any gap, repeat
      // or backwards step breaks the equality, and says where.
      expect(rows.map(stamp)).toEqual(ASCENDING.map(stamp));

      expect(pages.length).toBeGreaterThanOrEqual(3);

      // Each page on its own is ascending, and each starts strictly after the one before.
      pages.forEach((page, index) => {
        const pageRows = page.edges.map((edge) => rowOf(edge.node));

        expect([...pageRows].sort(byTimeThenId)).toEqual(pageRows);

        if (index > 0) {
          const previousLast = rowOf(pages[index - 1].edges.at(-1)!.node);

          expect(byTimeThenId(previousLast, pageRows[0])).toBeLessThan(0);
        }
      });
    },
  );

  it('opens on the first row of the range, not on the oldest of the newest rows', async () => {
    const { resolver } = makeResolver();

    const page = await resolver.search(CONTEXT, {
      ...WINDOW,
      first: 30,
      sortBy: 'time',
      sortOrder: 'asc',
    } as SearchInput);

    const first = rowOf(page.edges[0].node);

    expect(stamp(first)).toBe(stamp(ASCENDING[0]));
    expect(first.time.toISOString() < '2026-05-01').toBe(true);
  });

  it('never lets a later page read older than the page before it, across the month boundary', async () => {
    const { resolver } = makeResolver();

    const { rows } = await walk(resolver, { ...WINDOW, first: 10, sortBy: 'time', sortOrder: 'asc' });
    const months = rows.map((row) => row.time.toISOString().slice(0, 7));

    // "MAY 2026" never appears above "APRIL 2026".
    expect(months).toEqual([...months].sort());
    expect(months[0]).toBe('2026-04');
    expect(months.at(-1)).toBe('2026-05');
  });

  it('reads upwards for sortOrder asc with no sortBy: a browse with no query sorts by time by default', async () => {
    const { resolver, calls } = makeResolver();

    // The web client always names `sortBy: time`, but the API documents it as defaulting to time when
    // there is no query, so a caller that sends only `sortOrder` must get the same oldest-first walk.
    const { rows } = await walk(resolver, { ...WINDOW, first: 30, sortOrder: 'asc' });

    expect(rows.map(stamp)).toEqual(ASCENDING.map(stamp));

    for (const type of TYPES) {
      for (const options of calls[type]!) {
        expect(directionOf(options.order)).toBe('ASC');
      }
    }
  });

  it('reports the same totalCount on every page, in either direction, equal to the rows that exist', async () => {
    const { resolver } = makeResolver();

    for (const sortOrder of ['asc', 'desc']) {
      const { pages } = await walk(resolver, { ...WINDOW, first: 10, sortBy: 'time', sortOrder });

      expect(pages.length).toBeGreaterThan(1);
      expect(new Set(pages.map((page) => page.totalCount))).toEqual(new Set([ROWS.length]));
    }
  });

  it('round-trips its cursors: endCursor names the last row, and the next fetch seeks past exactly that row', async () => {
    const { resolver, calls } = makeResolver();
    const input = { ...WINDOW, first: 12, sortBy: 'time', sortOrder: 'asc' } as SearchInput;

    const first = await resolver.search(CONTEXT, input);
    const last = first.edges.at(-1)!;

    expect(first.pageInfo.endCursor).toBe(last.cursor);
    expect(first.pageInfo.startCursor).toBe(first.edges[0].cursor);

    const lastRow = rowOf(last.node);

    expect(decodeCursor(last.cursor)).toEqual({
      time: lastRow.time.toISOString(),
      globalId: GlobalUID.encode(lastRow.type, lastRow.id),
    });

    await resolver.search(CONTEXT, { ...input, after: first.pageInfo.endCursor } as SearchInput);

    // Every type that was fetched twice got the cursor row's own (time, id) as its seek bound,
    // and was again asked for ascending.
    for (const type of TYPES) {
      const [, second] = calls[type]!;

      expect(second.afterTime).toEqual(lastRow.time);
      expect(second.afterId).toBe(lastRow.id);
      expect(directionOf(second.order)).toBe('ASC');
    }
  });

  it('asks every table for ascending, not just the merge', async () => {
    const { resolver, calls } = makeResolver();

    await resolver.search(CONTEXT, { ...WINDOW, first: 5, sortBy: 'time', sortOrder: 'asc' } as SearchInput);

    for (const type of TYPES) {
      expect(calls[type]).toHaveLength(1);
      expect(directionOf(calls[type]![0].order)).toBe('ASC');
    }
  });

  it('works with no date window at all', async () => {
    const { resolver } = makeResolver();

    const { rows } = await walk(resolver, { first: 9, sortBy: 'time', sortOrder: 'asc' });

    expect(rows.map(stamp)).toEqual(ASCENDING.map(stamp));
  });

  it('keeps the legacy time-only cursor on the near edge of the window: after, for ascending', async () => {
    const { resolver, calls } = makeResolver();
    const cursor = Buffer.from('2026-05-01T00:00:00.000Z').toString('base64');

    await resolver.search(CONTEXT, {
      ...WINDOW,
      first: 5,
      sortBy: 'time',
      sortOrder: 'asc',
      after: cursor,
    } as SearchInput);

    const options = calls.event![0];

    // No id to seek past, so the walk resumes from the cursor's own instant (inclusive) —
    // the same fallback the descending browse has always had, mirrored.
    expect(options.afterTime).toBeUndefined();
    expect(options.afterId).toBeUndefined();
    expect(options.startTime).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    expect(options.endTime).toEqual(new Date(WINDOW.endTime));
  });
});

describe('SearchResolver timed browse, newest first (unchanged)', () => {
  it.each([
    ['sortOrder desc', { sortBy: 'time', sortOrder: 'desc' }],
    ['no sort at all', {}],
    ['sortOrder alone', { sortOrder: 'desc' }],
  ])('still pages newest to oldest with %s', async (_label, sort) => {
    const { resolver, calls } = makeResolver();

    const { pages, rows } = await walk(resolver, { ...WINDOW, first: 8, ...sort });

    expect(rows.map(stamp)).toEqual(DESCENDING.map(stamp));
    expect(pages.length).toBeGreaterThanOrEqual(3);

    for (const type of TYPES) {
      for (const options of calls[type]!) {
        expect(directionOf(options.order)).toBe('DESC');
      }
    }
  });

  it('leaves a non-time sort on the newest-first fetch it has always used', async () => {
    const { resolver, calls } = makeResolver();

    await resolver.search(CONTEXT, { ...WINDOW, first: 5, sortBy: 'name', sortOrder: 'asc' } as SearchInput);

    // Only "oldest first" reads the tables upwards. A name sort has no time direction to follow.
    for (const type of TYPES) {
      expect(directionOf(calls[type]![0].order)).toBe('DESC');
    }
  });
});
