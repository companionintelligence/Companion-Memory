import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearJobsSnapshots } from './jobsSnapshots';
import { useJobsDashboard, type JobsDashboardResponse } from './useJobsDashboard';

/**
 * The Jobs dashboard's reader.
 *
 * Two things are under test that the rest of the page cannot assert for itself:
 * that a revisit paints the last snapshot on its FIRST frame rather than a
 * skeleton, and that "refreshing" means a fetch over figures already on screen —
 * never a reason to take them away.
 */

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null, authenticated: true }));

// `authToken` is the web JWT, and native has none: the phone signs with a
// keystore API key that `fetchJson` attaches as `x-api-key`. Gating on the
// bearer is what left this page dark inside the Capacitor app.
vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }],
}));

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

function dashboard(pending: number): JobsDashboardResponse {
  return {
    summary: {
      pending,
      active: 0,
      retry: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      deadLettered: 0,
      scheduled: 0,
    },
    archiveDistribution: [],
    activeDistribution: [],
    queueDistribution: [],
    smartRotationDistribution: [],
    jobs: [],
    archive: [],
    schedules: [],
    crons: [],
    queues: [],
  };
}

/** A fetch that stays in flight until the test resolves it. */
function deferred<T>() {
  let settle: (value: T) => void = () => {};

  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return { promise, settle: (value: T) => settle(value) };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

beforeEach(() => {
  h.authToken = 'jwt-abc';
  h.authenticated = true;
  clearJobsSnapshots();
  fetchJson.mockReset();
  fetchJson.mockResolvedValue(dashboard(1));
  setVisibility('visible');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useJobsDashboard — session', () => {
  it('fetches on native, where there is no bearer to send', async () => {
    h.authToken = null;
    h.authenticated = true;

    renderHook(() => useJobsDashboard(0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchJson).toHaveBeenCalledTimes(1);

    const [, init] = fetchJson.mock.calls[0] as [string, RequestInit];

    expect(init.headers).toEqual({});
  });

  it('does not fetch at all without a session', async () => {
    h.authenticated = false;
    h.authToken = null;

    renderHook(() => useJobsDashboard(1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('useJobsDashboard — the last snapshot', () => {
  it('paints the previous dashboard on the first frame of a revisit', async () => {
    fetchJson.mockResolvedValue(dashboard(12716));

    const first = renderHook(() => useJobsDashboard(0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(first.result.current.data?.summary.pending).toBe(12716);
    first.unmount();

    // No timers advanced: this is the very first render of the revisit, which
    // used to be a skeleton for as long as the appliance took to answer.
    const second = renderHook(() => useJobsDashboard(0));

    expect(second.result.current.data?.summary.pending).toBe(12716);
    expect(second.result.current.loading).toBe(false);
    // And it says when those figures are from, rather than claiming "now".
    expect(second.result.current.updatedAt).toBeInstanceOf(Date);
  });

  it('flags a failed revisit as stale instead of erasing the figures', async () => {
    const first = renderHook(() => useJobsDashboard(0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    first.unmount();

    fetchJson.mockRejectedValue(new Error('Failed to fetch'));

    const second = renderHook(() => useJobsDashboard(0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // A restored snapshot means this mount is not a first load: the failure
    // belongs in the stale banner, over numbers that are still readable.
    expect(second.result.current.data).not.toBeNull();
    expect(second.result.current.staleSince).toBeInstanceOf(Date);
    expect(second.result.current.error).toBe('Failed to fetch');
  });
});

describe('useJobsDashboard — refreshing', () => {
  it('reports an explicit refresh as refreshing, with the old figures still up', async () => {
    fetchJson.mockResolvedValue(dashboard(5));

    const { result } = renderHook(() => useJobsDashboard(0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.refreshing).toBe(false);

    const pending = deferred<JobsDashboardResponse>();
    fetchJson.mockReturnValue(pending.promise);

    let settled: Promise<unknown> = Promise.resolve();

    act(() => {
      settled = Promise.resolve(result.current.refresh());
    });

    // The point of the flag: a spinner, not a skeleton. Nothing is replaced.
    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.summary.pending).toBe(5);

    await act(async () => {
      pending.settle(dashboard(6));
      await settled;
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.data?.summary.pending).toBe(6);
  });

  it('keeps the interval poll silent, so the spinner answers "did my refresh do anything"', async () => {
    const { result } = renderHook(() => useJobsDashboard(1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const pending = deferred<JobsDashboardResponse>();
    fetchJson.mockReturnValue(pending.promise);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // A poll every fifteen seconds spinning the header would make the
    // indicator mean nothing at all.
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(result.current.refreshing).toBe(false);

    await act(async () => {
      pending.settle(dashboard(2));
    });
  });
});
