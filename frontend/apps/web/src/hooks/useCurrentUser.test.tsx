import { useQuery } from '@apollo/client';
import { setApiBaseUrl } from '@ci/common';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetUser, rememberUser } from './rememberedUser';
import { useCurrentUser } from './useCurrentUser';

const h = vi.hoisted(() => ({ authToken: 'tok' as string | null }));

vi.mock('./useAuth', () => ({
  // `useCurrentUser` gates on `authenticated` (true for a web JWT session OR a native
  // API key); derive it from the token so both credentials are covered.
  useAuth: () => [
    {
      authToken: h.authToken,
      authenticated: Boolean(h.authToken),
      expired: false,
      loading: false,
      error: null,
    },
    {},
  ],
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

  describe('when Memory does not answer for the profile', () => {
    it.each([
      ['a network failure', { networkError: Object.assign(new Error('Failed to fetch'), {}), graphQLErrors: [] }],
      ['a gateway 502', { networkError: Object.assign(new Error('502'), { statusCode: 502 }), graphQLErrors: [] }],
      [
        'a server error with the database down',
        { graphQLErrors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
      ],
    ])('reports unreachable rather than signed out after %s', (_label, error) => {
      mockedUseQuery.mockReturnValue({
        data: { me: null },
        loading: false,
        error,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() => useCurrentUser());

      expect(result.current.user).toBeNull();
      expect(result.current.unreachable).toBe(true);
    });

    it.each([
      ['an UNAUTHENTICATED answer', { graphQLErrors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] }],
      ['a 401', { networkError: Object.assign(new Error('401'), { statusCode: 401 }), graphQLErrors: [] }],
    ])('is not unreachable after %s, which is the server saying no', (_label, error) => {
      mockedUseQuery.mockReturnValue({
        data: { me: null },
        loading: false,
        error,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() => useCurrentUser());

      expect(result.current.unreachable).toBe(false);
    });

    it('asks again every few seconds until Memory answers', () => {
      vi.useFakeTimers();

      try {
        const refetch = vi.fn().mockResolvedValue(undefined);
        mockedUseQuery.mockReturnValue({
          data: undefined,
          loading: false,
          error: { networkError: new Error('Failed to fetch'), graphQLErrors: [] },
          refetch,
        } as unknown as ReturnType<typeof useQuery>);

        renderHook(() => useCurrentUser());
        vi.advanceTimersByTime(10_000);

        expect(refetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reports loading while authed with no data yet', () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useCurrentUser());

    // loading || (authenticated && !skip && !data && !error) → true even though query loading is false.
    expect(result.current.loading).toBe(true);
  });

  describe('on a phone while the appliance cannot be reached', () => {
    const native = () => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
      setApiBaseUrl('https://box.local');
    };

    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
      setApiBaseUrl('');
      forgetUser();
    });

    it('keeps the profile the appliance gave, and answers with it when a later query is an outage', () => {
      native();
      const me = { id: 'u1', name: 'John', email: 'j@example.com', onboarded: true };
      mockedUseQuery.mockReturnValue({
        data: { me },
        loading: false,
        error: undefined,
      } as unknown as ReturnType<typeof useQuery>);
      const first = renderHook(() => useCurrentUser());
      expect(first.result.current.remembered).toBe(false);
      first.unmount();

      mockedUseQuery.mockReturnValue({
        data: undefined,
        loading: false,
        error: { networkError: Object.assign(new Error('500'), { statusCode: 500 }), graphQLErrors: [] },
      } as unknown as ReturnType<typeof useQuery>);
      const { result } = renderHook(() => useCurrentUser());

      expect(result.current.user).toEqual(me);
      expect(result.current.remembered).toBe(true);
      expect(result.current.loading).toBe(false);
    });

    it('signs out when the appliance answers that the key is no good', () => {
      native();
      rememberUser('https://box.local', { id: 'u1' });
      mockedUseQuery.mockReturnValue({
        data: undefined,
        loading: false,
        error: { networkError: Object.assign(new Error('401'), { statusCode: 401 }), graphQLErrors: [] },
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() => useCurrentUser());

      expect(result.current.user).toBeNull();
      expect(result.current.remembered).toBe(false);
    });

    it('never answers a browser with a kept profile', () => {
      setApiBaseUrl('https://box.local');
      rememberUser('https://box.local', { id: 'u1' });
      mockedUseQuery.mockReturnValue({
        data: undefined,
        loading: false,
        error: { networkError: Object.assign(new Error('500'), { statusCode: 500 }), graphQLErrors: [] },
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() => useCurrentUser());

      expect(result.current.user).toBeNull();
    });
  });

  it('skips GraphQL on native until a Memory origin is set', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
    };
    setApiBaseUrl('');
    mockedUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useCurrentUser());

    const options = mockedUseQuery.mock.calls.at(-1)?.[1] as { skip: boolean };
    expect(options.skip).toBe(true);
    expect(result.current.loading).toBe(false);

    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    setApiBaseUrl('');
  });
});
