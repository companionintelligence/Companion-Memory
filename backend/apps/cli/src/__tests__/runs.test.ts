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

  it.each(['-1', '0', '2.5', ''])(
    'refuses --limit %j, which is not a whole number of runs',
    async (limit) => {
      const listRuns = vi.fn(async () => []);
      const ctx = harness({ listRuns });

      await expect(runsCommand(ctx, undefined, { limit })).rejects.toBeInstanceOf(CliError);
      expect(listRuns).not.toHaveBeenCalled();
    },
  );

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

  /**
   * The reproduction: a worker restarted mid-parse, the stage froze at 8141
   * with no error, and `ci runs` went on saying `running` — the run row's
   * status is a cache that cannot see a worker die. The server's `stalled`
   * flag can, and the CLI has to say it where a person is looking.
   */
  it('marks a run with a silent stage as stalled in the list', async () => {
    const ctx = harness({
      listRuns: async () => [
        summary({ id: 'run-a', stalled: true }),
        summary({ id: 'run-b', label: 'lyft.zip' }),
      ],
    });

    await runsCommand(ctx, undefined);

    const lines = ctx.term.text().split('\n');

    expect(lines.find((line) => line.startsWith('run-a'))).toContain('running (stalled)');
    expect(lines.find((line) => line.startsWith('run-b'))).not.toContain('stalled');
  });

  it('says which stage stalled, for how long, and what happens next', async () => {
    const heartbeatAt = new Date(Date.now() - 4 * 60_000 - 12_000).toISOString();
    const ctx = harness({
      getRun: async () => ({
        ...summary({ stalled: true }),
        stages: [
          stage(),
          stage({
            id: 'stage-2',
            seq: 1,
            kind: 'parse',
            status: 'running',
            processed: 8141,
            total: null,
            durationMs: null,
            heartbeatAt,
            stalled: true,
          }),
        ],
      }),
    });

    await runsCommand(ctx, 'run-1');

    const text = ctx.term.text();

    expect(text).toContain('status running (stalled)');
    expect(text).toMatch(/^\s*1\s+parse\s+stalled\s/m);
    expect(text).toMatch(/parse stalled: no heartbeat for 4m1[12]s/);
    expect(text).toContain('retried automatically within minutes');
  });

  it('explains a stage that is queued again because its worker died', async () => {
    const ctx = harness({
      getRun: async () => ({
        ...summary(),
        stages: [
          stage(),
          stage({
            id: 'stage-2',
            seq: 1,
            kind: 'parse',
            status: 'queued',
            processed: 0,
            total: null,
            durationMs: null,
            detail: {
              interrupted: {
                at: '2026-09-29T19:24:40.123456+00:00',
                reason: 'worker stopped heartbeating',
                processed: 8141,
                retry: 1,
                retryLimit: 3,
              },
            },
          }),
        ],
      }),
    });

    await runsCommand(ctx, 'run-1');

    expect(ctx.term.text()).toContain(
      'parse was interrupted at 8141 processed (2026-09-29 19:24): its worker stopped heartbeating. ' +
        'Queued for retry 1 of 3.',
    );
  });

  it('reads an older server with no liveness fields as nothing to report', async () => {
    const ctx = harness({
      getRun: async () => ({ ...summary(), stages: [stage({ status: 'running', total: null })] }),
    });

    await runsCommand(ctx, 'run-1');

    expect(ctx.term.text()).not.toContain('stalled');
    expect(ctx.term.text()).not.toContain('interrupted');
  });

  it('refuses a bad --timeout before fetching or printing the run', async () => {
    // `getRun` is not stubbed: fetching the run first would throw a different error.
    const ctx = harness({});

    await expect(runsCommand(ctx, 'run-1', { wait: true, timeout: 'abc' })).rejects.toThrow(
      '--timeout takes a number of seconds, not "abc"',
    );
    expect(ctx.term.text()).toBe('');
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
