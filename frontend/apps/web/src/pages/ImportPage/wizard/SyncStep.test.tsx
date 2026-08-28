import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncStep } from './SyncStep';

/**
 * The Sync card's promises: it shows exactly what is waiting (including runs
 * from an earlier abandoned session — that is the point of server-side
 * eligibility), one button pushes it all, and "nothing waiting" is a rendered
 * state rather than an error.
 */

const UNPUSHED = [
  {
    id: 'run-1',
    label: 'spotify.zip',
    status: 'completed',
    pendingItems: 1200,
    pendingEntities: 40,
  },
  {
    id: 'run-2',
    label: 'Takeout.zip',
    status: 'partial',
    pendingItems: 9800,
    pendingEntities: 0,
  },
];

const listUnpushed = vi.fn(async () => UNPUSHED);
const startPush = vi.fn(async () => ({ runs: [{ id: 'run-1' }, { id: 'run-2' }] }));
const DISCARDED = {
  runId: 'run-1',
  label: 'spotify.zip',
  stagedRowsDeleted: 1_240,
  sourceRowsDeleted: 0,
  uploadsRestaged: 1,
  mediaFilesKept: 0,
  attachmentContentsKept: 0,
};

const discardRun = vi.fn(async () => DISCARDED);

const API = {
  ready: true,
  listUnpushed,
  startPush,
  discardRun,
};

vi.mock('../useImportApi', () => ({
  useImportApi: () => API,
}));

vi.mock('./LiveRunList', () => ({
  LiveRunList: ({ runIds }: { runIds: readonly string[] }) => (
    <>
      {runIds.map((id) => (
        <div key={id}>pipeline for {id}</div>
      ))}
    </>
  ),
}));

describe('SyncStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUnpushed.mockResolvedValue(UNPUSHED);
    discardRun.mockResolvedValue(DISCARDED);
  });

  it('totals what is staged across every unpushed run', async () => {
    render(<SyncStep onBackToExport={vi.fn()} />);

    await screen.findByText(/11,000/);

    // The sentence is split across <strong> nodes; assert the assembled text.
    const summary = screen.getByText(
      (_, element) => element?.tagName === 'P' && /staged across 2 imports/.test(element.textContent ?? ''),
    );

    expect(summary).toBeInTheDocument();
    expect(screen.getByText('spotify.zip')).toBeInTheDocument();
    expect(screen.getByText('Takeout.zip')).toBeInTheDocument();
  });

  it('one click pushes everything and shows each run’s pipeline', async () => {
    render(<SyncStep onBackToExport={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /sync to my memory/i }));

    await waitFor(() => expect(startPush).toHaveBeenCalledTimes(1));
    // No runIds filter: Sync means everything.
    expect(startPush).toHaveBeenCalledWith();

    expect(await screen.findByText('pipeline for run-1')).toBeInTheDocument();
    expect(screen.getByText('pipeline for run-2')).toBeInTheDocument();
  });

  /**
   * The destructive half of the card. A run listed here is the one kind the
   * appliance never deletes on its own, so this button is the only way out —
   * which is exactly why one click must not fire it.
   */
  describe('discarding a parse', () => {
    it('asks before it deletes, and does nothing if the answer is Keep', async () => {
      render(<SyncStep onBackToExport={vi.fn()} />);

      fireEvent.click((await screen.findAllByRole('button', { name: 'Discard' }))[0]);

      expect(screen.getByText(/no undo/i)).toBeInTheDocument();
      // The prompt describes EVERY discard, so it must not assert the archive
      // is already gone — the endpoint hands it back whenever the appliance
      // still holds it, and the success line then says the opposite.
      expect(screen.getByText(/goes back to your uploads/i)).toBeInTheDocument();
      expect(discardRun).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /keep/i }));

      expect(discardRun).not.toHaveBeenCalled();
      expect(screen.getByText('spotify.zip')).toBeInTheDocument();
    });

    it('discards the confirmed run, drops it from the list and says what went', async () => {
      render(<SyncStep onBackToExport={vi.fn()} />);

      fireEvent.click((await screen.findAllByRole('button', { name: 'Discard' }))[0]);
      fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));

      await waitFor(() => expect(discardRun).toHaveBeenCalledWith('run-1'));

      // The count and the fate of the archive, both — "discarded" alone would
      // leave the user unsure whether their upload went with it.
      expect(await screen.findByText(/1,240 staged rows deleted/)).toBeInTheDocument();
      expect(screen.getByText(/back in your uploads/i)).toBeInTheDocument();
      expect(screen.queryByText('spotify.zip')).not.toBeInTheDocument();
      expect(screen.getByText('Takeout.zip')).toBeInTheDocument();
    });

    /**
     * The survival the user is least likely to guess at. Every wizard run does
     * `unpack, parse, media`, so a run reaching this card has already stored its
     * photos in `ci.files`; the discard takes the parse and leaves those, and a
     * message that only counted the deletion would read as "all of it went".
     */
    it('says what the discard kept, not only what it deleted', async () => {
      discardRun.mockResolvedValue({
        ...DISCARDED,
        uploadsRestaged: 0,
        mediaFilesKept: 412,
        attachmentContentsKept: 12,
      });

      render(<SyncStep onBackToExport={vi.fn()} />);

      fireEvent.click((await screen.findAllByRole('button', { name: 'Discard' }))[0]);
      fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));

      expect(
        await screen.findByText(/412 files this import had already saved stay in your memory/i),
      ).toBeInTheDocument();
      // And it does not claim an archive came back when none did.
      expect(screen.queryByText(/back in your uploads/i)).not.toBeInTheDocument();
    });
  });

  it('says so when nothing is waiting', async () => {
    listUnpushed.mockResolvedValue([]);

    render(<SyncStep onBackToExport={vi.fn()} />);

    expect(await screen.findByText(/nothing is waiting to sync/i)).toBeInTheDocument();
  });
});
