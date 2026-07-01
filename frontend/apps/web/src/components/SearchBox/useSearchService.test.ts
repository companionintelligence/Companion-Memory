import { useQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearchService } from './useSearchService';

// Mock Apollo's useQuery so we can assert the variables/skip the service derives
// and feed canned edges back — no need to reproduce the large SEARCH_QUERY doc.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);

function setResult(edges: Array<{ node: unknown }> = []) {
  mockedUseQuery.mockReturnValue({
    data: { search: { edges } },
    loading: false,
    error: undefined,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as { variables: Record<string, unknown>; skip: boolean };
}

beforeEach(() => setResult());
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
    expect(result.current.loading).toBe(true);
  });
});
