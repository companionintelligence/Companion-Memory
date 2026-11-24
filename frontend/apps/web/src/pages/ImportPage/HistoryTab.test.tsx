import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryTab } from './HistoryTab';

/**
 * The behaviors that moved here from the old single-surface page, still pinned:
 * a reload mid-import reattaches to the live run, and closing an opened run
 * collapses it back into the grid instead of losing it.
 */
const LIVE_RUN = {
  id: 'run-live',
  label: 'Takeout.zip',
  source: 'wizard',
  dataSources: [] as string[],
  status: 'running',
  percent: 40,
  requestedStages: ['unpack', 'parse'],
  error: null,
  createdAt: '2026-08-13T00:00:00Z',
  startedAt: '2026-08-13T00:01:00Z',
  finishedAt: null,
  stages: [],
};

const FINISHED_RUN = {
  ...LIVE_RUN,
  id: 'run-done',
  label: 'Amazon.zip',
  status: 'completed',
  percent: 100,
  finishedAt: '2026-08-12T00:30:00Z',
};

const FAILED_RUN = {
  ...LIVE_RUN,
  id: 'run-failed',
  label: 'Broken.zip',
  status: 'failed',
  percent: 0,
  error: 'archive extraction failed',
  finishedAt: '2026-08-12T00:05:00Z',
};

const listRuns = vi.fn(async () => [LIVE_RUN, FINISHED_RUN, FAILED_RUN]);

// STABLE, like the real hook: the load effect depends on the whole api object,
// so a fresh one per render re-runs it forever — see useImportApi.test.tsx.
const API = {
  ready: true,
  listSources: async () => [],
  listRuns,
  getRun: async () => LIVE_RUN,
  cancelRun: vi.fn(),
  retryStage: vi.fn(),
};

vi.mock('./useImportApi', () => ({
  useImportApi: () => API,
  // The list said the run was live (which is what triggers the reattach); by
  // the time its detail arrives it has finished — the ordinary end of an
  // import someone left open. Close only renders on a finished run.
  useRunProgress: (runId: string | null) => ({
    run:
      runId == null
        ? null
        : { ...LIVE_RUN, status: 'completed', percent: 100, finishedAt: '2026-08-13T00:30:00Z' },
    error: null,
    refresh: vi.fn(),
  }),
}));

describe('HistoryTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps the grid at ten with a Show-all expander — a 150-run Takeout must not silently vanish', async () => {
    // 1 live (auto-opened as the active detail) + 14 finished.
    listRuns.mockResolvedValueOnce([
      LIVE_RUN,
      ...Array.from({ length: 14 }, (_, i) => ({
        ...FINISHED_RUN,
        id: `run-${i}`,
        label: `part-${i}.zip`,
      })),
    ]);

    render(<HistoryTab />);

    await screen.findByText('part-0.zip');

    // Ten cards, and the button says how many exist in total.
    expect(screen.queryByText('part-9.zip')).toBeInTheDocument();
    expect(screen.queryByText('part-10.zip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show all 14 loaded imports/i }));

    expect(screen.getByText('part-13.zip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  it('pages by cursor: Load-more fetches runs older than the last one shown', async () => {
    // A full first page (100) means more may exist; the second page is short,
    // which is the "no more" signal.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      ...FINISHED_RUN,
      id: `run-a-${i}`,
      label: `part-${i}.zip`,
      createdAt: `2026-08-17T12:${String(59 - Math.floor(i / 10))}:0${i % 10}Z`,
    }));
    const secondPage = Array.from({ length: 3 }, (_, i) => ({
      ...FINISHED_RUN,
      id: `run-b-${i}`,
      label: `older-${i}.zip`,
    }));

    listRuns.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

    render(<HistoryTab />);

    await screen.findByText('part-0.zip');
    fireEvent.click(screen.getByRole('button', { name: /show all 100 loaded imports/i }));
    fireEvent.click(screen.getByRole('button', { name: /load 100 more/i }));

    await screen.findByText('older-2.zip');

    // The cursor is the LAST run of the loaded list — pages chain, never overlap.
    const last = firstPage[firstPage.length - 1];

    expect(listRuns).toHaveBeenLastCalledWith(100, { createdAt: last.createdAt, id: last.id });
    // A short page is the end: the button leaves.
    expect(screen.queryByRole('button', { name: /load 100 more/i })).not.toBeInTheDocument();
  });

  it('says whether each earlier import worked', async () => {
    // The card carried a label, a date and its services — so a run that FAILED
    // looked exactly like one that imported, on the surface whose whole job is
    // telling you what happened to your archives.
    render(<HistoryTab />);

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getAllByText('Imported').length).toBeGreaterThan(0);
  });

  it('names each service of an import once, not once per file it was found in', async () => {
    // `data_sources` records one entry per recognized FILE, so a real Google
    // Takeout came back as 47 entries of which 30 were `google_my_activity`, and
    // the card read "Google Voice, Google My Activity, Google My Activity, +44".
    listRuns.mockResolvedValueOnce([
      {
        ...FINISHED_RUN,
        id: 'run-takeout',
        label: 'google-takeout',
        dataSources: [
          'google_voice',
          'google_my_activity',
          'google_my_activity',
          'google_my_activity',
          'vcard',
        ],
      },
    ]);

    render(<HistoryTab />);

    await screen.findByText('google-takeout');

    // Three distinct services: all three fit, and nothing is left to count.
    expect(screen.getAllByText('google my activity')).toHaveLength(1);
    expect(screen.getByText('google voice')).toBeInTheDocument();
    expect(screen.getByText('vcard')).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it('reattaches to the run that is still going, and closing it keeps it reachable', async () => {
    render(<HistoryTab />);

    // The live run's pipeline opened on its own — a reload mid-import must not
    // look like nothing is happening.
    await screen.findByRole('button', { name: /close/i });
    expect(screen.getByText('Amazon.zip')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    // Collapsed into the grid, not gone: every finished run now offers View.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /view/i })).toHaveLength(3));
    expect(screen.getByText('Takeout.zip')).toBeInTheDocument();
  });
});
