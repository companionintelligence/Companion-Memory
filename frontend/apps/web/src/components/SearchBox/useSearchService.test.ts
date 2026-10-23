import { useQuery } from '@apollo/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearchService } from './useSearchService';

const mocks = vi.hoisted(() => ({
  /** What the connection chip says about the appliance. */
  mode: 'connected' as 'connected' | 'local' | 'cached' | 'fresh',
  /** The bound PowerSync database, or null before one is bound. */
  database: {} as object | null,
  searchLocal: vi.fn(),
}));

// Mock Apollo's useQuery so we can assert the variables/skip the service derives
// and feed canned edges back — no need to reproduce the large SEARCH_QUERY doc.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  useConnectionMode: () => ({ mode: mocks.mode, isResolved: true, contractNotice: null, refresh: vi.fn() }),
  useOptionalConnectionMode: () => ({
    mode: mocks.mode,
    isResolved: true,
    contractNotice: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => mocks.database,
}));

vi.mock('@/api/powersync/localSearch', () => ({
  searchLocal: mocks.searchLocal,
}));

const mockedUseQuery = vi.mocked(useQuery);

function setResult(edges: Array<{ node: unknown }> = [], matchingTags: unknown[] = []) {
  mockedUseQuery.mockReturnValue({
    data: { search: { edges, matchingTags } },
    loading: false,
    error: undefined,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as { variables: Record<string, unknown>; skip: boolean };
}

beforeEach(() => {
  setResult();
  mocks.mode = 'connected';
  mocks.database = {};
  mocks.searchLocal.mockReset().mockResolvedValue({ nodes: [], tags: [] });
});
afterEach(() => mockedUseQuery.mockReset());

describe('useSearchService', () => {
  it('defaults to excluding answers and browser-activity (lowercased)', () => {
    renderHook(() => useSearchService({ searchQuery: 'coffee' }));

    const { variables, skip } = lastOptions();
    expect(variables.query).toBe('coffee');
    expect(variables.excludeTypes).toEqual(['answer', 'browser-activity']);
    expect(variables.includeTypes).toBeUndefined();
    expect(skip).toBe(false);
  });

  it('lets includeTypes take precedence and lowercases them', () => {
    renderHook(() => useSearchService({ searchQuery: 'coffee', includeTypes: ['Person', 'Event'] }));

    const { variables } = lastOptions();
    expect(variables.includeTypes).toEqual(['person', 'event']);
    expect(variables.excludeTypes).toBeUndefined();
  });

  it('honours an explicit excludeTypes override', () => {
    renderHook(() => useSearchService({ searchQuery: 'coffee', excludeTypes: ['Note'] }));

    expect(lastOptions().variables.excludeTypes).toEqual(['note']);
  });

  it('trims the query and skips the request when it is empty', () => {
    renderHook(() => useSearchService({ searchQuery: '   ' }));

    expect(lastOptions().skip).toBe(true);
  });

  it('maps result edges to their nodes', () => {
    setResult([{ node: { id: '1' } }, { node: { id: '2' } }]);

    const { result } = renderHook(() => useSearchService({ searchQuery: 'coffee' }));

    expect(result.current.data).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('returns an empty list when there is no data', () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: true,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useSearchService({ searchQuery: 'coffee' }));

    expect(result.current.data).toEqual([]);
    expect(result.current.tags).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('surfaces the matching tags alongside the entity results', () => {
    setResult([{ node: { id: '1' } }], [{ id: 't1', label: 'culinary' }]);

    const { result } = renderHook(() => useSearchService({ searchQuery: 'cul' }));

    expect(result.current.tags).toEqual([{ id: 't1', label: 'culinary' }]);
  });
});

describe('useSearchService — answering from this device', () => {
  const deviceNode = { __typename: 'NoteType', id: 'bm90ZTox', title: 'Packing list' };

  it('with the appliance reachable, the appliance answers and no local search runs', () => {
    setResult([{ node: { __typename: 'NoteType', id: 'x' } }]);

    const { result } = renderHook(() => useSearchService({ searchQuery: 'packing' }));

    expect(result.current.source).toBe('appliance');
    expect(result.current.data).toHaveLength(1);
    expect(mocks.searchLocal).not.toHaveBeenCalled();
  });

  it('with the appliance unreachable, sends no request and answers from the synced index', async () => {
    mocks.mode = 'cached';
    mocks.searchLocal.mockResolvedValue({ nodes: [deviceNode], tags: [{ id: 't1', label: 'packing' }] });

    const { result } = renderHook(() => useSearchService({ searchQuery: 'packing', excludeTypes: ['Note'] }));

    expect(lastOptions().skip).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.source).toBe('device');
    expect(result.current.data).toEqual([deviceNode]);
    expect(result.current.tags).toEqual([{ id: 't1', label: 'packing' }]);
    expect(result.current.error).toBeUndefined();
    expect(mocks.searchLocal).toHaveBeenCalledWith(mocks.database, {
      query: 'packing',
      includeTypes: undefined,
      excludeTypes: ['note'],
    });
  });

  it('a request that failed on the network also falls back; a GraphQL error does not', async () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: { networkError: new TypeError('Failed to fetch') },
    } as unknown as ReturnType<typeof useQuery>);
    mocks.searchLocal.mockResolvedValue({ nodes: [deviceNode], tags: [] });

    const { result } = renderHook(() => useSearchService({ searchQuery: 'packing' }));

    await waitFor(() => expect(result.current.source).toBe('device'));
    expect(result.current.data).toEqual([deviceNode]);

    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: { graphQLErrors: [{ message: 'nope' }], networkError: null },
    } as unknown as ReturnType<typeof useQuery>);
    mocks.searchLocal.mockClear();

    const { result: withGraphQLError } = renderHook(() => useSearchService({ searchQuery: 'packing' }));

    expect(withGraphQLError.current.source).toBe('appliance');
    expect(withGraphQLError.current.error).toBeDefined();
    expect(mocks.searchLocal).not.toHaveBeenCalled();
  });

  it('results for an earlier query are not shown against a new one', async () => {
    mocks.mode = 'fresh';
    mocks.searchLocal.mockResolvedValue({ nodes: [deviceNode], tags: [] });

    const { result, rerender } = renderHook(({ q }) => useSearchService({ searchQuery: q }), {
      initialProps: { q: 'packing' },
    });

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    mocks.searchLocal.mockResolvedValue({ nodes: [], tags: [] });
    rerender({ q: 'passport' });

    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('with no replica bound yet, answers empty rather than throwing', async () => {
    mocks.mode = 'fresh';
    mocks.database = null;

    const { result } = renderHook(() => useSearchService({ searchQuery: 'packing' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(mocks.searchLocal).not.toHaveBeenCalled();
  });
});
