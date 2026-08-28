/**
 * useActionService: fetches a single action by id, refetching whenever the id
 * changes. Covers the null-id no-op, the authorized GET, the error path
 * (which must not erase whatever data was already on screen), and the manual
 * refetch escape hatch.
 */
import { fetchJson } from '@ci/common';
import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Action } from './types';
import { useActionService } from './useActionService';

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'test-token' }],
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: vi.fn(),
}));

const mockedFetchJson = vi.mocked(fetchJson);

const ACTION: Action = { id: '41', title: 'Reply to Jamie' } as Action;

beforeEach(() => {
  mockedFetchJson.mockReset();
});

describe('useActionService — no id', () => {
  it('does not fetch, and reports an empty, settled state', () => {
    const { result } = renderHook(() => useActionService(null));

    expect(mockedFetchJson).not.toHaveBeenCalled();
    expect(result.current[0]).toEqual({ data: null, loading: false, error: null });
  });
});

describe('useActionService — fetching by id', () => {
  it('GETs the action, authorized with the bearer token', async () => {
    mockedFetchJson.mockResolvedValue(ACTION);

    const { result } = renderHook(() => useActionService('41'));

    await waitFor(() => expect(result.current[0].data).toEqual(ACTION));

    expect(mockedFetchJson).toHaveBeenCalledWith('/api/actions/41', {
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    });
  });

  it('is loading while the request is in flight, then settles', async () => {
    let release!: (action: Action) => void;
    mockedFetchJson.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const { result } = renderHook(() => useActionService('41'));

    await waitFor(() => expect(result.current[0].loading).toBe(true));

    await act(async () => {
      release(ACTION);
    });

    expect(result.current[0].loading).toBe(false);
    expect(result.current[0].data).toEqual(ACTION);
  });

  it('re-fetches when the id changes', async () => {
    mockedFetchJson.mockResolvedValue(ACTION);
    const { result, rerender } = renderHook(({ id }) => useActionService(id), {
      initialProps: { id: '41' },
    });

    await waitFor(() => expect(result.current[0].data).toEqual(ACTION));

    const SECOND: Action = { id: '99', title: 'Call the plumber' } as Action;
    mockedFetchJson.mockResolvedValue(SECOND);
    rerender({ id: '99' });

    await waitFor(() => expect(result.current[0].data).toEqual(SECOND));
    expect(mockedFetchJson).toHaveBeenLastCalledWith('/api/actions/99', expect.anything());
  });

  it('reports a real error and does not silently clear whatever data was already shown', async () => {
    mockedFetchJson.mockResolvedValueOnce(ACTION);
    const { result, rerender } = renderHook(({ id }) => useActionService(id), {
      initialProps: { id: '41' },
    });
    await waitFor(() => expect(result.current[0].data).toEqual(ACTION));

    const fetchError = new Error('404 not found');
    mockedFetchJson.mockRejectedValueOnce(fetchError);
    rerender({ id: '99' });

    await waitFor(() => expect(result.current[0].error).toBe(fetchError));
    // The stale action from before the failed refetch is still what's on screen.
    expect(result.current[0].data).toEqual(ACTION);
    expect(result.current[0].loading).toBe(false);
  });

  it('refetch() re-runs the same request on demand', async () => {
    mockedFetchJson.mockResolvedValue(ACTION);
    const { result } = renderHook(() => useActionService('41'));
    await waitFor(() => expect(result.current[0].data).toEqual(ACTION));

    mockedFetchJson.mockClear();
    await act(async () => {
      await result.current[1].refetch();
    });

    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
    expect(mockedFetchJson).toHaveBeenCalledWith('/api/actions/41', expect.anything());
  });
});
