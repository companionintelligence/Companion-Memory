import { type ReactNode } from 'react';

import { InMemoryCache } from '@apollo/client';
import { MockedProvider, type MockedResponse } from '@apollo/client/testing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { detectBrowserTimeZone } from '@/lib/timezone';

import { DateTimeFormatProvider, useDateTimeFormat, USER_TIME_FORMAT_QUERY } from './useDateTimeFormat';

const h = vi.hoisted(() => ({
  user: null as { id: string; timezone: string } | null,
}));

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => ({ user: h.user, loading: false, error: undefined, refetch: vi.fn() }),
}));

function timeFormatIs(timeFormat: string): MockedResponse {
  return {
    request: { query: USER_TIME_FORMAT_QUERY },
    result: { data: { me: { __typename: 'UserType', id: 'u1', timeFormat } } },
  };
}

function renderWithProvider(mocks: MockedResponse[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MockedProvider mocks={mocks} cache={new InMemoryCache()}>
      <DateTimeFormatProvider>{children}</DateTimeFormatProvider>
    </MockedProvider>
  );

  return renderHook(() => useDateTimeFormat(), { wrapper });
}

beforeEach(() => {
  h.user = { id: 'u1', timezone: 'Asia/Tokyo' };
});

describe('useDateTimeFormat', () => {
  it('is the device’s own behaviour outside the provider', () => {
    const { result } = renderHook(() => useDateTimeFormat());

    expect(result.current.timeFormat).toBe('auto');
    expect(result.current.timeZone).toBeUndefined();
  });

  it('applies the signed-in person’s time format and profile zone', async () => {
    const { result } = renderWithProvider([timeFormatIs('h23')]);

    // Until the preference arrives, times read exactly as they always did.
    expect(result.current.timeFormat).toBe('auto');

    await waitFor(() => expect(result.current.timeFormat).toBe('h23'));
    expect(result.current.timeZone).toBe('Asia/Tokyo');
    // 22:43 UTC is 07:43 the next morning in Tokyo.
    expect(result.current.time('2026-09-30T22:43:00Z', { hour: 'numeric', minute: '2-digit' }, 'en-US')).toBe(
      '07:43',
    );
  });

  it('resolves the zone the way Plan and Schedule do: an unusable profile zone falls back to the browser’s', () => {
    h.user = { id: 'u1', timezone: 'Mars/Olympus_Mons' };

    const { result } = renderWithProvider([timeFormatIs('auto')]);

    expect(result.current.timeZone).toBe(detectBrowserTimeZone());
  });

  it('asks for nothing while signed out, and keeps the device’s behaviour', () => {
    h.user = null;

    // No mocks: a query that ran would fail the test with "No more mocked responses".
    const { result } = renderWithProvider([]);

    expect(result.current.timeFormat).toBe('auto');
    expect(result.current.timeZone).toBe(detectBrowserTimeZone());
  });

  it('stays automatic against a server that predates the field, instead of failing', async () => {
    const { result } = renderWithProvider([
      {
        request: { query: USER_TIME_FORMAT_QUERY },
        result: { errors: [new GraphQLError('Cannot query field "timeFormat" on type "UserType".')] },
      },
    ]);

    // Give the failed request time to land, then check it changed nothing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(result.current.timeFormat).toBe('auto');
    expect(result.current.timeZone).toBe('Asia/Tokyo');
  });
});
