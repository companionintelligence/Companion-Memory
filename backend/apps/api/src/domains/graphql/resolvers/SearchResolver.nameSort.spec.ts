import type { RequestContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import type { SearchInput } from '../types/SearchInput';

import { SearchResolver } from './SearchResolver';

/**
 * "Name (A-Z)" with no search text (#3079, section 2): the explorer listed the
 * messages first in time order, then events A to Z, and stopped early ("39 of
 * 69 loaded · end"). Messages had no name to the sort (it read name/title/
 * summary, and a message only has a subject or a preview), and the next page
 * was asked for with a TIME cursor taken from the last row of a NAME-ordered
 * page, so the timed browse windowed past rows the list had not shown yet.
 *
 * The services below honour the timed browse's contract (window, seek past the
 * cursor in `order`, limit), as in SearchResolver.timedOrder.spec.ts.
 */

const USER = '00000000-0000-0000-0000-0000000000bb';
const CONTEXT = { userId: USER } as RequestContext;

type RowType = 'event' | 'communication' | 'note';

interface Row {
  id: string;
  type: RowType;
  time: Date;
  /** The fields the resolved entity carries for its name. */
  fields: Record<string, string | null>;
}

const TIME_FIELD: Record<RowType, string> = { event: 'startTime', communication: 'time', note: 'updatedAt' };
const HOUR_MS = 3_600_000;
const FIRST_MS = Date.parse('2026-01-01T00:00:00.000Z');
const uuid = (n: number) => `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * 150 events (more than one page's per-type window of 30 * 4), named so that
 * name order runs against time order; 12 messages, half with a subject and
 * half chat-style with only a preview; 6 notes; and 3 events with no title.
 */
function buildRows(): Row[] {
  const rows: Row[] = [];
  let next = 1;

  for (let j = 0; j < 150; j++) {
    // (j * 37) % 150 scatters the names across time.
    const label = String((j * 37) % 150).padStart(3, '0');

    rows.push({ id: uuid(next++), type: 'event', time: new Date(FIRST_MS + j * HOUR_MS), fields: { title: `Event ${label}` } });
  }

  for (let j = 0; j < 12; j++) {
    rows.push({
      id: uuid(next++),
      type: 'communication',
      time: new Date(FIRST_MS + (j * 13 + 5) * HOUR_MS),
      fields: j % 2 === 0 ? { subject: `Re: plan ${j}`, preview: 'see below' } : { subject: null, preview: `chat line ${j}` },
    });
  }

  for (let j = 0; j < 6; j++) {
    rows.push({ id: uuid(next++), type: 'note', time: new Date(FIRST_MS + (j * 29 + 3) * HOUR_MS), fields: { title: `Note ${j}` } });
  }

  for (let j = 0; j < 3; j++) {
    rows.push({ id: uuid(next++), type: 'event', time: new Date(FIRST_MS + (j * 41 + 7) * HOUR_MS), fields: { title: null } });
  }

  return rows;
}

const ROWS = buildRows();

const nameOf = (row: Row) =>
  [row.fields.title, row.fields.subject, row.fields.preview].find((value) => value != null && value !== '') ?? '';

/** The order the list must come out in: by name, unnamed rows last, ties by id. */
function expectedOrder(direction: 1 | -1): Row[] {
  return [...ROWS].sort((a, b) => {
    const [aName, bName] = [nameOf(a), nameOf(b)];

    if ((aName === '') !== (bName === '')) {
      return aName === '' ? 1 : -1;
    }

    return direction * (aName.localeCompare(bName) || a.id.localeCompare(b.id));
  });
}

type TimedOptions = { limit?: number; order?: unknown; afterTime?: Date; afterId?: string };

function directionOf(order: unknown): 'ASC' | 'DESC' {
  const raw = typeof order === 'string' ? order : Object.values((order ?? {}) as object)[0];

  return String(raw).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

function serve(type: RowType, options: TimedOptions): EntityIdentifier<IndexableEntity>[] {
  const sign = directionOf(options.order) === 'ASC' ? 1 : -1;
  const { afterTime, afterId } = options;

  return ROWS.filter((row) => row.type === type)
    .filter(
      (row) =>
        !afterTime ||
        !afterId ||
        sign * (row.time.getTime() - afterTime.getTime()) > 0 ||
        (row.time.getTime() === afterTime.getTime() && sign * (row.id < afterId ? -1 : 1) > 0),
    )
    .sort((a, b) => sign * (a.time.getTime() - b.time.getTime() || (a.id < b.id ? -1 : 1)))
    .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER)
    .map((row) => ({ id: row.id, type }));
}

function makeResolver() {
  const timed = (type: RowType, fetch: string) => ({
    [fetch]: jest.fn(async (_context: unknown, options: TimedOptions) => serve(type, options)),
    [fetch.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(
      async () => ROWS.filter((row) => row.type === type).length,
    ),
  });
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
          entity: { id: row.id, [TIME_FIELD[row.type]]: row.time, ...row.fields, tags: [] },
        });
      }

      return resolved;
    }),
  };

  return new SearchResolver(
    empty('getEntitiesForBrowserActivities') as never,
    timed('communication', 'getEntitiesForCommunications') as never,
    empty('getEntitiesForConcepts') as never,
    { findEventIdsForMedia: jest.fn(async () => []), ...empty('getEntitiesForContents') } as never,
    entityResolutionService as never,
    timed('event', 'getEntitiesForEvents') as never,
    empty('getEntitiesForFiles') as never,
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
}

const rowOf = (node: unknown): Row => {
  const { id } = GlobalUID.decode((node as { id: string }).id);

  return ROWS.find((row) => row.id === id)!;
};

async function walk(resolver: SearchResolver, input: Partial<SearchInput>) {
  const rows: Row[] = [];
  let after: string | null | undefined;
  let totalCount = 0;

  for (let guard = 0; guard < 100; guard++) {
    const page = await resolver.search(CONTEXT, { ...input, ...(after ? { after } : {}) } as SearchInput);

    rows.push(...page.edges.map((edge) => rowOf(edge.node)));
    totalCount = page.totalCount;

    if (!page.pageInfo.hasNextPage) {
      break;
    }

    after = page.pageInfo.endCursor;
  }

  return { rows, totalCount };
}

describe('SearchResolver timed browse, sorted by name', () => {
  it.each([
    ['asc', 1],
    ['desc', -1],
  ] as const)('pages every row in name order (%s), unnamed rows last, nothing repeated or missed', async (sortOrder, sign) => {
    const { rows, totalCount } = await walk(makeResolver(), { first: 30, sortBy: 'name', sortOrder });

    expect(rows.map((row) => row.id)).toEqual(expectedOrder(sign).map((row) => row.id));
    expect(totalCount).toBe(ROWS.length);
  });

  it("names a message by its subject, or by its preview when it has none, as the list shows it", async () => {
    const { rows } = await walk(makeResolver(), { first: 30, sortBy: 'name', sortOrder: 'asc' });
    const names = rows.map(nameOf);

    // "chat line 1" sorts among the C's, not ahead of "Event 000".
    expect(names.indexOf('chat line 1')).toBeLessThan(names.indexOf('Event 000'));
    expect(names.indexOf('Re: plan 0')).toBeGreaterThan(names.indexOf('Note 5'));
    expect(names.slice(-3)).toEqual(['', '', '']);
  });
});
