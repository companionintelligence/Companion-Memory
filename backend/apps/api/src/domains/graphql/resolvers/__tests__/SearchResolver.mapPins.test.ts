import type { RequestContext } from '@ci/common/context';

import type { SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

/**
 * `mapPins` is the map's read path: the whole located set for the current
 * filters in one bounded query, rather than the explorer's 30-row page (which
 * meant ~350 "Load more pins" presses to plot ten thousand located events).
 *
 * These tests pin the contract the view depends on: located-only and
 * events-only, the same filter dimensions the explorer applies (including a
 * free-text query and tags, which arrive as an intersected id set), a real
 * total so truncation can be reported, and no crossing with the shared-search
 * path.
 */
describe('SearchResolver — mapPins', () => {
  const context = { userId: 'user-1' } as RequestContext;

  type PinFilters = {
    limit?: number;
    hasLocation?: boolean;
    ids?: string[];
    bbox?: number[];
    startTime?: Date;
    endTime?: Date;
    eventTypes?: string[];
    connectors?: string[];
    people?: string[];
    places?: string[];
  };

  function makeResolver({
    pinCount = 3,
    totalCount = 3,
    queryHits = [] as Array<{ type: string; id: string }>,
    tagHits = [] as Array<{ type: string; id: string }>,
  } = {}) {
    const pinCalls: PinFilters[] = [];
    const countCalls: PinFilters[] = [];

    const eventService = {
      findMapPins: jest.fn(async (_ctx: unknown, options: PinFilters) => {
        pinCalls.push(options);

        return Array.from({ length: pinCount }, (_unused, index) => ({
          id: `ev-${index}`,
          title: `Event ${index}`,
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: null,
          eventType: 'visited',
          locationName: 'San Francisco',
          latitude: 37.77 + index,
          longitude: -122.42,
        }));
      }),
      countEntitiesForEvents: jest.fn(async (_ctx: unknown, options: PinFilters) => {
        countCalls.push(options);

        return totalCount;
      }),
      getEntitiesForEvents: jest.fn(async () => []),
    };

    const empty = async () => [];
    const stub = (method: string) => ({
      [method]: jest.fn(empty),
      [method.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
    });

    const searchService = { search: jest.fn(async () => queryHits) };
    const tagService = {
      getEntitiesForTags: jest.fn(async () => tagHits),
      searchByLabel: jest.fn(async () => []),
    };

    const resolver = new SearchResolver(
      stub('getEntitiesForBrowserActivities') as never,
      stub('getEntitiesForCommunications') as never,
      stub('getEntitiesForConcepts') as never,
      { ...stub('getEntitiesForContents'), findEventIdsForMedia: jest.fn(async () => []) } as never,
      { resolve: jest.fn(async () => new Map()) } as never,
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
      searchService as never,
      tagService as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    return { resolver, eventService, searchService, tagService, pinCalls, countCalls };
  }

  it('returns every located pin in one read, with GlobalUID ids', async () => {
    const { resolver } = makeResolver({ pinCount: 3, totalCount: 3 });

    const result = await resolver.mapPins(context, { query: '' } as SearchInput);

    expect(result.pins).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.truncated).toBe(false);
    // GlobalUID-encoded, so a pin and an explorer row for the same event match.
    expect(result.pins[0].id).not.toBe('ev-0');
    expect(result.pins[0].latitude).toBe(37.77);
  });

  it('forces located-only regardless of input', async () => {
    const { resolver, pinCalls, countCalls } = makeResolver();

    await resolver.mapPins(context, { query: '', hasLocation: false } as SearchInput);

    expect(pinCalls[0].hasLocation).toBe(true);
    expect(countCalls[0].hasLocation).toBe(true);
  });

  it('reports truncation against the real total instead of drawing a partial world silently', async () => {
    const { resolver } = makeResolver({ pinCount: 100, totalCount: 12_431 });

    const result = await resolver.mapPins(context, { query: '' } as SearchInput, 100);

    expect(result.pins).toHaveLength(100);
    expect(result.totalCount).toBe(12_431);
    expect(result.truncated).toBe(true);
  });

  it('clamps the requested limit to the hard ceiling', async () => {
    const { resolver, pinCalls } = makeResolver({ pinCount: 0, totalCount: 0 });

    await resolver.mapPins(context, { query: '' } as SearchInput, 10_000_000);

    expect(pinCalls[0].limit).toBe(20_000);
  });

  it('passes the explorer filter dimensions straight through', async () => {
    const { resolver, pinCalls } = makeResolver();

    await resolver.mapPins(context, {
      query: '',
      bbox: [-122.5, 37.7, -122.3, 37.8],
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-06-01T00:00:00Z',
      eventTypes: ['visited'],
      connectors: ['gmail'],
      people: ['Ada'],
      places: ['Paris'],
    } as SearchInput);

    expect(pinCalls[0]).toMatchObject({
      bbox: [-122.5, 37.7, -122.3, 37.8],
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-06-01T00:00:00Z'),
      eventTypes: ['visited'],
      connectors: ['gmail'],
      people: ['Ada'],
      places: ['Paris'],
    });
  });

  it('drops a bbox that is not four finite numbers', async () => {
    const { resolver, pinCalls } = makeResolver();

    await resolver.mapPins(context, { query: '', bbox: [-122.5, Number.NaN, -122.3, 37.8] } as SearchInput);

    expect(pinCalls[0].bbox).toBeUndefined();
  });

  it('intersects a free-text query down to its matching event ids', async () => {
    const { resolver, pinCalls, searchService } = makeResolver({
      queryHits: [
        { type: 'event', id: 'ev-1' },
        { type: 'person', id: 'p-1' },
        { type: 'event', id: 'ev-2' },
      ],
    });

    await resolver.mapPins(context, { query: 'beach' } as SearchInput);

    expect(searchService.search).toHaveBeenCalled();
    // Non-event candidates drop out: the map plots events.
    expect(pinCalls[0].ids).toEqual(['ev-1', 'ev-2']);
  });

  it('intersects tags with the query rather than replacing it', async () => {
    const { resolver, pinCalls } = makeResolver({
      queryHits: [
        { type: 'event', id: 'ev-1' },
        { type: 'event', id: 'ev-2' },
      ],
      tagHits: [
        { type: 'event', id: 'ev-2' },
        { type: 'event', id: 'ev-3' },
      ],
    });

    await resolver.mapPins(context, { query: 'beach', tags: ['holiday'] } as SearchInput);

    expect(pinCalls[0].ids).toEqual(['ev-2']);
  });

  it('uses the tag set alone when there is no free-text query', async () => {
    const { resolver, pinCalls } = makeResolver({
      tagHits: [
        { type: 'event', id: 'ev-7' },
        { type: 'file', id: 'f-1' },
      ],
    });

    await resolver.mapPins(context, { query: '', tags: ['holiday'] } as SearchInput);

    expect(pinCalls[0].ids).toEqual(['ev-7']);
  });

  it('leaves ids unset when nothing narrows the candidate set', async () => {
    const { resolver, pinCalls } = makeResolver();

    await resolver.mapPins(context, { query: '' } as SearchInput);

    expect(pinCalls[0].ids).toBeUndefined();
  });

  it('is empty when the entity-type filter excludes events', async () => {
    const { resolver, eventService } = makeResolver();

    const excluded = await resolver.mapPins(context, {
      query: '',
      excludeTypes: ['event'],
    } as SearchInput);
    const narrowed = await resolver.mapPins(context, {
      query: '',
      includeTypes: ['person'],
    } as SearchInput);

    expect(excluded.pins).toEqual([]);
    expect(narrowed.pins).toEqual([]);
    expect(eventService.findMapPins).not.toHaveBeenCalled();
  });

  it('does not answer for a shared-search token — that path stays on `search`', async () => {
    const { resolver, eventService } = makeResolver();

    const result = await resolver.mapPins(context, { query: '', shareToken: 'tok' } as SearchInput);

    expect(result).toEqual({ pins: [], totalCount: 0, truncated: false });
    expect(eventService.findMapPins).not.toHaveBeenCalled();
  });
});
