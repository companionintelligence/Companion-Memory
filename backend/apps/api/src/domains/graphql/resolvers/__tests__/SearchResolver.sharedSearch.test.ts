import { type RequestContext } from '@ci/common/context';

import { type SearchInput } from '../../types/SearchInput';
import { type SearchResultConnection } from '../../types/SearchResultConnection';
import { SearchResolver } from '../SearchResolver';

/**
 * Tests the shared-search security boundary (SearchResolver.runSharedSearch):
 * a capability token must run the OWNER's saved search, surface ONLY what the
 * owner stored (viewer-supplied filters ignored), and never run for an
 * unknown/revoked/ownerless token. We spy the private executeSearch — the seam
 * that actually receives the rewritten (context, input) — mirroring how the
 * sibling SearchResolver.test.ts spies the private toSearchResult.
 */

const viewerCtx = { userId: 'viewer-1' } as unknown as RequestContext;

const EMPTY_CONNECTION: SearchResultConnection = {
  edges: [],
  pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  totalCount: 0,
  matchingTags: [],
};

function makeResolver() {
  const savedSearchService = { findByShareToken: jest.fn().mockResolvedValue(null) };

  // Shared search enabled: these tests exercise the runSharedSearch boundary, so
  // the 'shared.search' gate must be open for the token path to run at all.
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

  const resolver = new SearchResolver(
    {} as never, // browserActivityService
    {} as never, // communicationService
    {} as never, // entityResolutionService
    {} as never, // eventService
    {} as never, // fileService
    {} as never, // fileChunkService
    savedSearchService as never,
    {} as never, // searchService
    {} as never, // tagService
    featureService as never,
  );

  const execSpy = jest
    .spyOn(
      resolver as unknown as {
        executeSearch: (c: { userId: string }, i: SearchInput) => Promise<SearchResultConnection>;
      },
      'executeSearch',
    )
    .mockResolvedValue(EMPTY_CONNECTION);

  return { resolver, savedSearchService, execSpy, featureService };
}

describe('SearchResolver — shared search (runSharedSearch)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the owner saved search and ignores every viewer-supplied filter', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({
      userId: 'owner-9',
      query: 'owner q',
      entityTypes: ['note'],
      tags: ['t1'],
    });

    await resolver.search(viewerCtx, {
      shareToken: 'tok',
      // Everything below is an attacker trying to widen the result set; all of it
      // must be dropped in favour of the owner's stored definition.
      query: 'ATTACKER',
      includeTypes: ['content'],
      excludeTypes: ['person'],
      tags: ['evil'],
      startTime: '2020-01-01',
      endTime: '2021-01-01',
      connectors: ['x'],
      people: ['p'],
      places: ['q'],
      hasLocation: true,
      semantic: true,
      // Pagination/sort are the only viewer inputs that legitimately pass through.
      first: 5,
      after: 'cur',
      sortBy: 'time',
      sortOrder: 'asc',
    } as SearchInput);

    expect(savedSearchService.findByShareToken).toHaveBeenCalledWith('tok');
    expect(execSpy).toHaveBeenCalledTimes(1);

    const [serviceContext, input] = execSpy.mock.calls[0];

    // Runs as the OWNER, never the viewer.
    expect(serviceContext).toEqual({ userId: 'owner-9' });

    // Only the stored definition + pagination/sort survive — nothing else.
    expect(input).toEqual({
      query: 'owner q',
      includeTypes: ['note'],
      tags: ['t1'],
      first: 5,
      after: 'cur',
      sortBy: 'time',
      sortOrder: 'asc',
    });

    // Spell out the filter-injection guarantees the equality above already implies.
    expect(input.query).not.toBe('ATTACKER');
    expect(input.includeTypes).toEqual(['note']);
    expect(input.excludeTypes).toBeUndefined();
    expect(input.startTime).toBeUndefined();
    expect(input.endTime).toBeUndefined();
    expect(input.connectors).toBeUndefined();
    expect(input.people).toBeUndefined();
    expect(input.places).toBeUndefined();
    expect(input.hasLocation).toBeUndefined();
    expect(input.semantic).toBeUndefined();
  });

  it('applies the owner stored secondary filters (who/where/when/how/sort/semantic)', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({
      userId: 'owner-9',
      query: 'q',
      entityTypes: ['event'],
      tags: [],
      filters: {
        eventTypes: ['visited'],
        startTime: '2024-01-01',
        endTime: '2024-12-31',
        connectors: ['gmail'],
        people: ['alice'],
        places: ['paris'],
        hasLocation: true,
        semantic: true,
        sortBy: 'time',
        sortOrder: 'desc',
      },
    });

    await resolver.search(viewerCtx, { shareToken: 'tok', first: 10 } as SearchInput);

    const [serviceContext, input] = execSpy.mock.calls[0];
    expect(serviceContext).toEqual({ userId: 'owner-9' });
    expect(input.eventTypes).toEqual(['visited']);
    expect(input.startTime).toBe('2024-01-01');
    expect(input.endTime).toBe('2024-12-31');
    expect(input.connectors).toEqual(['gmail']);
    expect(input.people).toEqual(['alice']);
    expect(input.places).toEqual(['paris']);
    expect(input.hasLocation).toBe(true);
    expect(input.semantic).toBe(true);
    // Viewer didn't choose a sort, so the owner's saved sort applies.
    expect(input.sortBy).toBe('time');
    expect(input.sortOrder).toBe('desc');
  });

  it('lets a viewer override only sort over the saved sort, never the filters', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({
      userId: 'owner-9',
      query: 'q',
      entityTypes: null,
      tags: null,
      filters: { eventTypes: ['visited'], sortBy: 'time', sortOrder: 'desc' },
    });

    await resolver.search(viewerCtx, {
      shareToken: 'tok',
      sortBy: 'name',
      sortOrder: 'asc',
      eventTypes: ['ATTACKER'],
    } as SearchInput);

    const [, input] = execSpy.mock.calls[0];
    expect(input.sortBy).toBe('name'); // viewer override wins for sort
    expect(input.sortOrder).toBe('asc');
    expect(input.eventTypes).toEqual(['visited']); // but NOT for filters
  });

  it('handles a shared search with no stored filters (filters column null)', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({
      userId: 'owner-9',
      query: 'q',
      entityTypes: ['note'],
      tags: ['t'],
      filters: null,
    });

    await resolver.search(viewerCtx, { shareToken: 'tok' } as SearchInput);

    const [, input] = execSpy.mock.calls[0];
    expect(input.eventTypes).toBeUndefined();
    expect(input.startTime).toBeUndefined();
    expect(input.includeTypes).toEqual(['note']);
  });

  it('returns an empty connection without searching for an unknown/revoked token', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue(null);

    const result = await resolver.search(viewerCtx, { shareToken: 'revoked' } as SearchInput);

    expect(result.edges).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns empty for a shared search whose owner is missing (cannot run as nobody)', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();
    savedSearchService.findByShareToken.mockResolvedValue({ userId: null, query: 'q' });

    const result = await resolver.search(viewerCtx, { shareToken: 'tok' } as SearchInput);

    expect(result.edges).toEqual([]);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns empty without touching the saved search when the shared.search flag is off', async () => {
    const { resolver, savedSearchService, execSpy, featureService } = makeResolver();
    featureService.isFeatureEnabled.mockResolvedValue(false);

    const result = await resolver.search(viewerCtx, { shareToken: 'tok' } as SearchInput);

    expect(result.edges).toEqual([]);
    expect(result.totalCount).toBe(0);
    // The gate short-circuits before the token is ever resolved or the search run.
    expect(savedSearchService.findByShareToken).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('treats an empty share token as a normal viewer-scoped search, not a shared one', async () => {
    const { resolver, savedSearchService, execSpy } = makeResolver();

    await resolver.search(viewerCtx, { shareToken: '', query: 'real' } as SearchInput);

    expect(savedSearchService.findByShareToken).not.toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalledTimes(1);
    const [serviceContext] = execSpy.mock.calls[0];
    expect(serviceContext).toEqual({ userId: 'viewer-1' });
  });
});
