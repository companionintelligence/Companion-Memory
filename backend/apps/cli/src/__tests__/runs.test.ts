import { runsCommand } from '../commands/runs';
import { CliError } from '../context';

import { harness } from './support/harness';

const summary = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  label: 'takeout.zip',
  source: 'cli',
  dataSources: ['google_photos'],
  declaredSources: null,
  status: 'running',
  percent: 42,
  requestedStages: ['unpack', 'parse', 'media', 'push'],
  error: null,
  createdAt: '2026-08-16T10:00:00Z',
  startedAt: '2026-08-16T10:00:05Z',
  finishedAt: null,
  ...overrides,
});

const stage = (overrides = {}) => ({
  id: 'stage-1',
  seq: 0,
  kind: 'unpack',
  status: 'completed',
  phase: null,
  processed: 10,
  total: 10,
  weight: 20,
  itemsPerSec: 2,
  etaSeconds: null,
  durationMs: 5000,
  error: null,
  detail: {},
  startedAt: '2026-08-16T10:00:05Z',
  finishedAt: '2026-08-16T10:00:10Z',
  ...overrides,
});

describe('ci runs', () => {
  it('lists runs newest-first as the server returned them', async () => {
    const ctx = harness({ listRuns: async () => [summary()] });

    await runsCommand(ctx, undefined);

    expect(ctx.term.text()).toContain('takeout.zip');
    expect(ctx.term.text()).toContain('running');
    expect(ctx.term.text()).toContain('google_photos');
  });

  it('says so plainly when there are none', async () => {
    const ctx = harness({ listRuns: async () => [] });

    await runsCommand(ctx, undefined);

    expect(ctx.term.text()).toContain('No import runs yet.');
  });

  it('refuses a non-numeric --limit', async () => {
    const ctx = harness({ listRuns: async () => [] });

    await expect(runsCommand(ctx, undefined, { limit: 'lots' })).rejects.toBeInstanceOf(CliError);
  });

  it('shows the stage bar for one run', async () => {
    const ctx = harness({
      getRun: async () => ({
        ...summary(),
        stages: [
          stage(),
          stage({ id: 'stage-2', seq: 1, kind: 'parse', status: 'running', total: null, processed: 3 }),
        ],
      }),
    });

    await runsCommand(ctx, 'run-1');

    const text = ctx.term.text();

    expect(text).toContain('unpack');
    expect(text).toContain('parse');
    expect(text).toContain('unpack → parse → media → push');
    // A null total is "not yet countable" and must not read as zero.
    expect(text).toContain('?');
  });

  it('follows one run to a terminal state with --wait', async () => {
    const statuses = ['running', 'completed'];
    const ctx = harness({
      getRun: async () => ({
        ...summary({ status: statuses.shift() ?? 'completed', percent: 100 }),
        stages: [stage()],
      }),
    });

    await runsCommand(ctx, 'run-1', { wait: true, timeout: '30' });

    expect(ctx.term.text()).toContain('completed');
  });
});
