import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { type SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

const ctx = { userId: 'user-1' } as unknown as RequestContext;

type Identifier = { type: string; id: string };

function makeResolver() {
  const searchService = { search: jest.fn().mockResolvedValue([] as Identifier[]) };
  const tagService = {
    getEntitiesForTags: jest.fn().mockResolvedValue([] as Identifier[]),
    searchByLabel: jest.fn().mockResolvedValue([]),
  };
  const eventService = { getEntitiesForEvents: jest.fn().mockResolvedValue([] as Identifier[]) };
  const browserActivityService = {
    getEntitiesForBrowserActivities: jest.fn().mockResolvedValue([] as Identifier[]),
  };
  const communicationService = {
    getEntitiesForCommunications: jest.fn().mockResolvedValue([] as Identifier[]),
  };
  const entityResolutionService = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const savedSearchService = { findByShareToken: jest.fn().mockResolvedValue(null) };

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

  return { resolver, tagService, savedSearchService };
}

describe('SearchResolver.search — matchingTags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns tags whose label matches the query alongside the entity results', async () => {
    const { resolver, tagService } = makeResolver();
    tagService.searchByLabel.mockResolvedValue([
      { id: 'tag-1', label: 'culinary', description: null },
      { id: 'tag-2', label: 'cult classics', description: 'movies' },
    ]);

    const result = await resolver.search(ctx, { query: 'cul' } as SearchInput);

    expect(tagService.searchByLabel).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'cul',
    );
    expect(result.matchingTags).toEqual([
      expect.objectContaining({ id: GlobalUID.encode('tag', 'tag-1'), label: 'culinary' }),
      expect.objectContaining({ id: GlobalUID.encode('tag', 'tag-2'), label: 'cult classics' }),
    ]);
  });

  it('skips the tag lookup when there is no query', async () => {
    const { resolver, tagService } = makeResolver();

    const result = await resolver.search(ctx, { tags: ['t'] } as SearchInput);

    expect(tagService.searchByLabel).not.toHaveBeenCalled();
    expect(result.matchingTags).toEqual([]);
  });

  it('never exposes the owner tag vocabulary on the shared-search path', async () => {
    const { resolver, tagService, savedSearchService } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({
      userId: 'owner-1',
      query: 'cul',
      entityTypes: null,
      tags: null,
      filters: {},
    });

    const result = await resolver.search(ctx, { shareToken: 'token' } as SearchInput);

    expect(tagService.searchByLabel).not.toHaveBeenCalled();
    expect(result.matchingTags).toEqual([]);
  });
});
