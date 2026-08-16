import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunPipeline } from './RunPipeline';
import type { ImportRunDetail } from './useImportApi';

/**
 * A finished bar over a mixed result has to explain itself.
 *
 * A real FIRST import of an Amazon archive pushed 5,823 records and deduped
 * 4,985 — not because anything had been imported before, but because content is
 * keyed on the work rather than the occurrence: fifty listens of one audiobook
 * are fifty events and one document. With only the total shown, that read as
 * though half the archive had failed.
 */

function runWith(detail: Record<string, unknown>): ImportRunDetail {
  return {
    id: 'run-1',
    label: 'All Data Categories.zip',
    source: 'wizard',
    dataSources: [],
    status: 'partial',
    percent: 100,
    requestedStages: ['unpack', 'parse', 'push'],
    error: null,
    createdAt: '2026-08-12T00:00:00Z',
    startedAt: '2026-08-12T00:00:00Z',
    finishedAt: '2026-08-12T00:30:00Z',
    stages: [
      {
        id: 'stage-push',
        seq: 2,
        kind: 'push',
        status: 'completed',
        phase: null,
        processed: 10_808,
        total: 10_808,
        weight: 20,
        etaSeconds: null,
        durationMs: null,
        error: null,
        detail,
      },
    ],
  };
}

describe('RunPipeline stage detail', () => {
  it('explains the repeats without claiming a previous import', () => {
    // The common case is repeats WITHIN this run, so copy that says "from an
    // earlier import" would be wrong on most first imports.
    render(<RunPipeline run={runWith({ pushed: 5823, deduped: 4985, failed: 0 })} />);

    expect(screen.getByText(/5\.0k already in your memory/i)).toBeInTheDocument();
    expect(screen.queryByText(/earlier import/i)).not.toBeInTheDocument();
  });

  it('reports genuine failures separately from duplicates', () => {
    render(<RunPipeline run={runWith({ pushed: 10, deduped: 2, failed: 3 })} />);

    expect(screen.getByText(/2 already in your memory/i)).toBeInTheDocument();
    expect(screen.getByText(/3 could not be saved/i)).toBeInTheDocument();
  });

  it('stays quiet when everything simply landed', () => {
    render(<RunPipeline run={runWith({ pushed: 10, deduped: 0, failed: 0 })} />);

    expect(screen.queryByText(/already in your memory/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be saved/i)).not.toBeInTheDocument();
  });

  it('names a service whose parser failed, even though the rest of the run succeeded', () => {
    // The reason this needs a test: ParseStage carries on past a throwing
    // parser, and the per-source counts are filtered to rows > 0 — so the
    // failed service disappears from the badges while `recognized` still lists
    // it. Nothing else in the UI would ever say Gmail was not read.
    render(
      <RunPipeline
        run={runWith({
          recognized: ['gmail', 'google_photos'],
          failures: [{ dataSource: 'gmail', error: 'unexpected end of mbox' }],
        })}
      />,
    );

    expect(screen.getByText(/Could not read your gmail data/i)).toBeInTheDocument();
    expect(screen.getByText(/unexpected end of mbox/i)).toBeInTheDocument();
  });

  it('calls a partial run a success with gaps', () => {
    render(<RunPipeline run={runWith({ pushed: 1, deduped: 0, failed: 0 })} />);

    expect(screen.getAllByText(/Imported, with some items skipped/i).length).toBeGreaterThan(0);
  });
});

describe('RunPipeline close', () => {
  it('offers a way back out of an opened run', () => {
    // Viewing an earlier import was one-way: it expanded and nothing collapsed
    // it again.
    const onClose = vi.fn();

    render(<RunPipeline run={runWith({ pushed: 1 })} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not carry the Card default gap on top of its own spacing', () => {
    // The shared Card is `flex flex-col gap-6`. Stacked with this card's own
    // rhythm it left the status area mostly whitespace, so the gap is overridden
    // here rather than in the shared component, which the whole app uses.
    const { container } = render(<RunPipeline run={runWith({ pushed: 1 })} />);
    const card = container.querySelector('[data-slot="card"]');

    expect(card?.className).not.toMatch(/\bgap-6\b/);
  });

  it('shows no close button when there is nothing to collapse back to', () => {
    render(<RunPipeline run={runWith({ pushed: 1 })} />);

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('withholds close while the import is still running', () => {
    // Closing a live run hid the only thing reporting on it, and it collapses
    // into a list of EARLIER imports — so there was nowhere for it to go.
    // Cancel is the in-progress action.
    const run = { ...runWith({ pushed: 1 }), status: 'running', finishedAt: null };

    render(<RunPipeline run={run} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});
