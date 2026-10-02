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

  it('names the records that could not be identified, and why', () => {
    // The bug this closes: a 4,040-entity Apple import finished `partial`
    // because of ONE contact card with no name and no email, and the excellent
    // reason the push had recorded for it — "no stable name or handle to
    // resolve by" — lived only in ci_import.staged_entities.push_error. The run
    // showed the word `partial` and a count of skipped groups.
    render(
      <RunPipeline
        run={runWith({
          pushed: 4039,
          entities: {
            resolved: 4039,
            skipped: 1,
            unresolved: 1,
            failed: 0,
            unresolvedDetail: {
              reason: 'entity_unresolved',
              message: 'no stable name or handle to resolve by',
              count: 1,
              sources: { vcard: 1 },
              examples: ['vcard: Liam Broza and 4,926 others.vcf'],
            },
          },
        })}
      />,
    );

    expect(screen.getByText(/1 record could not be identified/i)).toBeInTheDocument();
    expect(screen.getByText(/no stable name or handle to resolve by/i)).toBeInTheDocument();
    // The export it came from, because that is what makes it findable.
    expect(screen.getByText(/Liam Broza and 4,926 others\.vcf/)).toBeInTheDocument();
  });

  it('keeps the by-design skips apart from the ones that are a loss', () => {
    // `entities.skipped` counts both: an `email_thread` per gmail thread (by
    // design) and a record with nothing to key on (a gap). Rolled into one
    // line, ten deliberate exclusions hid the one that mattered.
    render(
      <RunPipeline
        run={runWith({
          entities: {
            resolved: 0,
            skipped: 11,
            unresolved: 1,
            failed: 0,
            unresolvedDetail: {
              reason: 'entity_unresolved',
              message: 'no stable name or handle to resolve by',
              count: 1,
              sources: { vcard: 1 },
              examples: [],
            },
          },
        })}
      />,
    );

    expect(screen.getByText(/10 groups skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/1 record could not be identified/i)).toBeInTheDocument();
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

describe('RunPipeline cancel', () => {
  it('cancels a still-running import', () => {
    const onCancel = vi.fn();
    const run = { ...runWith({ pushed: 1 }), status: 'running', finishedAt: null };

    render(<RunPipeline run={run} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers no cancel button once the run is finished', () => {
    // Cancel is the in-progress action; a finished run (even a failed one)
    // has nothing left to stop.
    const onCancel = vi.fn();

    render(<RunPipeline run={runWith({ pushed: 1 })} onCancel={onCancel} />);

    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('offers no cancel button when the host does not supply one, even while running', () => {
    const run = { ...runWith({ pushed: 1 }), status: 'running', finishedAt: null };

    render(<RunPipeline run={run} />);

    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });
});

describe('RunPipeline stage retry', () => {
  function runWithStage(stage: Partial<ImportRunDetail['stages'][number]>): ImportRunDetail {
    return {
      ...runWith({}),
      stages: [
        {
          id: 'stage-1',
          seq: 1,
          kind: 'unpack',
          status: 'failed',
          phase: null,
          processed: 4,
          total: 10,
          weight: 20,
          etaSeconds: null,
          durationMs: null,
          error: 'disk full',
          detail: {},
          ...stage,
        },
      ],
    };
  }

  it('retries a failed stage by its id', () => {
    const onRetryStage = vi.fn();

    render(<RunPipeline run={runWithStage({ status: 'failed' })} onRetryStage={onRetryStage} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetryStage).toHaveBeenCalledWith('stage-1');
  });

  it('offers retry for a cancelled stage too', () => {
    const onRetryStage = vi.fn();

    render(<RunPipeline run={runWithStage({ status: 'cancelled' })} onRetryStage={onRetryStage} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetryStage).toHaveBeenCalledWith('stage-1');
  });

  it('offers no retry for a stage that is not failed or cancelled', () => {
    const onRetryStage = vi.fn();

    render(<RunPipeline run={runWithStage({ status: 'running' })} onRetryStage={onRetryStage} />);

    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('offers no retry button when the host does not supply a handler', () => {
    render(<RunPipeline run={runWithStage({ status: 'failed' })} />);

    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});

describe('RunPipeline retry failed push', () => {
  it('re-queues the rows a completed push could not write', () => {
    // Distinct from stage retry: the push STAGE completed, but some of its
    // rows landed in `failed` — this is the only route back for them.
    const onRetryFailedPush = vi.fn();

    render(<RunPipeline run={runWith({ pushed: 10, failed: 3 })} onRetryFailedPush={onRetryFailedPush} />);
    fireEvent.click(screen.getByRole('button', { name: /try these again/i }));

    expect(onRetryFailedPush).toHaveBeenCalledTimes(1);
  });

  it('offers no retry-failed-push button when nothing failed', () => {
    render(<RunPipeline run={runWith({ pushed: 10, failed: 0 })} onRetryFailedPush={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /try these again/i })).not.toBeInTheDocument();
  });

  it('offers no retry-failed-push button when the host does not supply a handler', () => {
    render(<RunPipeline run={runWith({ pushed: 10, failed: 3 })} />);

    expect(screen.queryByRole('button', { name: /try these again/i })).not.toBeInTheDocument();
  });
});

/**
 * What a finished run says about each stage.
 *
 * The QA run of the 701,447-record Google Takeout showed a green check beside
 * "Read parsing fitbit (56/57)", "Store files uploading" and "Save pushing", and a
 * "Found:" line that printed the 57 recognized files' importer ids as they were
 * stored — `google_my_activity` thirty times over.
 */
describe('RunPipeline stage sub-label', () => {
  function stageOf(overrides: Partial<ImportRunDetail['stages'][number]>): ImportRunDetail['stages'][number] {
    return {
      id: 'stage-parse',
      seq: 1,
      kind: 'parse',
      status: 'completed',
      phase: 'parsing fitbit (56/57)',
      processed: 706_689,
      total: 706_689,
      weight: 35,
      etaSeconds: null,
      durationMs: null,
      error: null,
      detail: {},
      ...overrides,
    };
  }

  function runOf(stage: ImportRunDetail['stages'][number]): ImportRunDetail {
    return { ...runWith({}), stages: [stage] };
  }

  it('does not narrate a finished stage as though it were still working', () => {
    render(<RunPipeline run={runOf(stageOf({ status: 'completed' }))} />);

    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.queryByText('parsing fitbit (56/57)')).not.toBeInTheDocument();
  });

  it('keeps the live sub-label on a stage that is running', () => {
    const run = { ...runOf(stageOf({ status: 'running' })), status: 'running', finishedAt: null };

    render(<RunPipeline run={run} />);

    expect(screen.getByText('parsing fitbit (56/57)')).toBeInTheDocument();
  });

  it('keeps where a stage stopped when it failed', () => {
    render(<RunPipeline run={runOf(stageOf({ status: 'failed', error: 'unexpected end of mbox' }))} />);

    expect(screen.getByText('parsing fitbit (56/57)')).toBeInTheDocument();
  });
});

describe('RunPipeline found line', () => {
  // 57 entries, 14 distinct — the shape of the real Takeout's parse detail.
  const RECOGNIZED = [
    'contact_list',
    'calendar',
    'calendar',
    'vcard',
    'google_voice',
    ...Array.from({ length: 30 }, () => 'google_my_activity'),
    'kmlgx',
    'google_my_activity',
    'vcard',
  ];

  it('names each service once, however many files of it were recognized', () => {
    render(<RunPipeline run={runWith({ recognized: RECOGNIZED })} />);

    const found = screen.getByText(/^Found:/);

    expect(found.textContent?.match(/google my activity/gi)).toHaveLength(1);
    expect(found.textContent?.match(/calendar/gi)).toHaveLength(1);
    expect(found.textContent?.match(/vcard/gi)).toHaveLength(1);
  });

  it('uses what the catalogue calls a service rather than its importer id', () => {
    render(
      <RunPipeline
        run={runWith({ recognized: RECOGNIZED })}
        sources={[
          { name: 'google_my_activity', title: 'Google My Activity' },
          { name: 'google_voice', title: 'Google Voice' },
        ]}
      />,
    );

    expect(screen.getByText(/^Found:/).textContent).toBe(
      'Found: contact list, calendar, vcard, Google Voice, Google My Activity, kmlgx',
    );
  });

  it('never prints a raw snake_case importer id', () => {
    render(<RunPipeline run={runWith({ recognized: RECOGNIZED })} />);

    expect(screen.getByText(/^Found:/).textContent).not.toMatch(/_/);
  });
});
