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
  const conceptService = { getEntitiesForConcepts: jest.fn().mockResolvedValue([] as Identifier[]) };
  const contentService = { getEntitiesForContents: jest.fn().mockResolvedValue([] as Identifier[]) };
  const itemService = { getEntitiesForItems: jest.fn().mockResolvedValue([] as Identifier[]) };
  const noteService = { getEntitiesForNotes: jest.fn().mockResolvedValue([] as Identifier[]) };
  const personService = { getEntitiesForPeople: jest.fn().mockResolvedValue([] as Identifier[]) };
  const placeService = { getEntitiesForPlaces: jest.fn().mockResolvedValue([] as Identifier[]) };
  const answerService = { getEntitiesForAnswers: jest.fn().mockResolvedValue([] as Identifier[]) };
  const entityResolutionService = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const savedSearchService = { findByShareToken: jest.fn().mockResolvedValue(null) };

  const fileService = { getEntitiesForFiles: jest.fn().mockResolvedValue([]) };
  const fileChunkService = { getEntitiesForFileChunks: jest.fn().mockResolvedValue([]) };
  const productModelService = { getEntitiesForProducts: jest.fn().mockResolvedValue([] as Identifier[]) };
  const receiptService = { getEntitiesForReceipts: jest.fn().mockResolvedValue([] as Identifier[]) };
  const resolver = new SearchResolver(
    browserActivityService as never,
    communicationService as never,
    conceptService as never,
    contentService as never,
    entityResolutionService as never,
    eventService as never,
    fileService as never,
    fileChunkService as never,
    itemService as never,
    noteService as never,
    personService as never,
    placeService as never,
    productModelService as never,
    receiptService as never,
    answerService as never,
    savedSearchService as never,
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
