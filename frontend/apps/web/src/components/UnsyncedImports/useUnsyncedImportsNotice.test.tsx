import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetUnsyncedImportsNoticeForTests, useUnsyncedImportsNotice } from './useUnsyncedImportsNotice';

/**
 * The whole point is the gap it closes: parse finishes after the user walked
 * away, and nothing said the records were still in staging. Pinned here:
 * the notice shows only when unpushed runs exist, Sync now performs the Sync
 * card's push, one page load asks exactly once — and the notice is STATE for
 * the layout to draw, never a floating toast (see the first test).
 */

const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });

vi.mock('@ci/shadcn', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useToast: () => ({ toast }) };
});

const listUnpushed = vi.fn(async (): Promise<unknown[]> => []);
const startPush = vi.fn(async () => ({ runs: [{ id: 'run-1' }, { id: 'run-2' }] }));

// STABLE, like the real hook — see useImportApi.test.tsx.
const API = { ready: true, listUnpushed, startPush };

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useImportApi: () => API,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsyncedImportsNoticeForTests();
});

describe('useUnsyncedImportsNotice', () => {
  it('stays hidden when nothing is unpushed', async () => {
    const { result } = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(listUnpushed).toHaveBeenCalled());
    expect(result.current.visible).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  // It used to be a sonner toast. A toast is `position: fixed` at z-index
  // 999999999, so it was drawn over an open dialog's title and close button and
  // over the first row of every page (the Sources switch, the Plan Add field),
  // and when the phone drawer made it `inert` the visible toast let taps fall
  // through to the drawer row beneath it. It is state now, drawn in the layout
  // flow by UnsyncedImportsBanner.
  it('shows the notice as layout state when unpushed runs exist, and never raises a floating toast', async () => {
    listUnpushed.mockResolvedValueOnce([{ id: 'run-1' }]);

    const { result } = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(toast).not.toHaveBeenCalled();
  });

  it('Sync now performs the Sync card push, hides the notice at once and reports what it started', async () => {
    listUnpushed.mockResolvedValueOnce([{ id: 'run-1' }]);

    const { result } = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => {
      result.current.syncNow();
    });

    // Hidden before the request settles: one click, one push, however slow the
    // appliance is. The outcome is an ordinary short-lived toast.
    expect(result.current.visible).toBe(false);
    await waitFor(() => expect(startPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Syncing 2 imports.'));
  });

  it('says so when the sync could not be started', async () => {
    listUnpushed.mockResolvedValueOnce([{ id: 'run-1' }]);
    startPush.mockRejectedValueOnce(new Error('The appliance is busy.'));

    const { result } = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => {
      result.current.syncNow();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The appliance is busy.'));
  });

  it('dismiss hides the notice for the rest of the page load, across layout remounts', async () => {
    listUnpushed.mockResolvedValue([{ id: 'run-1' }]);

    const first = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(first.result.current.visible).toBe(true));

    act(() => {
      first.result.current.dismiss();
    });

    expect(first.result.current.visible).toBe(false);

    first.unmount();

    const second = renderHook(() => useUnsyncedImportsNotice());

    // Neither re-asked nor re-shown: a dismissal is not undone by navigating.
    expect(second.result.current.visible).toBe(false);
    expect(listUnpushed).toHaveBeenCalledTimes(1);
  });

  it('asks once per page load, however many times the layout remounts', async () => {
    listUnpushed.mockResolvedValue([{ id: 'run-1' }]);

    const first = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(first.result.current.visible).toBe(true));

    const second = renderHook(() => useUnsyncedImportsNotice());

    // Still one check: the second mount reads the notice the first one found.
    // Navigation must not nag.
    expect(second.result.current.visible).toBe(true);
    expect(listUnpushed).toHaveBeenCalledTimes(1);
  });

  it('a failed eligibility check never breaks the shell', async () => {
    listUnpushed.mockRejectedValueOnce(new Error('api down'));

    const { result } = renderHook(() => useUnsyncedImportsNotice());

    await waitFor(() => expect(listUnpushed).toHaveBeenCalled());
    expect(result.current.visible).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
