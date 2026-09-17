import { ORCHESTRATE_STAGES } from '../wire';

import { backfillCommand, BACKFILL_STAGES } from '../commands/backfill';
import { CliError } from '../context';

import { harness } from './support/harness';

describe('ci backfill', () => {
  it('knows exactly the legs the orchestrator knows, in its order', () => {
    // The compiler already enforces the set (STAGE_HELP is keyed by
    // OrchestrateStage); this pins the ORDER, which the `--list` output claims
    // is the order they run in.
    expect(BACKFILL_STAGES).toEqual([...ORCHESTRATE_STAGES]);
  });

  it('--list describes every leg', async () => {
    const ctx = harness({});

    await backfillCommand(ctx, [], { list: true });

    for (const stage of ORCHESTRATE_STAGES) {
      expect(ctx.term.text()).toContain(stage);
    }

    expect(ctx.term.text()).toContain('Naming none runs them all');
  });

  it('runs the named legs and tables the outcome', async () => {
    const asked: unknown[] = [];
    const ctx = harness({
      orchestrate: async (stages: string[] | undefined) => {
        asked.push(stages);

        return {
          ok: true,
          totalDurationMs: 61_000,
          legs: [{ leg: 'geocode', ok: true, durationMs: 1000, result: { updated: 12 } }],
        };
      },
    });

    await backfillCommand(ctx, ['geocode']);

    expect(asked).toEqual([['geocode']]);
    expect(ctx.term.text()).toContain('updated=12');
    expect(ctx.term.text()).toContain('All legs ok in 1m1s.');
  });

  it('passes no stage list at all when none are named, so the server runs its canonical chain', async () => {
    const asked: unknown[] = [];
    const ctx = harness({
      orchestrate: async (stages: string[] | undefined) => {
        asked.push(stages);

        return { ok: true, totalDurationMs: 0, legs: [] };
      },
    });

    await backfillCommand(ctx, []);

    expect(asked).toEqual([undefined]);
  });

  it('refuses a stage the orchestrator does not have', async () => {
    const ctx = harness({});

    await expect(backfillCommand(ctx, ['geocode', 'teleport'])).rejects.toBeInstanceOf(CliError);
    await expect(backfillCommand(ctx, ['teleport'])).rejects.toThrow(/backfill --list/);
  });

  it('is fail-soft: a failed leg is reported, and the exit code says so', async () => {
    const ctx = harness({
      orchestrate: async () => ({
        ok: false,
        totalDurationMs: 2000,
        legs: [
          { leg: 'geocode', ok: false, durationMs: 500, error: 'geocoder unreachable' },
          { leg: 'search_index', ok: true, durationMs: 1500, result: { embedded: 900 } },
        ],
      }),
    });

    await expect(backfillCommand(ctx, [])).rejects.toMatchObject({ exitCode: 1 });
    expect(ctx.term.text()).toContain('geocoder unreachable');
    expect(ctx.term.text()).toContain('embedded=900');
    expect(ctx.term.text()).toContain('Some legs failed');
  });

  it('echoes leg-start lines from the stream', async () => {
    const ctx = harness({
      orchestrate: async (
        _stages: string[] | undefined,
        options: { onLine?: (line: Record<string, unknown>) => void },
      ) => {
        options.onLine?.({ type: 'leg-start', leg: 'geocode', index: 1, of: 1 });
        options.onLine?.({ type: 'tick', at: 'now' });

        return { ok: true, totalDurationMs: 10, legs: [] };
      },
    });

    await backfillCommand(ctx, ['geocode']);

    expect(ctx.term.text()).toContain('→ geocode (1/1)');
    // A heartbeat is plumbing, not news.
    expect(ctx.term.text()).not.toContain('tick');
  });
});
