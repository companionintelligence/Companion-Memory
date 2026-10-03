import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatBytes, InboxPanel } from './InboxPanel';

/**
 * The inbox panel's contract:
 *
 *  - Import All CONFIRMS, and the confirm names the consume behavior — the
 *    inbox is the one surface where importing removes files, and that must be
 *    read before it happens, not discovered after;
 *  - a per-unit failure renders on its row while its siblings proceed;
 *  - a unit already being imported offers no second Import button.
 */

const UNITS = [
  {
    path: 'takeout',
    kind: 'directory' as const,
    sizeBytes: 2_400_000_000,
    fileCount: 1042,
    recognized: [{ dataSource: 'gmail', title: 'Gmail', confidence: 0.9 }],
    declared: [],
    activeRunId: null,
    claimed: false,
  },
  {
    path: 'phone/contacts.vcf',
    kind: 'file' as const,
    sizeBytes: 12_000,
    fileCount: 1,
    recognized: [],
    declared: ['Contacts'],
    activeRunId: 'run-live',
    claimed: true,
  },
  // Claimed by ANOTHER account: the inbox folder is shared, so this unit is
  // unavailable here too — and its run id is not this caller's to see.
  {
    path: 'other/photos.zip',
    kind: 'file' as const,
    sizeBytes: 5_000,
    fileCount: 1,
    recognized: [],
    declared: [],
    activeRunId: null,
    claimed: true,
  },
];

const scanInbox = vi.fn(async (): Promise<import('./useImportApi').InboxScan> => ({
  available: true,
  inboxDir: '/var/lib/ci-import/inbox',
  displayDir: '/var/lib/ci-import/inbox',
  units: UNITS,
  skippedSymlinks: 0,
  truncated: false,
  recognitionPartial: false,
}));

const importInbox = vi.fn(async (units?: readonly string[]) => ({
  results: (units ?? UNITS.map((unit) => unit.path)).map((unit) =>
    unit === 'takeout'
      ? { unit, runId: 'run-1', label: 'takeout' }
      : { unit, error: `${unit} is already being imported by another run` },
  ),
}));

// STABLE, like the real hook — see useImportApi.test.tsx.
const API = { ready: true, scanInbox, importInbox };

vi.mock('./useImportApi', () => ({
  useImportApi: () => API,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('InboxPanel', () => {
  it('lists units with size, recognition, and the consume contract in the header', async () => {
    render(<InboxPanel />);

    expect(await screen.findByText('takeout')).toBeInTheDocument();
    expect(screen.getByText(/2\.4 GB · 1042 files/)).toBeInTheDocument();
    // The contract is stated up front, not only in the confirm.
    expect(screen.getByText(/removed from the folder as its import consumes it/)).toBeInTheDocument();
  });

  it('offers no Import button for a unit already being imported', async () => {
    render(<InboxPanel />);

    await screen.findByText('takeout');

    // One importable unit ⇒ one per-row Import button. The other two are
    // claimed — one by this user, one by somebody else.
    expect(screen.getAllByRole('button', { name: 'Import' })).toHaveLength(1);
    expect(screen.getByText('Importing — see History')).toBeInTheDocument();
    // A claim held by another account offers no Import button and no run link.
    expect(screen.getByText('Importing on this appliance')).toBeInTheDocument();
  });

  it('Import all confirms with the consume warning before starting anything', async () => {
    render(<InboxPanel />);

    await screen.findByText('takeout');
    fireEvent.click(screen.getByRole('button', { name: 'Import all' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/removed from the folder/));
    await waitFor(() => expect(importInbox).toHaveBeenCalledTimes(1));
    // Everything not already running — the panel omits units, the server scans.
    expect(importInbox).toHaveBeenCalledWith(undefined);
  });

  it('starts nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<InboxPanel />);

    await screen.findByText('takeout');
    fireEvent.click(screen.getByRole('button', { name: 'Import all' }));

    expect(importInbox).not.toHaveBeenCalled();
  });

  it('renders a per-unit error on its row and rescans after a batch', async () => {
    importInbox.mockResolvedValueOnce({
      results: [
        { unit: 'takeout', runId: 'run-1', label: 'takeout' },
        { unit: 'phone/contacts.vcf', error: 'phone/contacts.vcf is already being imported by another run' },
      ],
    });

    render(<InboxPanel />);

    await screen.findByText('takeout');
    fireEvent.click(screen.getByRole('button', { name: 'Import all' }));

    expect(await screen.findByText(/contacts\.vcf is already being imported/)).toBeInTheDocument();
    // Consumed units leave the folder; the list must not go stale.
    await waitFor(() => expect(scanInbox).toHaveBeenCalledTimes(2));
  });

  it('says it is scanning while the first scan is in flight', async () => {
    let release: (scan: import('./useImportApi').InboxScan) => void = () => undefined;

    scanInbox.mockImplementationOnce(
      () =>
        new Promise<import('./useImportApi').InboxScan>((resolve) => {
          release = resolve;
        }),
    );

    render(<InboxPanel />);

    // The pending call must read as work, not as a frozen page.
    expect(await screen.findByText(/scanning the inbox folder/i)).toBeInTheDocument();

    release({
      available: true,
      inboxDir: '/inbox/u',
      displayDir: '/inbox/u',
      units: [],
      skippedSymlinks: 0,
      truncated: false,
      recognitionPartial: false,
    });

    expect(await screen.findByRole('button', { name: /rescan/i })).toBeInTheDocument();
  });

  it('names the folder as the person reaches it, not as the container does', async () => {
    // On a managed appliance the API's own path is inside a container; the
    // server sends the host-side spelling alongside it and THAT is the one a
    // person can open.
    scanInbox.mockResolvedValueOnce({
      available: true,
      inboxDir: '/var/lib/ci-import/inbox/kyle_lifescope.io',
      displayDir: '/home/kyle/companion-hub/import-work/inbox/kyle_lifescope.io',
      units: [],
      skippedSymlinks: 0,
      truncated: false,
      recognitionPartial: false,
    });

    render(<InboxPanel />);

    expect(
      await screen.findByText('/home/kyle/companion-hub/import-work/inbox/kyle_lifescope.io'),
    ).toBeInTheDocument();
    expect(screen.queryByText('/var/lib/ci-import/inbox/kyle_lifescope.io')).not.toBeInTheDocument();
  });

  it('reports an unavailable inbox rather than an empty one', async () => {
    scanInbox.mockResolvedValueOnce({
      available: false,
      reason: 'The inbox directory is not readable: EACCES',
      inboxDir: '/var/lib/ci-import/inbox',
      displayDir: '/var/lib/ci-import/inbox',
      units: [],
      skippedSymlinks: 0,
      truncated: false,
      recognitionPartial: false,
    });

    render(<InboxPanel />);

    expect(await screen.findByText(/not available on this appliance/)).toBeInTheDocument();
  });
});

describe('formatBytes', () => {
  it('is coarse like the rest of the page', () => {
    expect(formatBytes(12_000)).toBe('12.0 kB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
    expect(formatBytes(42)).toBe('42 B');
  });
});
