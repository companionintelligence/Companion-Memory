import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnsyncedImportsBanner } from './UnsyncedImportsBanner';
import { resetUnsyncedImportsNoticeForTests } from './useUnsyncedImportsNotice';

/**
 * QA, iOS run 2026-10-02 (D5): the notice was a sonner toast, and a toast is
 * `position: fixed; z-index: 999999999`. It was drawn over an open dialog's
 * title and close button, over the Sources switch and the Plan Add field after
 * every launch, and — because the phone drawer makes every sibling of the toast
 * `inert` while the toast stays painted on top — a tap on it fell through to
 * the drawer's Capture row and opened the camera.
 *
 * It is a strip in the layout flow now. These tests pin what makes that true:
 * it takes its own space, it has nothing under it to fall through to, and it
 * leaves nobody else's handlers running.
 */

const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });

vi.mock('@ci/shadcn', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useToast: () => ({ toast }) };
});

const listUnpushed = vi.fn(async (): Promise<unknown[]> => [{ id: 'run-1' }]);
const startPush = vi.fn(async () => ({ runs: [{ id: 'run-1' }] }));

// STABLE, like the real hook — see useImportApi.test.tsx.
const API = { ready: true, listUnpushed, startPush };

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useImportApi: () => API,
}));

/** The banner inside an ancestor that would react to any click that escaped it. */
function renderBanner() {
  const onAncestorClick = vi.fn();

  render(
    <div data-testid="ancestor" onClick={onAncestorClick}>
      <UnsyncedImportsBanner />
    </div>,
  );

  return { onAncestorClick };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsyncedImportsNoticeForTests();
});

describe('UnsyncedImportsBanner', () => {
  it('draws nothing while there is nothing to sync', async () => {
    listUnpushed.mockResolvedValueOnce([]);

    renderBanner();

    await waitFor(() => expect(listUnpushed).toHaveBeenCalled());
    expect(screen.queryByTestId('unsynced-imports-notice')).not.toBeInTheDocument();
  });

  it('says so, with Sync now and Dismiss, once unpushed runs are found', async () => {
    renderBanner();

    const banner = await screen.findByTestId('unsynced-imports-notice');

    expect(banner).toHaveTextContent('You have unsynced imports.');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You have unsynced imports.');
  });

  it('takes its own space in the layout flow, under every modal and outside the toaster', async () => {
    renderBanner();

    const banner = await screen.findByTestId('unsynced-imports-notice');

    // Out of flow means over the page. `fixed`/`absolute`/`sticky` would cover the
    // controls it sits beside; a z-index would put it back above the dialogs and
    // sheets, which are `fixed z-50` — an in-flow box with no z-index is under them.
    expect(banner.className).not.toMatch(/(^|\s)(fixed|absolute|sticky)(\s|$)/);
    expect(banner.className).not.toMatch(/(^|\s)-?z-/);
    expect(banner.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    // Not inside sonner's `position: fixed; z-index: 999999999` toaster.
    expect(banner.closest('[data-sonner-toaster]')).toBeNull();
    expect(banner.closest('[data-sonner-toast]')).toBeNull();
  });

  it('Dismiss only dismisses: the banner goes, nothing is pushed and no ancestor hears about it', async () => {
    const { onAncestorClick } = renderBanner();

    await screen.findByTestId('unsynced-imports-notice');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('unsynced-imports-notice')).not.toBeInTheDocument();
    expect(startPush).not.toHaveBeenCalled();
    expect(onAncestorClick).not.toHaveBeenCalled();
  });

  it('Sync now pushes once, reports the outcome and stays inside the banner', async () => {
    const { onAncestorClick } = renderBanner();

    await screen.findByTestId('unsynced-imports-notice');

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(screen.queryByTestId('unsynced-imports-notice')).not.toBeInTheDocument();
    await waitFor(() => expect(startPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Syncing 1 import.'));
    expect(onAncestorClick).not.toHaveBeenCalled();
  });

  it('keeps a click anywhere on the strip to itself', async () => {
    const { onAncestorClick } = renderBanner();

    const banner = await screen.findByTestId('unsynced-imports-notice');

    fireEvent.click(screen.getByText('You have unsynced imports.'));
    fireEvent.click(banner);

    expect(onAncestorClick).not.toHaveBeenCalled();
    // A click on the words is not a dismissal, and not a sync.
    expect(screen.getByTestId('unsynced-imports-notice')).toBeInTheDocument();
    expect(startPush).not.toHaveBeenCalled();
  });
});
