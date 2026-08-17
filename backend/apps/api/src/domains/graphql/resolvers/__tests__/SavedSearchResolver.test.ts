import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { SavedSearchResolver } from '../SavedSearchResolver';

/**
 * Resolver-layer tests for the two new sharing paths:
 *  - sharedSavedSearch(token): viewer path, NOT owner-scoped, and must NOT echo
 *    the capability token back.
 *  - setSavedSearchSharing(input): owner-scoped mutation whose payload contract is
 *    {success:true, savedSearch} on hit and {success:false} on miss, and which
 *    must pass the *parsed* uuid (not the GlobalUID) to the service.
 */

const ownerCtx = { userId: 'owner-1' } as unknown as RequestContext;

const RAW_ID = '00000000-0000-0000-0000-000000000001';

const sampleEntity = {
  id: RAW_ID,
  name: 'My search',
  description: 'desc',
  query: 'q',
  entityTypes: ['note'] as never,
  tags: ['t'],
  userId: 'owner-1',
  isPublic: true,
  shareToken: 'secret-token',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeResolver() {
  const savedSearchService = {
    findByShareToken: jest.fn(),
    setSharing: jest.fn(),
    ensureDefaults: jest.fn().mockResolvedValue(false),
    findAll: jest.fn().mockResolvedValue([]),
  };

  // Shared search enabled: these tests exercise sharedSavedSearch, so the gate
  // must be open for the token to resolve to a definition.
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

  return {
    resolver: new SavedSearchResolver(savedSearchService as never, featureService as never),
    savedSearchService,
    featureService,
  };
}

describe('SavedSearchResolver.sharedSavedSearch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves the definition by raw token and never echoes the capability token', async () => {
    const { resolver, savedSearchService } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue(sampleEntity);

    const result = await resolver.sharedSavedSearch('tok');

    expect(savedSearchService.findByShareToken).toHaveBeenCalledWith('tok');
    expect(result?.name).toBe('My search');
    expect(result?.shareToken).toBeNull();
  });

  it('returns null for an unknown/revoked token', async () => {
    const { resolver, savedSearchService } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue(null);

    expect(await resolver.sharedSavedSearch('bad')).toBeNull();
  });

  it('returns null without resolving the token when the shared.search flag is off', async () => {
    const { resolver, savedSearchService, featureService } = makeResolver();
    featureService.isFeatureEnabled.mockResolvedValue(false);
    savedSearchService.findByShareToken.mockResolvedValue(sampleEntity);

    expect(await resolver.sharedSavedSearch('tok')).toBeNull();
    expect(savedSearchService.findByShareToken).not.toHaveBeenCalled();
  });
});

describe('SavedSearchResolver.setSavedSearchSharing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the parsed uuid + flag to the owner-scoped service and returns the search', async () => {
    const { resolver, savedSearchService } = makeResolver();
    savedSearchService.setSharing.mockResolvedValue(sampleEntity);

    const gid = GlobalUID.encode('saved-search', RAW_ID);
    const result = await resolver.setSavedSearchSharing(ownerCtx, { id: gid, isPublic: true });

    expect(savedSearchService.setSharing).toHaveBeenCalledWith({ userId: 'owner-1' }, RAW_ID, true);
    expect(result.success).toBe(true);
    expect(result.savedSearch?.name).toBe('My search');
    // The owner path DOES return the token (unlike the viewer path above).
    expect(result.savedSearch?.shareToken).toBe('secret-token');
  });

  it('returns {success:false} when nothing matched (non-owner / not found)', async () => {
    const { resolver, savedSearchService } = makeResolver();
    savedSearchService.setSharing.mockResolvedValue(null);

    const gid = GlobalUID.encode('saved-search', RAW_ID);
    const result = await resolver.setSavedSearchSharing(ownerCtx, { id: gid, isPublic: false });

    expect(result.success).toBe(false);
    expect(result.savedSearch).toBeUndefined();
  });
});

describe('SavedSearchResolver.savedSearches', () => {
  beforeEach(() => jest.clearAllMocks());

  it('seeds defaults before listing so a first visit has the starter library', async () => {
    const { resolver, savedSearchService } = makeResolver();
    savedSearchService.findAll.mockResolvedValue([sampleEntity]);

    const result = await resolver.savedSearches(ownerCtx, { first: 50 });

    expect(savedSearchService.ensureDefaults).toHaveBeenCalledWith({ userId: 'owner-1' });
    expect(savedSearchService.findAll).toHaveBeenCalledWith({ userId: 'owner-1' });
    expect(result.totalCount).toBe(1);
    expect(result.edges[0]?.node.name).toBe('My search');
  });
});
