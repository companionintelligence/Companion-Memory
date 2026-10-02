import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActiveImportRun,
  ActiveImportSnapshot,
  ActiveImportStage,
} from '@/pages/ImportPage/useImportApi';

import { ImportActivity, ImportActivityCard, describeStage } from './ImportActivity';

/**
 * The pinned progress region, pinned in tests against the import it was built
 * for: 13 runs of one inbox scan, observed live on 2026-08-19.
 *
 * Every assertion here corresponds to something that was WRONG on screen while
 * that import ran:
 *
 *  - the page showed a service picker and no sign an import was happening;
 *  - all thirteen runs rendered as their shared label, "qa-full-corpus";
 *  - twelve of them said "queued", which is also what a stuck run says;
 *  - a stage that had been waiting 51 minutes looked identical to one whose own
 *    run had not reached it, and neither said how long it had been waiting;
 *  - `items_per_sec` and `started_at` were recorded and shown nowhere;
 *  - a stage error was behind a status word.
 */

// `authenticated` as well as `authToken`: the real `useAuth` reports
// `Boolean(accessToken) || Boolean(nativeApiKey)`, and the import API now gates
// on that rather than on the web JWT — the JWT is null inside the Capacitor
// app, whose credential is a keystore key `fetchJson` attaches itself, so
// gating on the token made the whole import surface inert on a phone. A mock
// that omits it is a session the real hook could never produce.
vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'test-token', authenticated: true }] }));

function stage(overrides: Partial<ActiveImportStage> = {}): ActiveImportStage {
  return {
    id: 'stage-1',
    seq: 0,
    kind: 'unpack',
    status: 'completed',
    phase: 'expanded',
    processed: 1,
    total: 1,
    weight: 20,
    itemsPerSec: null,
    etaSeconds: null,
    durationMs: 1_872,
    error: null,
    detail: {},
    startedAt: '2026-08-19T00:18:17.000Z',
    finishedAt: '2026-08-19T00:18:19.000Z',
    queueState: 'done',
    queuePosition: null,
    waitingSince: null,
    elapsedMs: 1_872,
    ...overrides,
  };
}

/** A stage holding the appliance's single slot right now. */
function runningStage(overrides: Partial<ActiveImportStage> = {}): ActiveImportStage {
  return stage({
    id: 'live-parse',
    seq: 1,
    kind: 'parse',
    status: 'running',
    queueState: 'running',
    phase: 'parsing google_purchases (48/56)',
    processed: 412_000,
    total: 703_956,
    itemsPerSec: 554.94,
    etaSeconds: 526,
    durationMs: null,
    finishedAt: null,
    elapsedMs: 45 * 60_000 + 34_000,
    ...overrides,
  });
}

function run(overrides: Partial<ActiveImportRun> = {}): ActiveImportRun {
  return {
    id: 'run-takeout',
    label: 'qa-full-corpus',
    source: 'api',
    unit: 'google-takeout',
    dataSources: ['google_my_activity', 'calendar', 'vcard', 'google_voice'],
    declaredSources: null,
    status: 'running',
    percent: 55,
    requestedStages: ['unpack', 'parse', 'media', 'push'],
    error: null,
    records: 0,
    createdAt: '2026-08-19T00:17:59.000Z',
    startedAt: '2026-08-19T00:18:17.000Z',
    finishedAt: null,
    elapsedMs: 65 * 60_000,
    stages: [
      stage(),
      stage({
        id: 'stage-parse',
        seq: 1,
        kind: 'parse',
        phase: 'parsing google_purchases (48/56)',
        processed: 703_956,
        total: 703_956,
        itemsPerSec: 554.94,
        durationMs: 2_734_458,
        elapsedMs: 2_734_458,
      }),
      stage({
        id: 'stage-media',
        seq: 2,
        kind: 'media',
        status: 'queued',
        phase: null,
        processed: 0,
        total: null,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
        queueState: 'waiting',
        queuePosition: 1,
        waitingSince: '2026-08-19T01:04:06.000Z',
        elapsedMs: 51 * 60_000,
      }),
      stage({
        id: 'stage-push',
        seq: 3,
        kind: 'push',
        status: 'queued',
        phase: null,
        processed: 0,
        total: null,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
        queueState: 'blocked',
        queuePosition: null,
        waitingSince: null,
        elapsedMs: null,
      }),
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<ActiveImportSnapshot> = {}): ActiveImportSnapshot {
  const runs = overrides.runs ?? [run()];

  return {
    generatedAt: '2026-08-19T01:24:00.000Z',
    active: true,
    batch: {
      total: runs.length,
      running: runs.filter((entry) => entry.status === 'running').length,
      queued: 0,
      completed: runs.filter((entry) => entry.status === 'completed').length,
      failed: runs.filter((entry) => entry.status === 'failed').length,
      cancelled: 0,
      percent: 55,
      records: 0,
      startedAt: '2026-08-19T00:17:24.000Z',
      elapsedMs: 66 * 60_000,
    },
    queue: {
      // Per kind, as the appliance runs them: media has two slots, the rest one.
      concurrency: { unpack: 1, parse: 1, media: 2, push: 1 },
      slots: 5,
      running: 1,
      waiting: 12,
      blocked: 12,
      longestWaitMs: 51 * 60_000,
    },
    truncated: false,
    ...overrides,
    runs,
  };
}

/** The real hook, fed by a stubbed `fetch`, so the poll path is exercised too. */
function stubSnapshot(...responses: Array<ActiveImportSnapshot | null>) {
  let index = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = responses[Math.min(index, responses.length - 1)];

      index += 1;

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ImportActivity', () => {
  it('renders while a run is unfinished', async () => {
    stubSnapshot(snapshot());

    render(<ImportActivity />);

    // The heading that was missing entirely: the import surface opened on a
    // service picker while thirteen runs were an hour into importing.
    expect(await screen.findByTestId('import-activity')).toBeInTheDocument();
    // A heading, not the per-run status word that happens to read the same.
    expect(screen.getByRole('heading', { name: /Importing 1 of 1 source/ })).toBeInTheDocument();
  });

  it('disappears entirely once every run has finished', async () => {
    // `active: false` is what the server answers when nothing is unfinished —
    // not a 404, and not an empty card. A permanent widget reporting absence is
    // exactly the chrome that would push the wizard's Continue off a phone.
    stubSnapshot(snapshot({ active: false, runs: [] }));

    const { container } = render(<ImportActivity />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('import-activity')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the one active-imports endpoint, not one request per run', async () => {
    // The discipline `useRunsProgress` had to learn: at a Takeout's 140 runs,
    // one detail poll per run per tick pegged the tab's renderer process.
    stubSnapshot(snapshot());

    render(<ImportActivity />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('/api/import/runs/active');
  });
});

describe('ImportActivityCard', () => {
  it('names each run by the source it is importing, not the shared batch label', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run(),
            run({ id: 'run-amazon', unit: 'amazon', percent: 100, status: 'completed' }),
            run({ id: 'run-whatsapp', unit: 'whatsapp' }),
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Show all 3 sources/ }));

    // Thirteen runs of one batch share a label. Only the unit tells them apart,
    // and until now nothing rendered it.
    expect(screen.getByText('Google Takeout')).toBeInTheDocument();
    expect(screen.getByText('Amazon')).toBeInTheDocument();
    expect(screen.getByText('Whatsapp')).toBeInTheDocument();
    // The label is kept, demoted to the sub-line.
    expect(screen.getAllByText(/qa-full-corpus/).length).toBeGreaterThan(0);
  });

  /**
   * The region is PINNED, so its height is taken from whatever the page is for.
   *
   * Measured at 1280×800 before this existed: the card rendered every run at
   * full height, came out 489px tall inside a 440px column, and pushed the
   * wizard — step row, source picker and the Continue button with it — off the
   * bottom of a page that does not scroll. Nothing on the import surface was
   * reachable while an import ran, which is a worse bug than the one the region
   * was built to fix.
   */
  it('shows what is happening, not thirteen copies of "waiting its turn"', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({ id: 'run-live', unit: 'chrome', stages: [runningStage()] }),
            run({ id: 'run-amazon', unit: 'amazon' }),
            run({ id: 'run-whatsapp', unit: 'whatsapp' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('Chrome')).toBeInTheDocument();
    expect(screen.queryByText('Amazon')).not.toBeInTheDocument();
    // The ones held back are still counted — see the aggregate line — and the
    // button says how many rather than "show more".
    expect(screen.getByRole('button', { name: 'Show all 3 sources' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 3 sources' }));

    expect(screen.getByText('Amazon')).toBeInTheDocument();
    expect(screen.getByText('Whatsapp')).toBeInTheDocument();
  });

  it('keeps a failed run in view even when another is running', () => {
    // The whole point of the surface, in the owner's words: "I need to see how
    // it went wrong". A failure sorts above the run holding the slot, because
    // the region is height-capped and the top of it is what gets read.
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({ id: 'run-live', unit: 'chrome', stages: [runningStage()] }),
            run({
              id: 'run-facebook',
              unit: 'facebook',
              status: 'failed',
              stages: [stage({ id: 'boom', kind: 'push', status: 'failed', error: 'ENOSPC' })],
            }),
          ],
        })}
      />,
    );

    const rows = screen.getAllByRole('button', { expanded: false }).map((node) => node.textContent);

    expect(rows[0]).toContain('Facebook');
    expect(rows[1]).toContain('Chrome');
    expect(screen.getByText('ENOSPC')).toBeInTheDocument();
  });

  it('tells a stage waiting in the queue apart from one its run has not reached', () => {
    render(<ImportActivityCard snapshot={snapshot()} />);

    // The stage in the queue is what the compact view keeps: it is the one with
    // a clock running, and the one that looks like a stall until it says so.
    // Named by kind, because that is the queue it is actually in: this is the
    // media stage, so it waits behind other media stages and nothing else.
    expect(screen.getByText('Next in the store files queue')).toBeInTheDocument();
    // And the wait is dated, which is what makes it legible as normal.
    expect(screen.getByText('51m 0s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show every stage' }));

    // Both are `status: 'queued'` in the database. One has been enqueued for 51
    // minutes behind a single execution slot; the other is not queued at all —
    // and conflating them is what made a normal batch import look broken.
    expect(screen.getByText('Next in the store files queue')).toBeInTheDocument();
    expect(screen.getByText('Not started yet')).toBeInTheDocument();
  });

  it('states the concurrency, which is what makes a long queue read as normal', () => {
    render(<ImportActivityCard snapshot={snapshot()} />);

    // Built from the server's numbers, not a hardcoded "one at a time" — which
    // stopped being true the day media went to two slots.
    expect(screen.getByText(/runs 1 unpack, 1 read, 2 store files and 1 save at a time/)).toBeInTheDocument();
    expect(screen.getByText(/longest wait 51m 0s/)).toBeInTheDocument();
  });

  it('shows the running stage with its phase, counts, throughput and ETA', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({
              stages: [
                stage({
                  id: 'live-parse',
                  kind: 'parse',
                  status: 'running',
                  queueState: 'running',
                  phase: 'parsing google_purchases (48/56)',
                  processed: 412_000,
                  total: 703_956,
                  itemsPerSec: 554.94,
                  etaSeconds: 526,
                  durationMs: null,
                  finishedAt: null,
                  elapsedMs: 45 * 60_000 + 34_000,
                }),
              ],
            }),
          ],
        })}
      />,
    );

    // Throughput was written to `items_per_sec` since the table was created and
    // dropped by the API mapper, so no surface could ever show it.
    expect(
      screen.getByText(/parsing google_purchases \(48\/56\) · 412.0k \/ 704.0k · 555\/s · 8m 46s left/),
    ).toBeInTheDocument();
    // Elapsed for a stage still RUNNING, where `duration_ms` is still null.
    expect(screen.getByText('45m 34s')).toBeInTheDocument();
  });

  it('does not describe a finished stage with the words it said while it was working', () => {
    // A finished run's summary line is its LAST stage, and the runner never
    // clears `phase` on completion: a completed Save went on reading "pushing",
    // a completed Read "parsing fitbit (56/57)".
    const finished = stage({
      kind: 'push',
      status: 'completed',
      queueState: 'done',
      phase: 'pushing',
      processed: 706_689,
      total: 706_689,
      itemsPerSec: null,
    });

    expect(describeStage(finished)).toBe('706.7k / 706.7k');
    expect(describeStage(stage({ ...finished, kind: 'parse', phase: 'parsing fitbit (56/57)' }))).toBe(
      '706.7k / 706.7k',
    );
  });

  /**
   * Reproduced 2026-09-29: a worker restarted mid-parse, and this line went on
   * pulsing "running" over counts frozen at 8141, with no error, for the twelve
   * minutes recovery took to notice. The server now says when a running
   * stage's heartbeat has gone silent; the line has to say it too.
   */
  it('says a running stage has stalled, instead of pulsing over frozen counts', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({
              stages: [
                stage({
                  id: 'stalled-parse',
                  kind: 'parse',
                  status: 'running',
                  queueState: 'running',
                  phase: 'parsing google_activity (3/56)',
                  processed: 8_141,
                  total: null,
                  itemsPerSec: 12,
                  etaSeconds: 600,
                  durationMs: null,
                  finishedAt: null,
                  elapsedMs: 9 * 60_000,
                  heartbeatAt: '2026-08-19T01:20:00.000Z',
                  stalled: true,
                }),
              ],
            }),
          ],
        })}
      />,
    );

    // The reason to look first, and no ETA — a stalled stage's is a lie.
    expect(
      screen.getByText('Stalled — no heartbeat · parsing google_activity (3/56) · 8.1k · 12/s'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('stalled')).toBeInTheDocument();
    expect(screen.queryByLabelText('running')).not.toBeInTheDocument();
  });

  it('says why a stage that was halfway through is back in the queue', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({
              stages: [
                stage({
                  id: 'requeued-parse',
                  kind: 'parse',
                  status: 'queued',
                  queueState: 'waiting',
                  queuePosition: 1,
                  processed: 0,
                  total: null,
                  durationMs: null,
                  startedAt: null,
                  finishedAt: null,
                  elapsedMs: 20_000,
                  detail: { interrupted: { reason: 'worker stopped heartbeating', processed: 8141 } },
                }),
              ],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('Next in the read queue · retrying, its worker stopped')).toBeInTheDocument();
  });

  it("puts a failed stage error on the stage, in the stage's own words", () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [
            run({
              id: 'run-facebook',
              unit: 'facebook',
              status: 'failed',
              stages: [
                stage({
                  id: 'bad-push',
                  kind: 'push',
                  status: 'failed',
                  queueState: 'done',
                  error: 'ENOSPC: no space left on device, write',
                }),
              ],
            }),
          ],
        })}
      />,
    );

    // Not behind a status word, not in a tooltip, not three clicks into History.
    expect(screen.getByText('ENOSPC: no space left on device, write')).toBeInTheDocument();
  });

  it('summarises the batch in the vocabulary that is true', () => {
    render(
      <ImportActivityCard
        snapshot={snapshot({
          runs: [run(), run({ id: 'run-amazon', unit: 'amazon', status: 'completed', percent: 100 })],
        })}
      />,
    );

    // RUNS are what finish; STAGES are what queue. Twelve runs carry status
    // `running` on this batch and exactly one of them is doing anything, so
    // "12 running" would be the most misleading number on the page.
    expect(screen.getByText('1 of 2 sources')).toBeInTheDocument();
    expect(screen.getByText(/stage running/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for the importer/)).toBeInTheDocument();
    expect(screen.getByText(/done/)).toBeInTheDocument();
    // Percent, elapsed and records ride one line: the region is height-capped,
    // and the bar under them carries no readout of its own for the same reason.
    expect(screen.getByText('55% · 1h 6m elapsed')).toBeInTheDocument();
  });

  it('expands a run into the full pipeline card rather than duplicating it', () => {
    render(<ImportActivityCard snapshot={snapshot()} />);

    // Collapsed: the dense one-line-per-stage view.
    expect(screen.queryByText('Expand the archive you uploaded')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Expanded: RunPipeline, the same component History and the wizard render,
    // with its per-stage blurbs and detail.
    expect(screen.getByText('Expand the archive you uploaded')).toBeInTheDocument();
    expect(screen.getByText('Copy its photos, videos and voicemails into storage')).toBeInTheDocument();
  });

  it('labels the media stage, which had no label and an empty blurb', () => {
    render(<ImportActivityCard snapshot={snapshot()} />);

    // On a photo export this is the LONGEST leg of the import (weight 30
    // against parse's 35) and it rendered as the raw word "media".
    expect(screen.getByText('Store files')).toBeInTheDocument();
  });
});
