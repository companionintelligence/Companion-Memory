import { ApiError } from '../client';
import { pushCommand } from '../commands/push';
import { CliError } from '../context';
import { buildProgram } from '../program';

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

  it('refuses a bad --timeout before pushing anything', async () => {
    const asked: Array<string[] | undefined> = [];
    const ctx = harness({
      listUnpushed: async () => [unpushed('run-1')],
      startPush: async (runIds?: string[]) => {
        asked.push(runIds);

        return { runs: [unpushed('run-1')] };
      },
    });

    await expect(pushCommand(ctx, { wait: true, timeout: 'abc' })).rejects.toBeInstanceOf(CliError);
    expect(asked).toEqual([]);
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

/**
 * `ci push --run <id> --retry-failed` — the way back for rows a finished push
 * could not write. The case that motivated it: a Postgres crash-restart during
 * a Takeout push left 437 rows `failed` with "the database system is in
 * recovery mode", on a run the plain `push` will never offer again because it
 * already has a push stage.
 */
describe('ci push --retry-failed', () => {
  const RUN = '68bffe0a-1dbe-4783-a226-49149f45ec4f';

  const detail = (id: string, status: string) => ({ ...unpushed(id, { status }), stages: [] });

  it('re-queues the named run and says how many rows went back', async () => {
    const asked: string[] = [];
    const ctx = harness({
      retryFailedPush: async (runId: string) => {
        asked.push(runId);

        return { items: 437, entities: 0, requeued: true };
      },
    });

    await pushCommand(ctx, { run: [RUN], retryFailed: true });

    // The retry route, never Sync: `listUnpushed` is not stubbed and would throw.
    expect(asked).toEqual([RUN]);
    expect(ctx.term.text()).toContain('437');
    expect(ctx.term.text()).toContain('1 run(s) queued for push; 437 item(s) and 0 entit(ies)');
  });

  it('follows the re-queued run to its close-out with --wait', async () => {
    const polled: string[] = [];
    const ctx = harness({
      retryFailedPush: async () => ({ items: 437, entities: 0, requeued: true }),
      getRun: async (runId: string) => {
        polled.push(runId);

        return detail(runId, 'completed');
      },
    });

    await pushCommand(ctx, { run: [RUN], retryFailed: true, wait: true });

    expect(polled).toEqual([RUN]);
    expect(ctx.term.text()).toContain('completed');
  });

  it('says so when nothing was stranded, and does not wait on a run it did not re-queue', async () => {
    // `getRun` is not stubbed: a wait here would throw.
    const ctx = harness({ retryFailedPush: async () => ({ items: 0, entities: 0, requeued: false }) });

    await pushCommand(ctx, { run: [RUN], retryFailed: true, wait: true });

    expect(ctx.term.text()).toContain('Nothing to retry');
  });

  it('says the push stage itself is run again when no row had failed', async () => {
    // The appliance re-drives a push that FAILED with nothing marked failed —
    // rows still pending after an outage, or none left and it died closing
    // out. "0 item(s) moved" alone read like the retry had done nothing.
    const ctx = harness({ retryFailedPush: async () => ({ items: 0, entities: 0, requeued: true }) });

    await pushCommand(ctx, { run: [RUN], retryFailed: true });

    expect(ctx.term.text()).toContain('queued (stage re-run)');
    expect(ctx.term.text()).toContain(
      '1 of them had no failed rows: the push itself did not finish, and is run again.',
    );
    expect(ctx.term.text()).not.toContain('Nothing to retry');
  });

  it('does not say "nothing to retry" about runs it was refused', async () => {
    const ctx = harness({
      retryFailedPush: async () => {
        throw new ApiError(
          409,
          `Import run ${RUN} did not finish staging: its parse stage is cancelled.`,
          '/x',
        );
      },
    });

    await expect(pushCommand(ctx, { run: [RUN], retryFailed: true })).rejects.toBeInstanceOf(CliError);
    expect(ctx.term.errorText()).toContain('did not finish staging');
    expect(ctx.term.text()).not.toContain('Nothing to retry');
  });

  it('needs the run it is retrying', async () => {
    const ctx = harness({});

    await expect(pushCommand(ctx, { retryFailed: true })).rejects.toBeInstanceOf(CliError);
    await expect(pushCommand(ctx, { retryFailed: true })).rejects.toThrow(/--run <id> --retry-failed/);
  });

  it('refuses --dry-run rather than silently resetting rows', async () => {
    const ctx = harness({});

    await expect(pushCommand(ctx, { run: [RUN], retryFailed: true, dryRun: true })).rejects.toThrow(
      /does not take --dry-run/,
    );
  });

  it('reports a run still pushing, carries on with the others, and exits non-zero', async () => {
    const ctx = harness({
      retryFailedPush: async (runId: string) => {
        if (runId === 'run-busy') {
          throw new ApiError(409, 'Import run run-busy is still pushing (its push stage is running).', '/x');
        }

        return { items: 5, entities: 1, requeued: true };
      },
    });

    const failure = await pushCommand(ctx, { run: ['run-busy', 'run-2'], retryFailed: true }).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain('1 of 2 run(s) could not be retried');
    // Something did go back to the queue, so this is the partial-success code.
    expect((failure as CliError).exitCode).toBe(2);
    expect(ctx.term.errorText()).toContain('still pushing');
    expect(ctx.term.text()).toContain('1 run(s) queued for push');
  });

  it('lets an appliance fault through rather than reporting it as a refusal', async () => {
    const ctx = harness({
      retryFailedPush: async () => {
        throw new ApiError(500, 'Internal server error', '/x');
      },
    });

    await expect(pushCommand(ctx, { run: [RUN], retryFailed: true })).rejects.toBeInstanceOf(ApiError);
  });

  it('is wired as a flag on `ci push`', async () => {
    const asked: string[] = [];
    const ctx = harness({
      retryFailedPush: async (runId: string) => {
        asked.push(runId);

        return { items: 1, entities: 0, requeued: true };
      },
    });
    const program = buildProgram({ term: ctx.term, makeClient: () => ctx.client }).exitOverride();

    await program.parseAsync(['node', 'ci', 'push', '--run', RUN, '--retry-failed']);

    expect(asked).toEqual([RUN]);
  });
});
