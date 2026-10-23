/**
 * The dialog a refused write opens, driven through the real connection provider and a
 * faked health endpoint: it says to wait, shows that "Check again" is checking, and says
 * when waiting is over.
 */
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { ConnectionModeProvider } from '@ci/common/src/utils/connectionMode';
import { assertApplianceWritable } from '@ci/common/src/utils/offlineWrites';
import {
  MUTED_TOAST_ID,
  errorToastsMuted,
  resetErrorToastMute,
  useToast,
} from '@ci/shadcn/src/components/coalescers/sonner';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okResponse } from '@/test/fetchFakes';

import { CHECK_AGAIN_DISPLAY_MS, OfflineWriteDialog } from './OfflineWriteDialog';

const unreachable = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
});

/** Longer than the checking state, with headroom for a loaded runner. */
const AFTER_CHECK_MS = CHECK_AGAIN_DISPLAY_MS + 2_000;

function renderDialog() {
  return render(
    <ConnectionModeProvider args={[]}>
      <OfflineWriteDialog />
    </ConnectionModeProvider>,
  );
}

/** A write attempted the way a page would: it throws, and the dialog hears about it. */
function tryWrite() {
  act(() => {
    expect(() => assertApplianceWritable({ url: '/api/people/1' })).toThrow();
  });
}

/** Render with a dead server, let the probe settle, refuse a write: the dialog is open. */
async function openOnRefusal() {
  vi.stubGlobal('fetch', unreachable);
  renderDialog();
  await waitFor(() => expect(unreachable).toHaveBeenCalled());
  await waitFor(() => tryWrite());
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Not connected to your Memory server');
}

beforeEach(() => {
  resetErrorToastMute();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl('');
  resetErrorToastMute();
});

describe('OfflineWriteDialog', () => {
  it('stays closed until a write is refused, then says to wait for the server', async () => {
    vi.stubGlobal('fetch', unreachable);
    renderDialog();

    // Let the first probe settle on "unreachable" before trying.
    await waitFor(() => expect(unreachable).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('offline-write-dialog')).not.toBeInTheDocument());

    await waitFor(() => tryWrite());

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Not connected to your Memory server');
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Nothing was changed. Wait until it is back online',
    );
  });

  it("mutes the feature's own error toast for a moment, since the dialog already says what happened", async () => {
    await openOnRefusal();

    const { toast } = useToast();

    // What a page's catch block does right after the refused write: dropped, not shown.
    expect(errorToastsMuted()).toBe(true);
    expect(toast.error('Could not move that. Try again shortly.')).toBe(MUTED_TOAST_ID);
  });

  it('"Check again" visibly checks, then shows the same warning when nothing answered', async () => {
    await openOnRefusal();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    const dialog = screen.getByRole('alertdialog');

    expect(dialog).toHaveTextContent('Checking…');
    expect(dialog).toHaveTextContent('Looking for your Memory server.');
    expect(dialog).not.toHaveTextContent('Not connected to your Memory server');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();

    await waitFor(() => expect(dialog).toHaveTextContent('Not connected to your Memory server'), {
      timeout: AFTER_CHECK_MS,
    });
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('flips to "Connected again" once Check again finds the server answering', async () => {
    await openOnRefusal();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    // The checking state is shown even when the answer is instant.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Checking…');

    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Connected again'), {
      timeout: AFTER_CHECK_MS,
    });
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});
