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

type RowType = 'event' | 'communication' | 'note' | 'answer' | 'receipt';

interface Row {
  id: string;
  type: RowType;
  time: Date;
  /** The fields the resolved entity carries for its name. */
  fields: Record<string, string | null>;
}

const TIME_FIELD: Record<RowType, string> = {
  event: 'startTime',
  communication: 'time',
  note: 'updatedAt',
  answer: 'answeredAt',
  receipt: 'purchasedAt',
};
const HOUR_MS = 3_600_000;
const FIRST_MS = Date.parse('2026-01-01T00:00:00.000Z');
const uuid = (n: number) => `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * 150 events (more than one page's per-type window of 30 * 4), named so that
 * name order runs against time order; 12 messages, half with a subject and
 * half chat-style with only a preview, one of those also carrying an LLM
 * summary the row never shows; 6 notes; 3 answers, shown by their question;
 * 3 receipts, shown by their merchant; and 3 events with no title.
 */
function buildRows(): Row[] {
  const rows: Row[] = [];
  let next = 1;

  for (let j = 0; j < 150; j++) {
    // (j * 37) % 150 scatters the names across time.
    const label = String((j * 37) % 150).padStart(3, '0');

    rows.push({
      id: uuid(next++),
      type: 'event',
      time: new Date(FIRST_MS + j * HOUR_MS),
      fields: { title: `Event ${label}` },
    });
  }

  for (let j = 0; j < 12; j++) {
    rows.push({
      id: uuid(next++),
      type: 'communication',
      time: new Date(FIRST_MS + (j * 13 + 5) * HOUR_MS),
      fields:
        j % 2 === 0
          ? { subject: `Re: plan ${j}`, preview: 'see below' }
          : { subject: null, preview: `chat line ${j}`, ...(j === 3 ? { summary: 'Aardvark summary' } : {}) },
    });
  }

  for (let j = 0; j < 3; j++) {
    rows.push({
      id: uuid(next++),
      type: 'answer',
      time: new Date(FIRST_MS + (j * 31 + 11) * HOUR_MS),
      fields: { question: `What did you do ${j}?` },
    });
  }

  for (const merchant of ['Zebra Books', 'Amazon', 'Bakery Corner']) {
    rows.push({
      id: uuid(next++),
      type: 'receipt',
      time: new Date(FIRST_MS + (next * 17 + 2) * HOUR_MS),
      fields: { merchantName: merchant },
    });
  }

  for (let j = 0; j < 6; j++) {
    rows.push({
      id: uuid(next++),
      type: 'note',
      time: new Date(FIRST_MS + (j * 29 + 3) * HOUR_MS),
      fields: { title: `Note ${j}` },
    });
  }

  for (let j = 0; j < 3; j++) {
    rows.push({
      id: uuid(next++),
      type: 'event',
      time: new Date(FIRST_MS + (j * 41 + 7) * HOUR_MS),
      fields: { title: null },
    });
  }

  return rows;
}

const ROWS = buildRows();

/** What each row shows as its title: the event or note title, a message's subject or preview, an answer's question. */
const nameOf = (row: Row) =>
  [
    row.fields.title,
    row.fields.subject,
    row.fields.preview,
    row.fields.merchantName,
    row.fields.question,
  ].find((value) => value != null && value !== '') ?? '';

/** What a browse with no type filter reads: receipts are opt-in, listed only when asked for. */
const DEFAULT_BROWSE = ROWS.filter((row) => row.type !== 'receipt');

/** The order the list must come out in: by name, unnamed rows last, ties by id. */
function expectedOrder(direction: 1 | -1): Row[] {
  return [...DEFAULT_BROWSE].sort((a, b) => {
    const [aName, bName] = [nameOf(a), nameOf(b)];

    if ((aName === '') !== (bName === '')) {
      return aName === '' ? 1 : -1;
    }

    return direction * (aName.localeCompare(bName) || a.id.localeCompare(b.id));
  });
}

type TimedOptions = {
  limit?: number;
  order?: unknown;
  startTime?: Date;
  endTime?: Date;
  afterTime?: Date;
  afterId?: string;
};

function directionOf(order: unknown): 'ASC' | 'DESC' {
  const raw = typeof order === 'string' ? order : Object.values((order ?? {}) as object)[0];

  return String(raw).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

function serve(type: RowType, options: TimedOptions): EntityIdentifier<IndexableEntity>[] {
  const sign = directionOf(options.order) === 'ASC' ? 1 : -1;
  const { afterTime, afterId } = options;

  return ROWS.filter(
    (row) =>
      row.type === type &&
      (options.startTime == null || row.time >= options.startTime) &&
      (options.endTime == null || row.time <= options.endTime),
  )
    .filter(
      (row) =>
        !afterTime ||
        !afterId ||
        sign * (row.time.getTime() - afterTime.getTime()) > 0 ||
        (row.time.getTime() === afterTime.getTime() && sign * row.id.localeCompare(afterId) > 0),
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
        const { question, ...fields } = row.fields;

        resolved.set(`${identifier.type}:${identifier.id}`, {
          type: identifier.type,
          id: identifier.id,
          entity: {
            id: row.id,
            [TIME_FIELD[row.type]]: row.time,
            ...fields,
            ...(question != null ? { question: { text: question } } : {}),
            tags: [],
          },
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
    timed('receipt', 'getEntitiesForReceipts') as never,
    timed('answer', 'getEntitiesForAnswers') as never,
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
  ] as const)(
    'pages every row in name order (%s), unnamed rows last, nothing repeated or missed',
    async (sortOrder, sign) => {
      const { rows, totalCount } = await walk(makeResolver(), { first: 30, sortBy: 'name', sortOrder });

      expect(rows.map((row) => row.id)).toEqual(expectedOrder(sign).map((row) => row.id));
      expect(totalCount).toBe(DEFAULT_BROWSE.length);
    },
  );

  it('names a message by its subject, or by its preview when it has none, as the list shows it', async () => {
    const { rows } = await walk(makeResolver(), { first: 30, sortBy: 'name', sortOrder: 'asc' });
    const names = rows.map(nameOf);

    // "chat line 1" sorts among the C's, not ahead of "Event 000".
    expect(names.indexOf('chat line 1')).toBeLessThan(names.indexOf('Event 000'));
    expect(names.indexOf('Re: plan 0')).toBeGreaterThan(names.indexOf('Note 5'));
    // "chat line 3" also has a summary the row never shows; it does not move the message to the top.
    expect(names[0]).toBe('chat line 1');
    expect(names.slice(-3)).toEqual(['', '', '']);
  });

  it('names an answer by its question, as AnswerRow shows it', async () => {
    const { rows } = await walk(makeResolver(), { first: 30, sortBy: 'name', sortOrder: 'desc' });

    // Z to A starts at the W's; an answer read as unnamed would sit in the tail instead.
    expect(nameOf(rows[0]!)).toBe('What did you do 2?');
  });

  it('names a receipt by its merchant, as ReceiptRow shows it', async () => {
    const { rows } = await walk(makeResolver(), {
      first: 30,
      sortBy: 'name',
      sortOrder: 'asc',
      includeTypes: ['receipt'],
    } as Partial<SearchInput>);

    expect(rows.map(nameOf)).toEqual(['Amazon', 'Bakery Corner', 'Zebra Books']);
  });

  it('keeps its place when the cursor row is edited between pages', async () => {
    const resolver = makeResolver();
    const input = {
      first: 2,
      sortBy: 'name',
      sortOrder: 'asc',
      includeTypes: ['note'],
    } as unknown as SearchInput;

    const firstPage = await resolver.search(CONTEXT, input);
    const cursorRow = rowOf(firstPage.edges[1]!.node);
    const originalTime = cursorRow.time;

    try {
      // A note's updated_at moves when it is edited, and with it the time half of its cursor.
      cursorRow.time = new Date(originalTime.getTime() + 60_000);

      const secondPage = await resolver.search(CONTEXT, {
        ...input,
        after: firstPage.pageInfo.endCursor,
      } as SearchInput);

      expect(secondPage.edges.map((edge) => rowOf(edge.node).fields.title)).toEqual(['Note 2', 'Note 3']);
    } finally {
      cursorRow.time = originalTime;
    }
  });
});
