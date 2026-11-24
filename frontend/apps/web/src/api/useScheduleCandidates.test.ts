import { useMutation, useQuery } from '@apollo/client/react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSuggestionSyncThrottle, useScheduleCandidates } from './useScheduleCandidates';

vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);

// The hook declares its mutations in a fixed order, so handing each call the
// next stub in that order is enough to tell them apart without reproducing the
// documents themselves.
const ORDER = ['sync', 'accept', 'decline', 'snooze', 'breakDown', 'returnEvent'] as const;

const mutate: Record<(typeof ORDER)[number], ReturnType<typeof vi.fn>> = {
  sync: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  snooze: vi.fn(),
  breakDown: vi.fn(),
  returnEvent: vi.fn(),
};

const refetch = vi.fn();

function setQuery(candidates: Array<{ id: string }> | null, error?: Error) {
  mockedUseQuery.mockReturnValue({
    data: candidates ? { scheduleCandidates: candidates } : undefined,
    loading: false,
    error,
    refetch,
  } as unknown as ReturnType<typeof useQuery>);
}

const FROM = new Date('2026-08-03T00:00:00.000Z');
const TO = new Date('2026-08-10T00:00:00.000Z');

beforeEach(() => {
  resetSuggestionSyncThrottle();
  refetch.mockResolvedValue({});

  for (const key of ORDER) {
    mutate[key].mockResolvedValue({ data: {} });
  }

  let call = 0;
  mockedUseMutation.mockImplementation(
    () => [mutate[ORDER[call++ % ORDER.length]], {}] as unknown as ReturnType<typeof useMutation>,
  );

  setQuery([]);
});

afterEach(() => {
  mockedUseQuery.mockReset();
  mockedUseMutation.mockReset();
});

describe('useScheduleCandidates — a failed fetch is not an empty slate', () => {
  it('reports the query error instead of quietly returning no candidates', async () => {
    setQuery(null, new Error('candidates unavailable'));

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.candidates).toEqual([]);
  });

  it('reports no error on a genuinely empty slate', async () => {
    const { result } = renderHook(() => useScheduleCandidates(FROM, TO));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(false);
  });
});

describe('useScheduleCandidates — the suggestion sync', () => {
  it('does not re-run on every remount', async () => {
    // The projection is a write and does not depend on the window, so routing
    // away and back — or StrictMode's double-invoke — must not fire it again.
    const first = renderHook(() => useScheduleCandidates(FROM, TO));
    await waitFor(() => expect(mutate.sync).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => useScheduleCandidates(FROM, TO));
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(mutate.sync).toHaveBeenCalledTimes(1);
  });

  it('runs again once the throttle has expired', async () => {
    const start = Date.now();

    renderHook(() => useScheduleCandidates(FROM, TO)).unmount();
    await waitFor(() => expect(mutate.sync).toHaveBeenCalledTimes(1));

    vi.spyOn(Date, 'now').mockReturnValue(start + 6 * 60_000);
    renderHook(() => useScheduleCandidates(FROM, TO));

    await waitFor(() => expect(mutate.sync).toHaveBeenCalledTimes(2));
  });

  it('leaves the slate alone when the sync fails', async () => {
    mutate.sync.mockRejectedValue(new Error('projection failed'));

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO));

    await waitFor(() => expect(mutate.sync).toHaveBeenCalledTimes(1));
    expect(result.current.candidates).toEqual([]);
    // The slate is additive — a failed refresh degrades to stale, not broken.
    expect(result.current.error).toBe(false);
  });
});

describe('useScheduleCandidates — mutations reject rather than resolve', () => {
  it('rejects a refused placement and does not tell the grid to re-read', async () => {
    mutate.accept.mockRejectedValue(new Error('slot taken'));
    const onPlaced = vi.fn();

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO, onPlaced));

    await expect(result.current.accept('c1', new Date())).rejects.toThrow('slot taken');
    expect(onPlaced).not.toHaveBeenCalled();
  });

  it('rejects a refused decline', async () => {
    mutate.decline.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO));

    await expect(result.current.decline('c1', 'never')).rejects.toThrow('nope');
  });

  it('rejects a refused un-placement', async () => {
    mutate.returnEvent.mockRejectedValue(new Error('externally owned'));
    const onPlaced = vi.fn();

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO, onPlaced));

    await expect(result.current.returnEvent('e1')).rejects.toThrow('externally owned');
    expect(onPlaced).not.toHaveBeenCalled();
  });

  it('re-reads both lanes once a placement lands', async () => {
    const onPlaced = vi.fn();

    const { result } = renderHook(() => useScheduleCandidates(FROM, TO, onPlaced));

    await result.current.accept('c1', new Date('2026-08-04T09:00:00.000Z'));

    expect(mutate.accept).toHaveBeenCalledWith({
      variables: { id: 'c1', startTime: '2026-08-04T09:00:00.000Z', endTime: null },
    });
    expect(onPlaced).toHaveBeenCalledTimes(1);
  });
});
