import type { RequestContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import type { SearchInput } from '../types/SearchInput';

import { SearchResolver } from './SearchResolver';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT = { userId: USER } as RequestContext;

/** Row stamps (updated_at, equal to the insert time on a fresh import): all inside one short window. */
const CONTENT_ROWS = [
  { id: '018f0000-0000-7000-8000-000000000003', updatedAt: new Date('2026-08-16T07:56:56.949Z') },
  { id: '018f0000-0000-7000-8000-000000000002', updatedAt: new Date('2026-08-16T07:56:55.500Z') },
  { id: '018f0000-0000-7000-8000-000000000001', updatedAt: new Date('2026-08-16T07:56:54.100Z') },
];

/** A real-world event moment, years older than the import window above. */
const EVENT_ROW = {
  id: '018e0000-0000-7000-8000-0000000000e1',
  startTime: new Date('2024-03-04T12:00:00.000Z'),
};

type TimedOptions = { afterTime?: Date; afterId?: string; limit?: number };

function makeResolver() {
  const contentCalls: TimedOptions[] = [];
  const eventCalls: TimedOptions[] = [];

  const contentService = {
    getEntitiesForContents: jest.fn(async (_context: unknown, options: TimedOptions) => {
      contentCalls.push(options);

      // Emulate the SQL keyset so page 2 returns the rows *past* the cursor.
      const rows = CONTENT_ROWS.filter((row) => {
        if (!options.afterTime || !options.afterId) {
          return true;
        }

        return (
          row.updatedAt < options.afterTime ||
          (row.updatedAt.getTime() === options.afterTime.getTime() && row.id < options.afterId)
        );
      });

      return rows.map((row) => ({ id: row.id, type: 'content' as IndexableEntity }));
    }),
    // Real COUNT(*) counterpart (see SearchResolver.countTimedEntities) — this
    // suite only exercises cursor/keyset behavior, so a fixed true count suffices.
    countEntitiesForContents: jest.fn(async () => CONTENT_ROWS.length),
  };

  const eventService = {
    getEntitiesForEvents: jest.fn(async (_context: unknown, options: TimedOptions) => {
      eventCalls.push(options);

      if (options.afterTime && EVENT_ROW.startTime >= options.afterTime) {
        return [];
      }

      return [{ id: EVENT_ROW.id, type: 'event' as IndexableEntity }];
    }),
    countEntitiesForEvents: jest.fn(async () => 1),
  };

  const entityResolutionService = {
    resolve: jest.fn(async (_context: unknown, identifiers: EntityIdentifier<IndexableEntity>[]) => {
      const map = new Map<string, unknown>();

      for (const identifier of identifiers) {
        if (identifier.type === 'content') {
          const row = CONTENT_ROWS.find((candidate) => candidate.id === identifier.id)!;

          map.set(`content:${identifier.id}`, {
            type: 'content',
            id: identifier.id,
            // Content carries only a row timestamp — and ContentType exposes no
            // time field at all, which is what used to force the epoch cursor.
            entity: { id: row.id, updatedAt: row.updatedAt, type: 'media', tags: [] },
          });
        }

        if (identifier.type === 'event') {
          map.set(`event:${identifier.id}`, {
            type: 'event',
            id: identifier.id,
            entity: { id: EVENT_ROW.id, startTime: EVENT_ROW.startTime, tags: [] },
          });
        }
      }

      return map;
    }),
  };

  const empty = async () => [];
  // Every timed-source service exposes both a `getEntitiesForX` (fetch) and a
  // `countEntitiesForX` (real COUNT(*) — see SearchResolver.countTimedEntities);
  // stub both so `search()` doesn't throw summing the total alongside the fetch.
  const stub = (method: string) => ({
    [method]: jest.fn(empty),
    [method.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
  });

  const resolver = new SearchResolver(
    stub('getEntitiesForBrowserActivities') as never,
    stub('getEntitiesForCommunications') as never,
    stub('getEntitiesForConcepts') as never,
    contentService as never,
    entityResolutionService as never,
    eventService as never,
    stub('getEntitiesForFiles') as never,
    stub('getEntitiesForFileChunks') as never,
    stub('getEntitiesForItems') as never,
    stub('getEntitiesForNotes') as never,
    stub('getEntitiesForPeople') as never,
    stub('getEntitiesForPlaces') as never,
    stub('getEntitiesForProducts') as never,
    stub('getEntitiesForReceipts') as never,
    stub('getEntitiesForAnswers') as never,
    {} as never,
    {
      // Authorizes with no ceiling: these suites are not about consent, and a
      // share created before `share_max_disclosure` existed reads exactly this way.
      authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
      recordRead: jest.fn().mockResolvedValue(undefined),
    } as never,
    { search: jest.fn(empty) } as never,
    { getEntitiesForTags: jest.fn(empty), searchByLabel: jest.fn(empty) } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { resolver, contentCalls, eventCalls };
}

function decodeCursor(cursor: string): { time: string; globalId: string } {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const separator = decoded.indexOf('::');

  return { time: decoded.slice(0, separator), globalId: decoded.slice(separator + 2) };
}

describe('SearchResolver cursor / sort-key coupling', () => {
  it('mints content cursors from the timestamp the sort used, not the epoch', async () => {
    const { resolver } = makeResolver();

    const page = await resolver.search(CONTEXT, { first: 2, includeTypes: ['content'] } as SearchInput);

    expect(page.edges).toHaveLength(2);

    for (const edge of page.edges) {
      const { time } = decodeCursor(edge.cursor);

      expect(time).not.toBe('1970-01-01T00:00:00.000Z');
    }

    // Newest-first, and each cursor carries that row's own updatedAt.
    expect(decodeCursor(page.edges[0].cursor)).toEqual({
      time: CONTENT_ROWS[0].updatedAt.toISOString(),
      globalId: GlobalUID.encode('content', CONTENT_ROWS[0].id),
    });
    expect(decodeCursor(page.edges[1].cursor).time).toBe(CONTENT_ROWS[1].updatedAt.toISOString());
  });

  it('threads the cursor into the updatedAt-ordered query so paging advances', async () => {
    const { resolver, contentCalls } = makeResolver();

    const first = await resolver.search(CONTEXT, { first: 2, includeTypes: ['content'] } as SearchInput);
    const second = await resolver.search(CONTEXT, {
      first: 2,
      includeTypes: ['content'],
      after: first.pageInfo.endCursor,
    } as SearchInput);

    // The second call must push the keyset down to SQL rather than re-fetching
    // the same top-N window and slicing it in memory.
    expect(contentCalls[1].afterTime).toEqual(CONTENT_ROWS[1].updatedAt);
    expect(contentCalls[1].afterId).toBe(CONTENT_ROWS[1].id);

    // ...and it must surface a row the first page did not already return.
    const firstIds = first.edges.map((edge) => edge.node.id);

    expect(second.edges).toHaveLength(1);
    expect(firstIds).not.toContain(second.edges[0].node.id);
    expect(second.edges[0].node.id).toBe(GlobalUID.encode('content', CONTENT_ROWS[2].id));
  });

  it('never windows sibling types to the epoch when the page ends on a content row', async () => {
    const { resolver, eventCalls } = makeResolver();

    const first = await resolver.search(CONTEXT, {
      first: 2,
      includeTypes: ['content', 'event'],
    } as SearchInput);

    // The page ends on a content row (import stamps sort above the event).
    expect(first.edges[first.edges.length - 1].node.__typename).toBe('ContentType');

    await resolver.search(CONTEXT, {
      first: 2,
      includeTypes: ['content', 'event'],
      after: first.pageInfo.endCursor,
    } as SearchInput);

    // An epoch afterTime here is what emptied the browse: it windowed every
    // sibling type to "before 1970".
    expect(eventCalls[1].afterTime).toEqual(CONTENT_ROWS[1].updatedAt);
    expect(eventCalls[1].afterTime!.getTime()).toBeGreaterThan(0);
  });

  it('still reaches events once the content block is paged through', async () => {
    const { resolver } = makeResolver();

    const seen: string[] = [];
    let after: string | null | undefined;

    for (let i = 0; i < 5; i++) {
      const page: Awaited<ReturnType<SearchResolver['search']>> = await resolver.search(CONTEXT, {
        first: 2,
        includeTypes: ['content', 'event'],
        ...(after ? { after } : {}),
      } as SearchInput);

      seen.push(...page.edges.map((edge) => edge.node.__typename));

      if (!page.pageInfo.hasNextPage) {
        break;
      }

      after = page.pageInfo.endCursor;
    }

    expect(seen.filter((name) => name === 'ContentType')).toHaveLength(CONTENT_ROWS.length);
    expect(seen).toContain('EventType');
  });
});
