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
 *    that stopped it, or to Sync — and never push ahead of a stage that did
 *    not finish (a run cancelled mid-parse);
 *  - re-open the push stage only from the state that was read, because
 *    `retryStage` and a claiming worker move it without the run lock.
 */

const RUN_ID = '68bffe0a-0000-4000-8000-000000000001';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PUSH_STAGE_ID = '44444444-4444-4444-8444-444444444444';

interface State {
  liveKind?: string | null;
  liveStatus?: string | null;
  upstreamId?: string | null;
  upstreamKind?: string | null;
  upstreamStatus?: string | null;
  upstreamAbandoned?: boolean | null;
  pushStageId?: string | null;
  pushStatus?: string | null;
  pushRan?: boolean | null;
  hadPending?: boolean;
}

function serviceOver(options: {
  owned?: boolean;
  state?: State;
  failed?: { staged_items?: number; staged_entities?: number };
  /** The guarded reopen found the push stage where it was read. Default true. */
  reopened?: boolean;
}) {
  const statements: string[] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const manager = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      calls.push({ sql, params });

      if (sql.includes('FOR UPDATE OF r')) {
        return options.owned === false ? [] : [{ id: RUN_ID }];
      }

      if (sql.includes('AS "liveKind"')) {
        return [
          {
            liveKind: null,
            liveStatus: null,
            upstreamId: null,
            upstreamKind: null,
            upstreamStatus: null,
            upstreamAbandoned: null,
            pushStageId: PUSH_STAGE_ID,
            pushStatus: 'completed',
            pushRan: true,
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

      if (sql.includes('UPDATE ci_import.import_stages')) {
        return options.reopened === false ? [] : [{ id: PUSH_STAGE_ID }];
      }

      if (sql.includes('UPDATE ci_import.import_runs')) {
        return [{ id: RUN_ID }];
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

  const resets = () => statements.filter((sql) => /UPDATE ci_import\.staged_/.test(sql));

  return { service, statements, calls, resets, events, dataSource, startPush };
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
      state: { pushStatus: 'failed', pushRan: true, hadPending: true },
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

  it('refuses a push that never ran behind a failed earlier stage, and names that stage', async () => {
    // An earlier stage failed and the push was left queued behind it in a
    // finished run. Starting it here would jump the stage that stopped it —
    // and answering "nothing to retry" would leave the operator no way on.
    const MEDIA_STAGE_ID = '55555555-5555-4555-8555-555555555555';
    const { service, resets, events, startPush } = serviceOver({
      state: {
        upstreamId: MEDIA_STAGE_ID,
        upstreamKind: 'media',
        upstreamStatus: 'failed',
        upstreamAbandoned: false,
        pushStatus: 'queued',
        pushRan: false,
        hadPending: true,
      },
      failed: { staged_items: 3 },
    });

    const refusal = await service.retryFailedPush(ctx, RUN_ID).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as Error).message).toMatch(/its media stage is failed/);
    expect((refusal as Error).message).toContain(`/stages/${MEDIA_STAGE_ID}/retry`);
    expect(resets()).toEqual([]);
    expect(events.send).not.toHaveBeenCalled();
    expect(startPush).not.toHaveBeenCalled();
  });

  it('refuses a run cancelled mid-parse rather than push ahead of the parse', async () => {
    // cancel() closes the run and cancels its QUEUED stages — the push among
    // them — while the parse it interrupted has staged only part of the
    // archive. Re-driving that push would close the run over half an import.
    const { service, resets, events } = serviceOver({
      state: {
        upstreamId: '66666666-6666-4666-8666-666666666666',
        upstreamKind: 'parse',
        upstreamStatus: 'cancelled',
        upstreamAbandoned: false,
        pushStatus: 'cancelled',
        pushRan: false,
        hadPending: true,
      },
    });

    const refusal = await service.retryFailedPush(ctx, RUN_ID).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as Error).message).toMatch(/did not finish staging: its parse stage is cancelled/);
    expect(resets()).toEqual([]);
    expect(events.send).not.toHaveBeenCalled();
  });

  it('says so when the stage ahead was abandoned rather than failed', async () => {
    const { service } = serviceOver({
      state: {
        upstreamId: '66666666-6666-4666-8666-666666666666',
        upstreamKind: 'parse',
        upstreamStatus: 'running',
        upstreamAbandoned: true,
        pushStatus: 'cancelled',
        pushRan: false,
      },
    });

    await expect(service.retryFailedPush(ctx, RUN_ID)).rejects.toThrow(
      /parse stage was left 'running' by a worker that is gone/,
    );
  });

  it('refuses a push that was cancelled before it ran, even with failed rows from an earlier attempt', async () => {
    // Its failed rows date from a push that failed, was re-queued, and was
    // then cancelled while it waited. Re-driving it here would un-cancel the
    // run behind the user's back; the stage retry is the explicit way.
    const { service, resets, events } = serviceOver({
      state: { pushStatus: 'cancelled', pushRan: false, hadPending: true },
      failed: { staged_items: 2 },
    });

    const refusal = await service.retryFailedPush(ctx, RUN_ID).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as Error).message).toMatch(/push stage is cancelled and never ran/);
    expect((refusal as Error).message).toContain(`/stages/${PUSH_STAGE_ID}/retry`);
    expect(resets()).toEqual([]);
    expect(events.send).not.toHaveBeenCalled();
  });

  it('re-drives a push that failed after every row settled, rather than answer "nothing to retry"', async () => {
    // The push died in its close-out, with no row pending and none failed. The
    // run stays `failed` until the push completes, so "nothing to retry" was
    // a dead end.
    const { service, events } = serviceOver({
      state: { pushStatus: 'failed', pushRan: true, hadPending: false },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 0, entities: 0, requeued: true });
    expect(events.send).toHaveBeenCalledTimes(1);
  });

  it('re-drives a push left running in a run cancel() closed while its worker died', async () => {
    // The state query no longer counts that stage as live (see the next case);
    // it ran, it did not finish, and nothing else will ever move it.
    const { service, events } = serviceOver({
      state: { pushStatus: 'running', pushRan: true, hadPending: true },
    });

    expect(await service.retryFailedPush(ctx, RUN_ID)).toEqual({ items: 0, entities: 0, requeued: true });
    expect(events.send).toHaveBeenCalledTimes(1);
  });

  it('does not count a running stage as live once its run is closed and it has gone silent', async () => {
    const { service, calls } = serviceOver({ failed: { staged_items: 1 } });

    await service.retryFailedPush(ctx, RUN_ID);

    const state = calls.find((call) => call.sql.includes('AS "liveKind"'))!;

    // Running is live in an unfinished run, or while something still touches
    // it — the recovery sweep's own staleness window, bound as a parameter.
    expect(state.sql).toMatch(
      /s\.status = 'running'\s+AND \(r\.finished_at IS NULL\s+OR s\.updated_at >= now\(\) - make_interval\(mins => \$2::int\)\)/,
    );
    expect(state.params).toEqual([RUN_ID, 10]);
  });

  it('re-opens the push stage only from the state it read, and bumps its heartbeat', async () => {
    const { service, calls } = serviceOver({ failed: { staged_items: 4 } });

    await service.retryFailedPush(ctx, RUN_ID);

    const reopen = calls.find((call) => call.sql.includes('UPDATE ci_import.import_stages'))!;

    expect(reopen.sql).toMatch(/status IN \('completed', 'failed'\)/);
    expect(reopen.sql).toMatch(/status = 'running' AND updated_at < now\(\)/);
    // Fresh, so the recovery sweep does not read it as a job lost ten minutes ago.
    expect(reopen.sql).toMatch(/updated_at = now\(\)/);
  });

  it('refuses, resetting nothing, when the push stage moved between the read and the reopen', async () => {
    // `retryStage` re-queued it and a worker may already hold it; flipping it
    // back to `queued` would hand it to a second worker.
    const { service, dataSource, events } = serviceOver({
      failed: { staged_items: 4 },
      reopened: false,
    });

    const refusal = await service.retryFailedPush(ctx, RUN_ID).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as Error).message).toMatch(/push stage changed while this retry was running/);
    // Thrown INSIDE the transaction, so the row reset rolls back with it.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(events.send).not.toHaveBeenCalled();
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
