import type { RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import type { SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

/**
 * Exercises the "how things happened" (event-type) narrowing across all three
 * search paths: the timed/recent path pushes the filter into the SQL query,
 * while the query and tags paths post-filter the resolved results. In every
 * case the filter only narrows events — other entity types pass through.
 */
describe('SearchResolver — event-type ("how") filter', () => {
  const context = { userId: 'user-1' } as RequestContext;

  function makeResolver(overrides: {
    searchResults?: { id: string; type: string }[];
    tagResults?: { id: string; type: string }[];
    resolved?: Map<string, unknown>;
  }) {
    const eventService = {
      getEntitiesForEvents: jest.fn().mockResolvedValue([]),
    };
    const browserActivityService = {
      getEntitiesForBrowserActivities: jest.fn().mockResolvedValue([]),
    };
    const communicationService = {
      getEntitiesForCommunications: jest.fn().mockResolvedValue([]),
    };
    const searchService = {
      search: jest.fn().mockResolvedValue(overrides.searchResults ?? []),
    };
    const tagService = {
      getEntitiesForTags: jest.fn().mockResolvedValue(overrides.tagResults ?? []),
    };
    const entityResolutionService = {
      resolve: jest.fn().mockResolvedValue(overrides.resolved ?? new Map()),
    };
    const savedSearchService = {
      findByShareToken: jest.fn().mockResolvedValue(null),
    };

    const resolver = new SearchResolver(
      browserActivityService as never,
      communicationService as never,
      entityResolutionService as never,
      eventService as never,
      savedSearchService as never,
      searchService as never,
      tagService as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    return { resolver, eventService, searchService, tagService };
  }

  /** Map of resolved entities: two events (visited, called) and one person. */
  function mixedResolved() {
    return new Map<string, unknown>([
      [
        'event:ev-visited',
        { type: 'event', id: 'ev-visited', entity: { id: 'ev-visited', eventType: 'visited' } },
      ],
      [
        'event:ev-called',
        { type: 'event', id: 'ev-called', entity: { id: 'ev-called', eventType: 'called' } },
      ],
      ['person:p1', { type: 'person', id: 'p1', entity: { id: 'p1', name: 'Bob' } }],
    ]);
  }

  const decodedTypesAndIds = (connection: { edges: { node: { id: string } }[] }) =>
    connection.edges.map((edge) => GlobalUID.decode(edge.node.id));

  it('pushes eventTypes into the SQL query on the timed/recent path', async () => {
    const { resolver, eventService } = makeResolver({});

    await resolver.search(context, {
      query: '',
      includeTypes: ['event'],
      eventTypes: ['visited'],
    } as SearchInput);

    expect(eventService.getEntitiesForEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventTypes: ['visited'] }),
    );
  });

  it('post-filters events by type on the query path, leaving non-events untouched', async () => {
    const { resolver } = makeResolver({
      searchResults: [
        { id: 'ev-visited', type: 'event' },
        { id: 'ev-called', type: 'event' },
        { id: 'p1', type: 'person' },
      ],
      resolved: mixedResolved(),
    });

    const result = await resolver.search(context, {
      query: 'coffee',
      eventTypes: ['visited'],
    } as SearchInput);

    const decoded = decodedTypesAndIds(result);
    expect(decoded).toContainEqual({ type: 'event', id: 'ev-visited' });
    expect(decoded).toContainEqual({ type: 'person', id: 'p1' });
    expect(decoded).not.toContainEqual({ type: 'event', id: 'ev-called' });
  });

  it('post-filters events by type on the tags path', async () => {
    const { resolver } = makeResolver({
      tagResults: [
        { id: 'ev-visited', type: 'event' },
        { id: 'ev-called', type: 'event' },
        { id: 'p1', type: 'person' },
      ],
      resolved: mixedResolved(),
    });

    const result = await resolver.search(context, {
      tags: ['trip'],
      eventTypes: ['visited'],
    } as SearchInput);

    const decoded = decodedTypesAndIds(result);
    expect(decoded).toContainEqual({ type: 'event', id: 'ev-visited' });
    expect(decoded).toContainEqual({ type: 'person', id: 'p1' });
    expect(decoded).not.toContainEqual({ type: 'event', id: 'ev-called' });
  });

  it('does not narrow events when eventTypes is omitted', async () => {
    const { resolver } = makeResolver({
      searchResults: [
        { id: 'ev-visited', type: 'event' },
        { id: 'ev-called', type: 'event' },
      ],
      resolved: mixedResolved(),
    });

    const result = await resolver.search(context, { query: 'coffee' } as SearchInput);

    const decoded = decodedTypesAndIds(result);
    expect(decoded).toContainEqual({ type: 'event', id: 'ev-visited' });
    expect(decoded).toContainEqual({ type: 'event', id: 'ev-called' });
  });
});
