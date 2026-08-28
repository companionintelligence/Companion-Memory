import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearJobsSnapshots } from './jobsSnapshots';
import { DEFAULT_JOB_FILTERS, useJobsList, type JobListResponse } from './useJobsList';

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null, authenticated: true }));

// `authToken` is the web JWT and is null inside the Capacitor app, which signs
// requests with a keystore API key instead — so the hook gates on
// `authenticated`, the flag that is true for either credential.
vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }],
}));

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

const EMPTY_RESPONSE: JobListResponse = {
  items: [],
  total: 0,
  limit: 50,
  offset: 0,
  queues: [],
  stateCounts: {},
};

beforeEach(() => {
  h.authToken = 'jwt-abc';
  h.authenticated = true;
  clearJobsSnapshots();
  fetchJson.mockReset();
  fetchJson.mockResolvedValue(EMPTY_RESPONSE);
  setVisibility('visible');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useJobsList — search debounce', () => {
  it('does not requery on every keystroke — only after 300ms of quiet', async () => {
    const { rerender } = renderHook(({ filters }) => useJobsList(filters, 0), {
      initialProps: { filters: DEFAULT_JOB_FILTERS },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fetchJson.mockClear();

    rerender({ filters: { ...DEFAULT_JOB_FILTERS, search: 'f' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ filters: { ...DEFAULT_JOB_FILTERS, search: 'fo' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ filters: { ...DEFAULT_JOB_FILTERS, search: 'foo' } });

    // Still inside the 300ms quiet window from the last keystroke.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchJson).not.toHaveBeenCalled();

    // The remaining 100ms of quiet elapses and the debounced value fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect((fetchJson.mock.calls[0] as unknown as [string])[0]).toContain('search=foo');
  });

  it('encodes every non-empty filter into the query string', async () => {
    renderHook(() =>
      useJobsList(
        {
          state: 'failed',
          queue: 'search-index',
          category: 'search',
          type: 'note.created',
          search: 'migration',
          offset: 50,
          limit: 25,
        },
        0,
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const url = (fetchJson.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('type=note.created');
    expect(url).toContain('state=failed');
    expect(url).toContain('queue=search-index');
    expect(url).toContain('category=search');
    expect(url).toContain('search=migration');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50');
  });
});

describe('useJobsList — polling', () => {
  it('re-fetches on the given interval while the tab is visible', async () => {
    renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('skips the poll while the tab is hidden — it does not bill the appliance for a scan nobody sees', async () => {
    renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('never polls at all when refreshIntervalMs is 0', async () => {
    renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('does not fetch at all without a session', async () => {
    h.authToken = null;
    h.authenticated = false;

    renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('fetches on native, where the session is a keystore API key and not a JWT', async () => {
    // The whole page used to be dark inside the Capacitor app: every request
    // gated on `authToken`, which native never has, so nothing ever loaded and
    // nothing could be refreshed. `fetchJson` attaches the `x-api-key` itself,
    // and the endpoint's guard is JwtOrApiKey — so there is no bearer to send.
    h.authToken = null;
    h.authenticated = true;

    renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(fetchJson).toHaveBeenCalledTimes(1);

    const [, init] = fetchJson.mock.calls[0] as [string, RequestInit];

    expect(init.headers).toEqual({});
  });
});

describe('useJobsList — result handling', () => {
  it('surfaces a readable error message and stops loading on failure', async () => {
    fetchJson.mockRejectedValue(new Error('502 Bad Gateway'));

    const { result } = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.error).toBe('502 Bad Gateway');
    expect(result.current.loading).toBe(false);
  });

  it('exposes the fetched page and clears a previous error on the next success', async () => {
    fetchJson.mockRejectedValueOnce(new Error('first call failed'));

    const { result } = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.error).toBe('first call failed');

    fetchJson.mockResolvedValueOnce({ ...EMPTY_RESPONSE, total: 3 });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data?.total).toBe(3);
  });
});

describe('useJobsList — the last snapshot', () => {
  it('renders the previous page on the first frame of a revisit', async () => {
    fetchJson.mockResolvedValue({ ...EMPTY_RESPONSE, total: 7 });

    const first = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(first.result.current.data?.total).toBe(7);

    first.unmount();

    // Coming back used to mean skeletons until the appliance answered — which,
    // on a queue with a live import running, is the moment an operator is
    // actually looking. No timers advanced: this is the very first render.
    const second = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    expect(second.result.current.data?.total).toBe(7);
    expect(second.result.current.loading).toBe(false);
  });

  it('redraws a page it has already fetched when the filters swing back to it', async () => {
    fetchJson.mockResolvedValue({ ...EMPTY_RESPONSE, total: 4, limit: 50 });

    const { result, rerender } = renderHook(({ filters }) => useJobsList(filters, 0), {
      initialProps: { filters: DEFAULT_JOB_FILTERS },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The phone page-size switch is exactly this: a different query on the
    // first commit, which used to empty the table every time Jobs was opened.
    fetchJson.mockResolvedValue({ ...EMPTY_RESPONSE, total: 2, limit: 20 });
    rerender({ filters: { ...DEFAULT_JOB_FILTERS, limit: 20 } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.data?.total).toBe(2);

    rerender({ filters: DEFAULT_JOB_FILTERS });

    // Synchronously, before the refetch for the old query has answered.
    expect(result.current.data?.total).toBe(4);
  });

  it('keeps a failed load from wiping the snapshot it is already showing', async () => {
    fetchJson.mockResolvedValue({ ...EMPTY_RESPONSE, total: 9 });

    const first = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    first.unmount();

    fetchJson.mockRejectedValue(new Error('502 Bad Gateway'));

    const second = renderHook(() => useJobsList(DEFAULT_JOB_FILTERS, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(second.result.current.error).toBe('502 Bad Gateway');
    expect(second.result.current.data?.total).toBe(9);
  });
});
