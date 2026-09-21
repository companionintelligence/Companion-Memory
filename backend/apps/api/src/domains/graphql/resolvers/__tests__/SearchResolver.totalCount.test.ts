import type { RequestContext } from '@ci/common/context';

import type { SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

/**
 * `totalCount` on the 'timed' candidate source (no `query`, no `tags` — the path a
 * query-less "browse everything" saved search runs, including the one a public
 * Shared-Search link resolves to) used to be `Paginator.paginate(candidates).totalCount`,
 * i.e. the *length of the one over-fetched candidate window* (`first * FETCH_MULTIPLIER`
 * per wanted type) rather than how many results actually exist. That made the reported
 * total scale with the caller's page size and drift as a viewer paged through results —
 * confirmed live against a real import: first=10/30/100 returned totalCount 293/853/2813
 * (an ~28-29x multiple of `first`) against a true total in the hundreds of thousands.
 *
 * The fix sums a real per-type `COUNT(*)` (`countTimedEntities`, backed by each service's
 * new `countEntitiesForX`) scoped by the same filters as the fetch, but without its
 * pagination-only `limit`/`afterTime`/`afterId`. These tests pin that behavior: totalCount
 * must reflect the count query, not the fetched window, and must not vary with page size
 * or with which page is being viewed.
 */
describe('SearchResolver — timed-path totalCount', () => {
  const context = { userId: 'user-1' } as RequestContext;

  /** A real total far larger than any window this suite ever fetches. */
  const REAL_EVENT_TOTAL = 127_812;

  function makeResolver() {
    const eventCalls: Array<{ limit?: number; afterTime?: Date; afterId?: string }> = [];
    const countCalls: Array<{ limit?: number; afterTime?: Date; afterId?: string }> = [];

    const eventService = {
      // Mirrors the real over-fetch shape: bounded by `options.limit`, which itself
      // scales with the caller's requested page size (`first * FETCH_MULTIPLIER`).
      getEntitiesForEvents: jest.fn(
        async (_ctx: unknown, options: { limit?: number; afterTime?: Date; afterId?: string }) => {
          eventCalls.push(options);

          const limit = options.limit ?? 25;

          return Array.from({ length: limit }, (_unused, index) => ({
            type: 'event' as const,
            id: `ev-${index}`,
          }));
        },
      ),
      // The real COUNT(*) counterpart under test — independent of `limit`/keyset.
      countEntitiesForEvents: jest.fn(
        async (_ctx: unknown, options: { limit?: number; afterTime?: Date; afterId?: string }) => {
          countCalls.push(options);

          return REAL_EVENT_TOTAL;
        },
      ),
    };

    const empty = async () => [];
    const stub = (method: string) => ({
      [method]: jest.fn(empty),
      [method.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
    });

    const entityResolutionService = {
      resolve: jest.fn(async (_ctx: unknown, identifiers: Array<{ type: string; id: string }>) => {
        const map = new Map<string, unknown>();

        for (const identifier of identifiers) {
          map.set(`${identifier.type}:${identifier.id}`, {
            type: 'event',
            id: identifier.id,
            entity: { id: identifier.id, tags: [] },
          });
        }

        return map;
      }),
    };

    const resolver = new SearchResolver(
      stub('getEntitiesForBrowserActivities') as never,
      stub('getEntitiesForCommunications') as never,
      stub('getEntitiesForConcepts') as never,
      { ...stub('getEntitiesForContents'), findEventIdsForMedia: jest.fn(async () => []) } as never,
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
      { findByShareToken: jest.fn().mockResolvedValue(null) } as never,
      {
        // Authorizes with no ceiling: these suites are not about consent, and a
        // share created before `share_max_disclosure` existed reads exactly this way.
        authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
        recordRead: jest.fn().mockResolvedValue(undefined),
      } as never,
      { search: jest.fn().mockResolvedValue([]) } as never,
      {
        getEntitiesForTags: jest.fn().mockResolvedValue([]),
        searchByLabel: jest.fn().mockResolvedValue([]),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    return { resolver, eventService, eventCalls, countCalls };
  }

  it('reports the real COUNT(*), not the length of the fetched candidate window', async () => {
    const { resolver } = makeResolver();

    // Small page: the fetched window (limit = first * FETCH_MULTIPLIER) is nowhere
    // near the real total, so a correct totalCount can only come from the count query.
    const page = await resolver.search(context, { first: 5 } as SearchInput);

    expect(page.edges).toHaveLength(5);
    expect(page.totalCount).toBe(REAL_EVENT_TOTAL);
    expect(page.totalCount).not.toBe(page.edges.length);
  });

  it('does not scale with the requested page size', async () => {
    const { resolver } = makeResolver();

    const small = await resolver.search(context, { first: 10 } as SearchInput);
    const large = await resolver.search(context, { first: 100 } as SearchInput);

    // The old bug: totalCount was the candidate window's length, so asking for a
    // bigger page inflated the reported total (the live repro: 293 at first=10 vs
    // 2813 at first=100 — an ~10x jump for a 10x page size, not a coincidence).
    expect(small.edges).toHaveLength(10);
    expect(large.edges).toHaveLength(100);
    expect(small.totalCount).toBe(REAL_EVENT_TOTAL);
    expect(large.totalCount).toBe(REAL_EVENT_TOTAL);
    expect(small.totalCount).toBe(large.totalCount);
  });

  it('stays stable across pages instead of drifting as the viewer paginates', async () => {
    const { resolver } = makeResolver();

    const first = await resolver.search(context, { first: 5 } as SearchInput);
    const second = await resolver.search(context, {
      first: 5,
      after: first.pageInfo.endCursor,
    } as SearchInput);

    expect(first.totalCount).toBe(REAL_EVENT_TOTAL);
    expect(second.totalCount).toBe(REAL_EVENT_TOTAL);
  });

  it('scopes the count query by the same filters as the fetch, but never by its pagination window', async () => {
    const { resolver, countCalls } = makeResolver();

    const first = await resolver.search(context, { first: 5 } as SearchInput);

    await resolver.search(context, { first: 5, after: first.pageInfo.endCursor } as SearchInput);

    expect(countCalls).toHaveLength(2);

    for (const call of countCalls) {
      expect(call.limit).toBeUndefined();
      expect(call.afterTime).toBeUndefined();
      expect(call.afterId).toBeUndefined();
    }
  });
});
