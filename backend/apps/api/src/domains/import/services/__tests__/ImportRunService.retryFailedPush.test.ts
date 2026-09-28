import { ConflictException } from '@nestjs/common';

import { ImportRunService } from '../ImportRunService';

/**
 * The operator's way back for a push's casualties, over a fake ledger.
 *
 * `failedPushRecovery.integration.spec.ts` asserts the SQL against real
 * Postgres; this pins the DECISIONS, which are what an operator relies on and
 * what a real-database suite that is skipped when no database is reachable
 * cannot guard on every machine:
 *
 *  - refuse while any stage of the run is still working — resetting rows under
 *    a push that is running would hand the same rows to two writers;
 *  - reset failed rows in both lanes and re-queue the run's own push stage;
 *  - ALSO re-drive a push that failed with its rows still pending and none
 *    marked failed — the shape PushStage now leaves when the database stays
 *    away past its wait — so one command recovers both;
 *  - never start a push that did not run at all: that belongs to the stage
 *    that stopped it, or to Sync.
 */

const RUN_ID = '68bffe0a-0000-4000-8000-000000000001';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PUSH_STAGE_ID = '44444444-4444-4444-8444-444444444444';

interface State {
  liveKind?: string | null;
  liveStatus?: string | null;
  pushStageId?: string | null;
  pushStatus?: string | null;
  hadPending?: boolean;
}

function serviceOver(options: {
  owned?: boolean;
  state?: State;
  failed?: { staged_items?: number; staged_entities?: number };
}) {
  const statements: string[] = [];

  const manager = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql);

      if (sql.includes('FOR UPDATE OF r')) {
        return options.owned === false ? [] : [{ id: RUN_ID }];
      }

      if (sql.includes('AS "liveKind"')) {
        return [
          {
            liveKind: null,
            liveStatus: null,
            pushStageId: PUSH_STAGE_ID,
            pushStatus: 'completed',
            hadPending: false,
            ...options.state,
          },
        ];
      }

      const reset = /UPDATE ci_import\.(staged_items|staged_entities)/.exec(sql);

      if (reset) {
        const count = options.failed?.[reset[1] as 'staged_items' | 'staged_entities'] ?? 0;

        return Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
      }

      if (sql.includes('UPDATE ci_import.import_stages') || sql.includes('UPDATE ci_import.import_runs')) {
        return [{ id: 'x' }];
      }

      throw new Error(`unexpected statement: ${sql}`);
    }),
  };

  const dataSource = {
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
    // Outside the transaction: the percent rollup, after commit.
    query: jest.fn(async () => []),
  };
  const events = { send: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  const service = new ImportRunService(dataSource as never, events as never, {} as never, logger as never);

  const startPush = jest.spyOn(service, 'startPush').mockResolvedValue([]);

  return { service, statements, events, dataSource, startPush };
}

const ctx = { userId: USER_ID };

describe('ImportRunService.retryFailedPush', () => {
  it('is a 404 for a run that is not the caller’s', async () => {
    const { service, statements } = serviceOver({ owned: false });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toBeNull();
    // Nothing past the ownership lock.
    expect(statements).toHaveLength(1);
  });

  it('refuses while the push is running, and resets nothing', async () => {
    const { service, statements, events } = serviceOver({
      state: { liveKind: 'push', liveStatus: 'running', pushStatus: 'running' },
      failed: { staged_items: 437 },
    });

    const refusal = await service.retryFailedPush(ctx, RUN_ID).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as Error).message).toMatch(/still pushing/);
    expect(statements.some((sql) => /UPDATE ci_import\.staged_/.test(sql))).toBe(false);
    expect(events.send).not.toHaveBeenCalled();
  });

  it('refuses while an earlier stage of an unfinished run is still to come', async () => {
    const { service } = serviceOver({ state: { liveKind: 'parse', liveStatus: 'queued' } });

    await expect(service.retryFailedPush(ctx, RUN_ID)).rejects.toThrow(/its parse stage is queued/);
  });

  it('resets both lanes and re-queues the run’s own push stage', async () => {
    // Run 68bffe0a on the live corpus: 437 rows failed with 57P03 during a
    // Postgres crash-restart, push stage completed, run `partial`.
    const { service, statements, events, dataSource, startPush } = serviceOver({
      failed: { staged_items: 437, staged_entities: 2 },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 437, entities: 2, requeued: true });

    // The same stage, reopened — not a second one appended.
    expect(statements.some((sql) => sql.includes('UPDATE ci_import.import_stages'))).toBe(true);
    expect(
      statements.some((sql) => sql.includes("SET status = 'queued', error = NULL, finished_at = NULL")),
    ).toBe(true);
    expect(startPush).not.toHaveBeenCalled();

    // Enqueued on the push queue, after the rollup, outside the transaction.
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(events.send).toHaveBeenCalledTimes(1);
    expect(events.send.mock.calls[0]).toEqual([
      expect.anything(),
      { runId: RUN_ID, stageId: PUSH_STAGE_ID, userId: USER_ID },
      { queue: 'import-push', singletonKey: PUSH_STAGE_ID },
    ]);
  });

  it('re-drives a push that failed with its rows still pending and none marked failed', async () => {
    // What PushStage now leaves behind when the database stays away past its
    // wait: a failed stage, every unwritten row `pending`, nothing quarantined.
    const { service, events } = serviceOver({
      state: { pushStatus: 'failed', hadPending: true },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 0, entities: 0, requeued: true });
    expect(events.send).toHaveBeenCalledTimes(1);
  });

  it('leaves a completed push with nothing failed alone', async () => {
    const { service, statements, events } = serviceOver({
      state: { pushStatus: 'completed', hadPending: false },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 0, entities: 0, requeued: false });
    expect(statements.some((sql) => sql.includes('UPDATE ci_import.import_stages'))).toBe(false);
    expect(events.send).not.toHaveBeenCalled();
  });

  it('does not start a push that never ran, even with rows pending', async () => {
    // An earlier stage failed and the push was left queued behind it in a
    // finished run. Starting it here would jump the stage that stopped it.
    const { service, events, startPush } = serviceOver({
      state: { pushStatus: 'queued', hadPending: true },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 0, entities: 0, requeued: false });
    expect(events.send).not.toHaveBeenCalled();
    expect(startPush).not.toHaveBeenCalled();
  });

  it('appends a push, after commit, when failed rows exist and no push stage does', async () => {
    const { service, startPush } = serviceOver({
      state: { pushStageId: null, pushStatus: null },
      failed: { staged_items: 3 },
    });

    startPush.mockResolvedValue([{ run: {}, stage: {} }] as never);

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 3, entities: 0, requeued: true });
    expect(startPush).toHaveBeenCalledWith(ctx, { runIds: [RUN_ID] });
  });
});
