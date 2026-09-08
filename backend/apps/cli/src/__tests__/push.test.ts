import { pushCommand } from '../commands/push';
import { CliError } from '../context';

import { harness } from './support/harness';

const unpushed = (id: string, overrides = {}) => ({
  id,
  label: 'takeout.zip',
  source: 'cli',
  dataSources: ['gmail'],
  declaredSources: null,
  status: 'completed',
  percent: 100,
  requestedStages: ['unpack', 'parse', 'media'],
  error: null,
  createdAt: '2026-08-16T10:00:00Z',
  startedAt: '2026-08-16T10:00:00Z',
  finishedAt: '2026-08-16T11:00:00Z',
  pendingItems: 1200,
  pendingEntities: 40,
  ...overrides,
});

describe('ci push', () => {
  it('appends a push stage to every eligible run', async () => {
    const asked: Array<string[] | undefined> = [];
    const ctx = harness({
      listUnpushed: async () => [unpushed('run-1'), unpushed('run-2')],
      startPush: async (runIds?: string[]) => {
        asked.push(runIds);

        return { runs: [unpushed('run-1'), unpushed('run-2')] };
      },
    });

    await pushCommand(ctx);

    expect(asked).toEqual([undefined]);
    expect(ctx.term.text()).toContain('2 run(s) queued for push.');
  });

  it('“nothing to push” is a state, not an error', async () => {
    const ctx = harness({ listUnpushed: async () => [] });

    await pushCommand(ctx);

    expect(ctx.term.text()).toContain('Nothing is waiting to be pushed.');
  });

  it('--dry-run lists what is pending and starts nothing', async () => {
    const ctx = harness({ listUnpushed: async () => [unpushed('run-1')] });

    await pushCommand(ctx, { dryRun: true });

    expect(ctx.term.text()).toContain('1200');
    expect(ctx.term.text()).toContain('40');
  });

  it('explains why a named run is not eligible instead of silently skipping it', async () => {
    const ctx = harness({ listUnpushed: async () => [unpushed('run-1')] });

    await expect(pushCommand(ctx, { run: ['run-9'] })).rejects.toBeInstanceOf(CliError);
    await expect(pushCommand(ctx, { run: ['run-9'] })).rejects.toThrow(/parse has completed/);
  });

  it('restricts the push to the runs named', async () => {
    const asked: Array<string[] | undefined> = [];
    const ctx = harness({
      listUnpushed: async () => [unpushed('run-1'), unpushed('run-2')],
      startPush: async (runIds?: string[]) => {
        asked.push(runIds);

        return { runs: [unpushed('run-1')] };
      },
    });

    await pushCommand(ctx, { run: ['run-1'] });

    expect(asked).toEqual([['run-1']]);
  });
});
