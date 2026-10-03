import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ImportStageListener } from '../listeners/ImportStageListener';
import type { ImportRunService } from '../services/ImportRunService';
import { DatabaseCrashedDuringPushError } from '../stages/DatabaseCrashedDuringPushError';
import { StagedWriter } from '../staging/StagedWriter';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A ROW THE PUSH COULD NOT WRITE MUST HAVE A WAY BACK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 297 rows were sitting at `push_status = 'failed'` on the dev appliance with
 * nothing in the product able to reach them, and three separate mechanisms
 * each independently closed the door:
 *
 *  - `PushStage` reads `push_status = 'pending'`, so it never reconsiders a
 *    failed row — that is the resumability design, and it is right;
 *  - `PUSH_ELIGIBLE_WHERE` excludes any run that already has a push stage AT
 *    ANY STATUS, so the Sync card never offers the run again;
 *  - `retryStage` only accepts a stage at `failed`/`cancelled`, and the push
 *    that stranded these rows COMPLETED — a push that writes 461,000 records
 *    and misses 297 is a success by every measure the stage has.
 *
 * The first half of this spec pins those three closed doors, because they are
 * each correct on their own and the trap is what they add up to. The second
 * half is the door that was missing.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/failedPushRecovery.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`failed push rows (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let dataSource: DataSource;
  let events: { send: jest.Mock };
  let service: ImportRunService;
  let userId: string;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
    ({ dataSource, events, service, userId } = harness);
  });

  afterAll(async () => {
    await teardown();
  });

  /**
   * A run whose push COMPLETED having failed some of its rows — the exact
   * shape the appliance was found in.
   */
  async function runWithFailedRows(): Promise<{ runId: string; pushStageId: string }> {
    const dropId = await harness.stageDrop('export.zip');
    const { run, stages } = await harness.startRunForDrop(dropId, ['unpack', 'parse', 'push']);
    const writer = new StagedWriter(dataSource.manager, {
      userId,
      runId: run.id,
      dataSource: 'google_photos',
    });

    for (const suffix of ['a', 'b', 'c']) {
      writer.push({
        item: {
          id: `photo-${run.id.slice(0, 8)}-${suffix}`,
          classification: 'photo',
          timestamp: new Date('2012-07-04T10:00:00Z'),
          content: { filename: `IMG-${suffix}.jpg` },
        },
      });
    }

    // One staged person too: `pushEntities` marks its casualties the same way,
    // and an unresolved person costs every record that names them.
    writer.push({ entity: { name: 'Alice', attributes: [{ name: 'email', value: 'alice@example.com' }] } });

    await writer.settled();

    for (const stage of stages) {
      expect(await service.beginStage(stage.id)).toBe(true);
      await service.completeStage(stage.id, { processed: 3, total: 4, detail: { failed: 2 } });
    }

    // Two items and the entity land where a real push would have left them.
    await dataSource.query(
      `UPDATE ci_import.staged_items
          SET push_status = 'failed', push_error = 'no space left on device'
        WHERE id IN (SELECT id FROM ci_import.staged_items WHERE run_id = $1::uuid ORDER BY id LIMIT 2)`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE ci_import.staged_items SET push_status = 'pushed', pushed_at = now()
        WHERE run_id = $1::uuid AND push_status = 'pending'`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE ci_import.staged_entities SET push_status = 'failed', push_error = 'graph ingest refused'
        WHERE run_id = $1::uuid`,
      [run.id],
    );

    await service.advance(userId, run.id, stages[stages.length - 1].seq);

    return { runId: run.id, pushStageId: stages[2].id };
  }

  async function pushStatuses(runId: string): Promise<{ items: string[]; entities: string[] }> {
    const items = await dataSource.query<Array<{ push_status: string }>>(
      `SELECT push_status FROM ci_import.staged_items WHERE run_id = $1::uuid ORDER BY id`,
      [runId],
    );
    const entities = await dataSource.query<Array<{ push_status: string }>>(
      `SELECT push_status FROM ci_import.staged_entities WHERE run_id = $1::uuid ORDER BY id`,
      [runId],
    );

    return {
      items: items.map((row) => row.push_status),
      entities: entities.map((row) => row.push_status),
    };
  }

  async function stageRow(stageId: string): Promise<{ status: string; processed: string }> {
    const [row] = await dataSource.query(
      `SELECT status, processed FROM ci_import.import_stages WHERE id = $1::uuid`,
      [stageId],
    );

    return row;
  }

  /**
   * A three-stage run with one staged message, its unpack completed and the
   * rest untouched — the starting point for the cancelled-run cases.
   */
  async function runWithOnePendingRow(name: string) {
    const dropId = await harness.stageDrop(name);
    const { run, stages } = await harness.startRunForDrop(dropId, ['unpack', 'parse', 'push']);
    const writer = new StagedWriter(dataSource.manager, {
      userId,
      runId: run.id,
      dataSource: 'google_voice',
    });

    writer.push({
      item: {
        id: `sms-${run.id.slice(0, 8)}`,
        classification: 'message',
        timestamp: new Date('2019-03-01T09:00:00Z'),
        metadata: { Text: 'see you at six' },
      },
    });
    await writer.settled();

    expect(await service.beginStage(stages[0].id)).toBe(true);
    await service.completeStage(stages[0].id, { processed: 1, total: 1, detail: {} });

    return { runId: run.id, unpack: stages[0], parse: stages[1], push: stages[2] };
  }

  async function runRow(runId: string): Promise<{ status: string; finished_at: string | null }> {
    const [row] = await dataSource.query(
      `SELECT status, finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
      [runId],
    );

    return row;
  }

  describe('the trap', () => {
    it('leaves the rows unreachable by every other route', async () => {
      const { runId, pushStageId } = await runWithFailedRows();

      expect((await pushStatuses(runId)).items).toEqual(
        expect.arrayContaining(['failed', 'failed', 'pushed']),
      );

      // Sync does not offer the run: it already has a push stage.
      const unpushed = await service.listUnpushed({ userId });

      expect(unpushed.find((entry) => entry.run.id === runId)).toBeUndefined();
      expect(await service.startPush({ userId }, { runIds: [runId] })).toEqual([]);

      // And the stage retry refuses, because the stage did not fail.
      expect(await service.retryStage({ userId }, runId, pushStageId)).toBe(false);
    });
  });

  describe('retryFailedPush', () => {
    it('resets both lanes to pending and re-queues the run push stage', async () => {
      const { runId, pushStageId } = await runWithFailedRows();

      events.send.mockClear();

      const result = await service.retryFailedPush({ userId }, runId);

      expect(result).toEqual({ items: 2, entities: 1, requeued: true });

      const after = await pushStatuses(runId);

      // Only the failures move. A row already `pushed` must not be re-sent —
      // the destinations upsert, but re-walking a 460k-row import to re-decide
      // what is already there is the cost the per-row ledger exists to avoid.
      expect(after.items.filter((status) => status === 'pending')).toHaveLength(2);
      expect(after.items.filter((status) => status === 'pushed')).toHaveLength(1);
      expect(after.entities).toEqual(['pending']);

      const [row] = await dataSource.query<Array<{ push_error: string | null }>>(
        `SELECT push_error FROM ci_import.staged_items
          WHERE run_id = $1::uuid AND push_status = 'pending' LIMIT 1`,
        [runId],
      );

      // Cleared, so a second failure records its own reason rather than the first's.
      expect(row.push_error).toBeNull();

      // The stage is runnable again — `beginStage` only claims a `queued` stage,
      // so anything else would make the next job a no-op.
      expect(await stageRow(pushStageId)).toMatchObject({ status: 'queued' });

      const [runAfter] = await dataSource.query<Array<{ status: string; finished_at: string | null }>>(
        `SELECT status, finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
        [runId],
      );

      expect(runAfter).toMatchObject({ status: 'queued', finished_at: null });
      expect(events.send).toHaveBeenCalledTimes(1);
      expect(events.send.mock.calls[0][1]).toMatchObject({ runId, stageId: pushStageId, userId });
    });

    it('re-queues the SAME push stage rather than appending a second one', async () => {
      const { runId } = await runWithFailedRows();

      await service.retryFailedPush({ userId }, runId);

      const pushStages = await dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM ci_import.import_stages WHERE run_id = $1::uuid AND kind = 'push'`,
        [runId],
      );

      // A second row would double the weight the percent rollup divides by, and
      // leave the bar reading half done over a finished import.
      expect(pushStages).toHaveLength(1);
    });

    it('is a no-op when nothing is stranded, rather than an error', async () => {
      const dropId = await harness.stageDrop('clean.zip');
      const { run, stages } = await harness.startRunForDrop(dropId, ['unpack', 'parse']);

      for (const stage of stages) {
        expect(await service.beginStage(stage.id)).toBe(true);
        await service.completeStage(stage.id, { processed: 1, total: 1, detail: {} });
      }

      events.send.mockClear();

      expect(await service.retryFailedPush({ userId }, run.id)).toEqual({
        items: 0,
        entities: 0,
        requeued: false,
      });
      expect(events.send).not.toHaveBeenCalled();
    });

    it('refuses while the push is running, and leaves the rows where they are', async () => {
      const { runId, pushStageId } = await runWithFailedRows();

      // A push in flight — its worker owns the stage and is reading `pending`.
      await dataSource.query(
        `UPDATE ci_import.import_stages SET status = 'running', finished_at = NULL WHERE id = $1::uuid`,
        [pushStageId],
      );

      events.send.mockClear();

      await expect(service.retryFailedPush({ userId }, runId)).rejects.toBeInstanceOf(ConflictException);
      expect((await pushStatuses(runId)).items).toEqual(
        expect.arrayContaining(['failed', 'failed', 'pushed']),
      );
      expect(await stageRow(pushStageId)).toMatchObject({ status: 'running' });
      expect(events.send).not.toHaveBeenCalled();
    });

    it('re-drives a push that FAILED with its rows still pending', async () => {
      // The shape PushStage now leaves when the database stays away past its
      // wait: the stage fails, nothing is quarantined, every row is `pending`.
      const dropId = await harness.stageDrop('outage.zip');
      const { run, stages } = await harness.startRunForDrop(dropId, ['unpack', 'parse', 'push']);
      const writer = new StagedWriter(dataSource.manager, {
        userId,
        runId: run.id,
        dataSource: 'google_voice',
      });

      writer.push({
        item: {
          id: `sms-${run.id.slice(0, 8)}`,
          classification: 'message',
          timestamp: new Date('2019-03-01T09:00:00Z'),
          metadata: { Text: 'see you at six' },
        },
      });
      await writer.settled();

      for (const stage of stages.slice(0, 2)) {
        expect(await service.beginStage(stage.id)).toBe(true);
        await service.completeStage(stage.id, { processed: 1, total: 1, detail: {} });
      }

      expect(await service.beginStage(stages[2].id)).toBe(true);
      await service.failStage(
        stages[2].id,
        'the database was unavailable for 151s while reading the next batch',
      );

      events.send.mockClear();

      expect(await service.retryFailedPush({ userId }, run.id)).toEqual({
        items: 0,
        entities: 0,
        requeued: true,
      });
      expect(await stageRow(stages[2].id)).toMatchObject({ status: 'queued' });
      expect(events.send).toHaveBeenCalledTimes(1);
    });

    it('closes the run `completed` once the re-driven push writes every row', async () => {
      const { runId, pushStageId } = await runWithFailedRows();

      await service.retryFailedPush({ userId }, runId);

      // The re-driven push, as the worker would run it: every reset row lands.
      expect(await service.beginStage(pushStageId)).toBe(true);
      await dataSource.query(
        `UPDATE ci_import.staged_items SET push_status = 'pushed', pushed_at = now()
          WHERE run_id = $1::uuid AND push_status = 'pending'`,
        [runId],
      );
      await dataSource.query(
        `UPDATE ci_import.staged_entities SET push_status = 'pushed', pushed_at = now()
          WHERE run_id = $1::uuid AND push_status = 'pending'`,
        [runId],
      );
      await service.completeStage(pushStageId, {
        processed: 4,
        total: 4,
        partial: false,
        detail: { failed: 0 },
      });

      const [push] = await dataSource.query<Array<{ seq: number }>>(
        `SELECT seq FROM ci_import.import_stages WHERE id = $1::uuid`,
        [pushStageId],
      );

      expect(await service.advance(userId, runId, push.seq)).toBeNull();

      const [runAfter] = await dataSource.query<Array<{ status: string; finished_at: string | null }>>(
        `SELECT status, finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
        [runId],
      );

      // Recomputed by the ordinary close-out, which the reopen made run again.
      expect(runAfter.status).toBe('completed');
      expect(runAfter.finished_at).not.toBeNull();
    });

    it('refuses a run cancelled mid-parse, rather than push ahead of the unfinished parse', async () => {
      // cancel() closes the run and cancels its QUEUED stages — the push among
      // them — but not the parse that is running; that one's worker then dies
      // with the archive half staged. Re-driving the push here would close the
      // run over half an import.
      const { runId, parse, push } = await runWithOnePendingRow('cancel-mid-parse.zip');

      expect(await service.beginStage(parse.id)).toBe(true);
      expect(await service.cancel({ userId }, runId)).toBe(true);
      await service.failStage(parse.id, 'worker exited mid-parse');

      events.send.mockClear();

      await expect(service.retryFailedPush({ userId }, runId)).rejects.toThrow(
        /did not finish staging: its parse stage is failed/,
      );
      expect(await stageRow(push.id)).toMatchObject({ status: 'cancelled' });
      expect(await runRow(runId)).toMatchObject({ status: 'cancelled' });
      expect((await pushStatuses(runId)).items).toEqual(['pending']);
      expect(events.send).not.toHaveBeenCalled();
    });

    it('refuses a push that was cancelled before it ran', async () => {
      const { runId, parse, push } = await runWithOnePendingRow('cancel-before-push.zip');

      expect(await service.beginStage(parse.id)).toBe(true);
      await service.completeStage(parse.id, { processed: 1, total: 1, detail: {} });
      expect(await service.cancel({ userId }, runId)).toBe(true);

      events.send.mockClear();

      await expect(service.retryFailedPush({ userId }, runId)).rejects.toThrow(
        /push stage is cancelled and never ran/,
      );
      expect(await stageRow(push.id)).toMatchObject({ status: 'cancelled' });
      expect(await runRow(runId)).toMatchObject({ status: 'cancelled' });
      expect(events.send).not.toHaveBeenCalled();
    });

    it('re-drives a push that failed after every row settled', async () => {
      // The push died in its close-out: nothing pending, nothing failed, and
      // the run `failed` until the push completes.
      const { runId, parse, push } = await runWithOnePendingRow('closeout.zip');

      expect(await service.beginStage(parse.id)).toBe(true);
      await service.completeStage(parse.id, { processed: 1, total: 1, detail: {} });
      expect(await service.beginStage(push.id)).toBe(true);
      await dataSource.query(
        `UPDATE ci_import.staged_items SET push_status = 'pushed', pushed_at = now() WHERE run_id = $1::uuid`,
        [runId],
      );
      await service.failStage(push.id, 'the push stage died while summarizing');

      events.send.mockClear();

      expect(await service.retryFailedPush({ userId }, runId)).toEqual({
        items: 0,
        entities: 0,
        requeued: true,
      });
      expect(await stageRow(push.id)).toMatchObject({ status: 'queued' });
      expect(events.send).toHaveBeenCalledTimes(1);
    });

    it('does not refuse forever a push left running when cancel() raced its worker dying', async () => {
      const { runId, pushStageId } = await runWithFailedRows();

      // The run is closed, and the push stage still says `running` — silent
      // past the recovery sweep's window, which only reclaims stages of runs
      // that are NOT finished. Nothing will ever move it but this.
      await dataSource.query(
        `UPDATE ci_import.import_stages
            SET status = 'running', finished_at = NULL, updated_at = now() - interval '11 minutes'
          WHERE id = $1::uuid`,
        [pushStageId],
      );

      events.send.mockClear();

      expect(await service.retryFailedPush({ userId }, runId)).toEqual({
        items: 2,
        entities: 1,
        requeued: true,
      });

      const [stage] = await dataSource.query<Array<{ status: string; fresh: boolean }>>(
        `SELECT status, updated_at > now() - interval '1 minute' AS fresh
           FROM ci_import.import_stages WHERE id = $1::uuid`,
        [pushStageId],
      );

      // Re-queued, and FRESH: the recovery sweep must read it as a stage that
      // was just queued, not as one whose job was lost ten minutes ago.
      expect(stage).toEqual({ status: 'queued', fresh: true });
      expect(events.send).toHaveBeenCalledTimes(1);
    });

    it('is scoped to the caller — another user cannot revive this run', async () => {
      const { runId } = await runWithFailedRows();

      expect(await service.retryFailedPush({ userId: crypto.randomUUID() }, runId)).toBeNull();
      expect((await pushStatuses(runId)).items).toEqual(
        expect.arrayContaining(['failed', 'failed', 'pushed']),
      );
    });
  });

  /**
   * A push whose write crashed the database fails its stage at once, rows
   * `pending` (PushStage never resends a statement the database went down
   * under). What must then NOT happen is the job system running it again on
   * its own — each run of a poison write is another crash of the whole
   * appliance's database. The way back is a person's: `--retry-failed`.
   */
  describe('a push the database crashed under', () => {
    /** The sweep is appliance-wide; a parallel suite's runs can ride along. */
    function sendsFor(runId: string): Array<Record<string, unknown>> {
      return events.send.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .filter((payload) => payload.runId === runId);
    }

    async function age(stageId: string): Promise<void> {
      await dataSource.query(
        `UPDATE ci_import.import_stages SET updated_at = now() - interval '20 minutes' WHERE id = $1::uuid`,
        [stageId],
      );
    }

    async function runReadyToPush(name: string) {
      const run = await runWithOnePendingRow(name);

      expect(await service.beginStage(run.parse.id)).toBe(true);
      await service.completeStage(run.parse.id, { processed: 1, total: 1, detail: {} });

      return run;
    }

    it('is recorded failed through the recovery, left alone by the sweep and a redelivery, and re-driven on request', async () => {
      const { runId, push } = await runReadyToPush('crashed-push.zip');
      const crash = new DatabaseCrashedDuringPushError(
        runId,
        'writing 1 communications record(s)',
        new Error('Connection terminated unexpectedly'),
      );
      const pushRunner = {
        kind: 'push' as const,
        run: jest.fn(async () => {
          throw crash;
        }),
      };
      const idle = (kind: string) => ({ kind, run: jest.fn() });
      const listener = new ImportStageListener(
        service,
        { ensureDir: jest.fn(async () => '/tmp/unused'), reclaim: jest.fn() } as never,
        idle('unpack') as never,
        idle('parse') as never,
        idle('media') as never,
        pushRunner as never,
        {
          setContext: jest.fn(),
          log: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
          error: jest.fn(),
        } as never,
      );

      listener.failureRecordRetry = {
        initialDelayMs: 1,
        maxDelayMs: 1,
        budgetMs: 5_000,
        resendAfterCrash: true,
      };

      // The worker's next statement after the crash reaches a server still in
      // crash recovery — twice — before it takes the record.
      const recovering = () =>
        Object.assign(new Error('the database system is in recovery mode'), { code: '57P03' });
      const failStage = jest
        .spyOn(service, 'failStage')
        .mockRejectedValueOnce(recovering())
        .mockRejectedValueOnce(recovering());
      const payload = { runId, stageId: push.id, userId };

      await expect(listener.runStage(payload)).rejects.toBe(crash);
      expect(failStage).toHaveBeenCalledTimes(3);
      failStage.mockRestore();

      // Recorded, with the way back in it, and the row still `pending`.
      const [stage] = await dataSource.query<Array<{ status: string; error: string }>>(
        `SELECT status, error FROM ci_import.import_stages WHERE id = $1::uuid`,
        [push.id],
      );

      expect(stage.status).toBe('failed');
      expect(stage.error).toContain(`ci push --run ${runId} --retry-failed`);
      expect(await runRow(runId)).toMatchObject({ status: 'failed' });
      expect((await pushStatuses(runId)).items).toEqual(['pending']);

      // The recovery sweep does not re-run it, however stale it reads…
      await age(push.id);
      events.send.mockClear();
      await service.resumeInterrupted();

      expect(sendsFor(runId)).toEqual([]);
      expect(await stageRow(push.id)).toMatchObject({ status: 'failed' });

      // …nor does pg-boss redelivering the job (retryLimit 3 on every queue):
      // the delivery finds the run finished and completes as nothing to do.
      await expect(listener.runStage(payload)).resolves.toBe('skipped');
      expect(pushRunner.run).toHaveBeenCalledTimes(1);

      // A person re-drives it once the database is healthy.
      expect(await service.retryFailedPush({ userId }, runId)).toEqual({
        items: 0,
        entities: 0,
        requeued: true,
      });
      expect(await stageRow(push.id)).toMatchObject({ status: 'queued' });
      expect(sendsFor(runId).map((sent) => sent.stageId)).toEqual([push.id]);
    });

    it('is re-run by the sweep if the failure is never recorded — why the worker waits to record it', async () => {
      // The shape the worker left before it waited: the failure write met the
      // recovering database and was dropped, so the stage still says `running`.
      const { runId, push } = await runReadyToPush('crashed-push-unrecorded.zip');

      expect(await service.beginStage(push.id)).toBe(true);
      await age(push.id);
      events.send.mockClear();

      await service.resumeInterrupted();

      // Queued again with nobody asking: for a poison write, one more crash
      // every sweep.
      expect(await stageRow(push.id)).toMatchObject({ status: 'queued' });
      expect(sendsFor(runId).map((sent) => sent.stageId)).toEqual([push.id]);
    });
  });
});
