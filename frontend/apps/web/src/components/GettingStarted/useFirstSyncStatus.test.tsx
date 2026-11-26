import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFirstSyncStatus } from './useFirstSyncStatus';

const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  listUnpushed: vi.fn(),
  headers: {} as Record<string, string>,
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

vi.mock('@/hooks/useSessionAuth', () => ({
  useSessionAuth: () => ({ ready: true, authToken: null, headers: h.headers }),
}));

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useImportApi: () => ({ listUnpushed: h.listUnpushed }),
}));

const TABLES = {
  communications: 12_400,
  events: 88,
  content: 0,
  objects: 0,
  browser_activity: 0,
  position: 0,
};

function answer(queue = { created: 3, active: 2, failed: 4 }) {
  return { tables: TABLES, searchIndex: { queue } };
}

beforeEach(() => {
  h.fetchJson.mockReset();
  h.listUnpushed.mockReset();
  h.listUnpushed.mockResolvedValue([]);
});

describe('useFirstSyncStatus', () => {
  it('reports the counts, the queue and the failed index jobs from a good answer', async () => {
    h.fetchJson.mockResolvedValue(answer());
    const { result } = renderHook(() => useFirstSyncStatus(true, false));

    await waitFor(() => expect(result.current.indexingItems).toBe(5));

    expect(result.current).toMatchObject({ error: null, failedIndexingItems: 4, totals: TABLES });
    expect(result.current.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('keeps the last good numbers and says so when a refresh fails', async () => {
    h.fetchJson.mockResolvedValueOnce(answer());
    const { result } = renderHook(() => useFirstSyncStatus(true, false));
    await waitFor(() => expect(result.current.indexingItems).toBe(5));

    h.fetchJson.mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).toMatch(/last successful check/));
    expect(result.current).toMatchObject({ indexingItems: 5, failedIndexingItems: 4, totals: TABLES });
  });

  it('clears the error once a later refresh succeeds', async () => {
    h.fetchJson.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useFirstSyncStatus(true, false));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    h.fetchJson.mockResolvedValue(answer());
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.indexingItems).toBe(5);
  });

  it.each([
    ['an empty answer', undefined],
    ['an answer with no search-index section', { tables: TABLES }],
  ])('treats %s as a failed refresh, never as an empty queue', async (_, body) => {
    h.fetchJson.mockResolvedValue(body);
    const { result } = renderHook(() => useFirstSyncStatus(true, false));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    // Nothing is half-updated: the queue is unknown, not zero.
    expect(result.current).toMatchObject({ indexingItems: null, failedIndexingItems: null, totals: null });
  });

  it('also fails the refresh when the unsaved-imports check does', async () => {
    h.fetchJson.mockResolvedValue(answer());
    h.listUnpushed.mockRejectedValue(new Error('no import service'));
    const { result } = renderHook(() => useFirstSyncStatus(true, true));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.indexingItems).toBe(5);
  });
});
