import { useQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentUser } from './useCurrentUser';

const h = vi.hoisted(() => ({ authToken: 'tok' as string | null }));

vi.mock('./useAuth', () => ({
  useAuth: () => [{ authToken: h.authToken, expired: false, loading: false, error: null }, {}],
}));

vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);

beforeEach(() => {
  h.authToken = 'tok';
});

afterEach(() => mockedUseQuery.mockReset());

describe('useCurrentUser', () => {
  it('returns the current user from the query', () => {
    const me = { id: 'u1', name: 'John', email: 'j@example.com', onboarded: true };
    mockedUseQuery.mockReturnValue({
      data: { me },
      loading: false,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useCurrentUser());

    expect(result.current.user).toEqual(me);
    expect(result.current.loading).toBe(false);
  });

  it('skips the query when there is no auth token', () => {
    h.authToken = null;
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useCurrentUser());

    const options = mockedUseQuery.mock.calls.at(-1)?.[1] as { skip: boolean };
    expect(options.skip).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it('reports loading while authed with no data yet', () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useCurrentUser());

    // loading || (authToken && !data && !error) → true even though query loading is false.
    expect(result.current.loading).toBe(true);
  });
});
