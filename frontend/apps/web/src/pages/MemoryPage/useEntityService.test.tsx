import type { ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EntityServiceProvider, resolveLiveEntity, useEntityService } from './useEntityService';

// Same technique as useSearchService.test.ts: mock Apollo's useQuery directly
// so the variables/fetchMore contract can be asserted without reproducing the
// large SEARCH_QUERY document.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);
const fetchMore = vi.fn();
const refetch = vi.fn();

function edge(id: string, cursor = id) {
  return { cursor, node: { __typename: 'EventType', id } };
}

/**
 * An edge whose node carries a title, standing in for what Apollo hands back
 * after a mutation renormalises the same `EventType:<id>`: a brand new node
 * object with the new field values.
 */
function titledEdge(id: string, title: string) {
  return { cursor: id, node: { __typename: 'EventType', id, title } };
}

function searchResult(edges: Array<ReturnType<typeof titledEdge>>) {
  return {
    data: {
      search: {
        totalCount: edges.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges,
      },
    },
  };
}

function setResult(
  overrides: Partial<{
    data: unknown;
    loading: boolean;
    error: unknown;
  }> = {},
) {
  mockedUseQuery.mockReturnValue({
    data: { search: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } },
    loading: false,
    error: undefined,
    fetchMore,
    refetch,
    ...overrides,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as { variables: Record<string, unknown> };
}

interface ServiceParams {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  tags?: string[];
  bbox?: number[];
}

function renderService(params: ServiceParams) {
  // useEntityService here is the context-reading export (createHookContext's
  // useHookContext); the underlying data-fetching hook only runs inside its
  // Provider, matching how every real caller uses it.
  return renderHook(() => useEntityService(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EntityServiceProvider args={[params]}>{children}</EntityServiceProvider>
    ),
  });
}

beforeEach(() => {
  fetchMore.mockReset();
  refetch.mockReset();
  setResult();
});

describe('useEntityService', () => {
  it('reports the server totalCount as-is, not the fetched page size', () => {
    // The exact shape of today's backend totalCount bug: a page of 30 edges
    // with a totalCount in the hundreds. If this hook ever derived totalCount
    // from data.length instead of passing the server value through, this
    // would silently start reporting 30.
    setResult({
      data: {
        search: {
          totalCount: 853,
          pageInfo: { hasNextPage: true, endCursor: 'c29' },
          edges: Array.from({ length: 30 }, (_, i) => edge(`e${i}`, `c${i}`)),
        },
      },
    });

    const { result } = renderService({ searchQuery: '' });
    const [state] = result.current;

    expect(state.totalCount).toBe(853);
    expect(state.data).toHaveLength(30);
    expect(state.totalCount).not.toBe(state.data.length);
    expect(state.hasNextPage).toBe(true);
  });

  it('reports zero results and no next page when there is no data yet', () => {
    setResult({ data: undefined, loading: true });

    const { result } = renderService({ searchQuery: '' });
    const [state] = result.current;

    expect(state.data).toEqual([]);
    expect(state.totalCount).toBe(0);
    expect(state.hasNextPage).toBe(false);
    expect(state.loading).toBe(true);
  });

  it('maps display entity type names through ENTITY_TYPE_MAP for includeTypes/excludeTypes', () => {
    renderService({ searchQuery: 'x', includeTypes: ['Browser', 'Thing'], excludeTypes: ['Person'] });

    const { variables } = lastOptions();

    expect(variables.includeTypes).toEqual(['browser-activity', 'item']);
    expect(variables.excludeTypes).toEqual(['person']);
    expect(variables.query).toBe('x');
    expect(variables.first).toBe(30);
  });

  it('omits tags when none are selected and sends them when they are', () => {
    renderService({ searchQuery: '' });
    expect(lastOptions().variables.tags).toBeUndefined();

    renderService({ searchQuery: '', tags: ['travel', 'food'] });
    expect(lastOptions().variables.tags).toEqual(['travel', 'food']);
  });

  it('only sends bbox once all four coordinates are present', () => {
    renderService({ searchQuery: '', bbox: [1, 2, 3] });
    expect(lastOptions().variables.bbox).toBeUndefined();

    renderService({ searchQuery: '', bbox: [1, 2, 3, 4] });
    expect(lastOptions().variables.bbox).toEqual([1, 2, 3, 4]);
  });

  it('paginates by requesting the next cursor and appending, not replacing, results', async () => {
    const page1 = [edge('e1', 'c1')];

    setResult({
      data: {
        search: { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' }, edges: page1 },
      },
    });
    fetchMore.mockResolvedValue(undefined);

    const { result } = renderService({ searchQuery: '' });

    await act(async () => {
      result.current[0].loadMore();
      // Let fetchMore's returned promise (and its .finally) settle before
      // asserting, so React's state update for loadingMore isn't left dangling.
      await Promise.resolve();
    });

    expect(fetchMore).toHaveBeenCalledTimes(1);
    const call = fetchMore.mock.calls[0][0] as {
      variables: { after: string };
      updateQuery: (prev: unknown, opts: { fetchMoreResult: unknown }) => unknown;
    };

    expect(call.variables).toEqual({ after: 'c1' });

    // Exercise the merge function fetchMore was handed: page 2 repeats c1
    // (already-seen edge) and adds c2 — the repeat must be dropped, not
    // duplicated, and c1 must not be dropped from the accumulated list.
    const prev = { search: { edges: page1 } };
    const fetchMoreResult = {
      search: {
        totalCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [edge('e1', 'c1'), edge('e2', 'c2')],
      },
    };

    const merged = call.updateQuery(prev, { fetchMoreResult }) as {
      search: { edges: Array<{ cursor: string }> };
    };

    expect(merged.search.edges.map((e) => e.cursor)).toEqual(['c1', 'c2']);
  });

  describe('the entity backing the open detail drawer', () => {
    // Regression: the drawer used to render the node object captured at click
    // time. A save writes the new values into the Apollo cache, the list row
    // behind the drawer re-renders with them — and the drawer kept showing the
    // old ones, so a successful edit looked like it had been discarded.
    it('picks up field values written to the cache after a save', () => {
      setResult(searchResult([titledEdge('e1', 'Before')]));

      const { result, rerender } = renderService({ searchQuery: '' });
      const clicked = result.current[0].data[0];

      act(() => {
        result.current[1].setActiveEntity(clicked);
      });

      expect(result.current[0].activeEntity).toMatchObject({ id: 'e1', title: 'Before' });

      // What Apollo does after `updateEvent` resolves: same normalized entity,
      // new node object, new title.
      setResult(searchResult([titledEdge('e1', 'After')]));
      rerender();

      expect(result.current[0].activeEntity).toMatchObject({ id: 'e1', title: 'After' });
    });

    it('keeps showing the entity once it drops out of the result set', () => {
      setResult(searchResult([titledEdge('e1', 'Before')]));

      const { result, rerender } = renderService({ searchQuery: '' });

      act(() => {
        result.current[1].setActiveEntity(result.current[0].data[0]);
      });

      // The search re-ran with a narrower filter and no longer contains it —
      // the drawer is still open, so it must not blank out.
      setResult(searchResult([]));
      rerender();

      expect(result.current[0].activeEntity).toMatchObject({ id: 'e1', title: 'Before' });
    });

    it('closes when cleared', () => {
      setResult(searchResult([titledEdge('e1', 'Before')]));

      const { result } = renderService({ searchQuery: '' });

      act(() => {
        result.current[1].setActiveEntity(result.current[0].data[0]);
      });
      act(() => {
        result.current[1].setActiveEntity(null);
      });

      expect(result.current[0].activeEntity).toBeNull();
    });
  });

  describe('resolveLiveEntity', () => {
    it('matches on type as well as id, so two entities sharing an id never cross', () => {
      const selected = { __typename: 'PlaceType', id: 'shared', name: 'Before' } as never;
      const results = [
        { __typename: 'EventType', id: 'shared', title: 'Someone else' },
        { __typename: 'PlaceType', id: 'shared', name: 'After' },
      ] as never;

      expect(resolveLiveEntity(selected, results)).toMatchObject({
        __typename: 'PlaceType',
        name: 'After',
      });
    });

    it('leaves graph nodes alone — they are not in the Apollo cache', () => {
      const generic = {
        __typename: 'GenericEntity' as const,
        id: 'e1',
        name: 'From the graph',
      };

      expect(resolveLiveEntity(generic, [{ __typename: 'EventType', id: 'e1' } as never])).toBe(generic);
    });
  });

  it('does not request another page while one is already loading or none remains', () => {
    setResult({
      data: {
        search: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, edges: [edge('e1')] },
      },
    });

    const { result } = renderService({ searchQuery: '' });

    act(() => {
      result.current[0].loadMore();
    });

    expect(fetchMore).not.toHaveBeenCalled();
  });

  it('does not leave an unhandled rejection when fetchMore fails', async () => {
    setResult({
      data: {
        search: { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' }, edges: [edge('e1', 'c1')] },
      },
    });
    fetchMore.mockRejectedValueOnce(new Error('network'));

    const { result } = renderService({ searchQuery: '' });

    await act(async () => {
      result.current[0].loadMore();
      await Promise.resolve();
    });

    expect(fetchMore).toHaveBeenCalledTimes(1);
  });
});
