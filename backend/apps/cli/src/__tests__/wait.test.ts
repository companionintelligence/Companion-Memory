import type { RunDetail, StageSummary } from '../wire';
import { ApiError, UnreachableError } from '../client';
import {
  waitForRuns,
  WaitTimeoutError,
  WaitUnreachableError,
  TERMINAL_RUN_STATUSES,
  MAX_CONSECUTIVE_POLL_FAILURES,
} from '../wait';

import { harness } from './support/harness';

const detail = (status: string, percent: number, stages: Array<Partial<StageSummary>> = []): RunDetail => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  label: null,
  source: 'cli',
  dataSources: [],
  declaredSources: null,
  status,
  percent,
  requestedStages: [],
  error: null,
  createdAt: '1970-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  stages: stages as StageSummary[],
});

describe('waitForRuns', () => {
  it('treats partial as terminal — a half-parsed archive still imported something', () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed', 'partial']);
  });

  it('polls until the run closes and returns its final state', async () => {
    const states = ['queued', 'running', 'completed'];
    const ctx = harness({ getRun: async () => detail(states.shift() ?? 'completed', 100) });

    const finished = await waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined });

    expect(finished).toHaveLength(1);
    expect(finished[0].status).toBe('completed');
  });

  it('prints only when something changed, so a log file stays readable', async () => {
    const states = ['running', 'running', 'running', 'completed'];
    const ctx = harness({ getRun: async () => detail(states.shift() ?? 'completed', 50) });

    await waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined });

    // Three identical polls collapse to one line; the close is the second.
    expect(ctx.term.lines).toHaveLength(2);
  });

  it('names the stage and its counters while one is running', async () => {
    const states = ['running', 'completed'];
    const ctx = harness({
      getRun: async () =>
        detail(states.shift() ?? 'completed', 30, [
          { seq: 0, kind: 'parse', status: 'running', phase: 'gmail', processed: 40, total: 100 },
        ]),
    });

    await waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined });

    expect(ctx.term.text()).toContain('parse/gmail 40/100');
  });

  it('costs nothing when the run is already finished', async () => {
    let polls = 0;
    const ctx = harness({
      getRun: async () => {
        polls += 1;

        return detail('completed', 100);
      },
    });

    await waitForRuns(ctx.client, ctx.term, ['run-1'], {
      sleep: async () => {
        throw new Error('must not sleep');
      },
    });

    expect(polls).toBe(1);
  });

  it('gives up on --timeout with an id to follow up on', async () => {
    let clock = 0;
    const ctx = harness({ getRun: async () => detail('running', 10) });

    await expect(
      waitForRuns(ctx.client, ctx.term, ['run-1'], {
        sleep: async () => {
          clock += 5000;
        },
        now: () => clock,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it('stops following a run that disappears rather than spinning forever', async () => {
    const ctx = harness({
      getRun: async () => {
        throw new ApiError(404, 'not found', '/api/import/runs/gone');
      },
    });

    await expect(
      waitForRuns(ctx.client, ctx.term, ['gone'], { sleep: async () => undefined }),
    ).resolves.toEqual([]);
  });

  it('rides out a restart instead of calling the run finished', async () => {
    // The appliance refuses connections for a few polls — a deploy, a worker
    // recycling — and then answers again. The run was never in doubt.
    const answers: Array<() => RunDetail> = [
      () => detail('running', 40),
      () => {
        throw new UnreachableError('http://localhost:3030', new Error('ECONNREFUSED'));
      },
      () => {
        throw new UnreachableError('http://localhost:3030', new Error('ECONNREFUSED'));
      },
      () => detail('completed', 100),
    ];
    const ctx = harness({ getRun: async () => (answers.shift() ?? (() => detail('completed', 100)))() });

    const finished = await waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined });

    expect(finished).toHaveLength(1);
    expect(finished[0].status).toBe('completed');
  });

  it('raises rather than reporting success when the appliance stops answering', async () => {
    // THE incident: every poll failure was swallowed, the run was dropped from
    // the wait set, and `import --wait` exited 0 while the push was at 14%.
    const ctx = harness({
      getRun: async () => {
        throw new UnreachableError('http://localhost:3030', new Error('ECONNREFUSED'));
      },
    });

    await expect(
      waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(WaitUnreachableError);
  });

  it('gives the appliance every retry before it gives up', async () => {
    let polls = 0;
    const ctx = harness({
      getRun: async () => {
        polls += 1;

        throw new ApiError(502, 'bad gateway', '/api/import/runs/run-1');
      },
    });

    await expect(
      waitForRuns(ctx.client, ctx.term, ['run-1'], { sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(WaitUnreachableError);

    expect(polls).toBe(MAX_CONSECUTIVE_POLL_FAILURES);
  });

  it('prefixes lines with a run id when following more than one', async () => {
    const ctx = harness({ getRun: async (id: string) => ({ ...detail('completed', 100), id }) });

    await waitForRuns(ctx.client, ctx.term, ['aaaaaaaa-1', 'bbbbbbbb-2'], { sleep: async () => undefined });

    expect(ctx.term.text()).toContain('[aaaaaaaa]');
    expect(ctx.term.text()).toContain('[bbbbbbbb]');
  });
});
