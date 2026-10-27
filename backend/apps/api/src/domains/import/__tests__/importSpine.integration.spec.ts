import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import type { ImportRunService } from '../services/ImportRunService';
import { CONTACT_IDENTIFIER_KEYS, CONTACT_NAMES_KEY } from '../staging/identity';
import { StagedWriter } from '../staging/StagedWriter';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SPINE AND THE STAGING WRITES, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here is SQL that typechecks perfectly and can still be wrong:
 *
 *  - three `ON CONFLICT ... WHERE` clauses whose partial-index inference either
 *    matches an index or raises at runtime;
 *  - two `NULLS NOT DISTINCT` relationship indexes that must NOT collapse edges
 *    pointing at different items — the exact failure PR 2 split them to avoid;
 *  - a `startRun` whose whole correctness claim is that a lost drop claim takes
 *    its run row with it, which only a real transaction can demonstrate;
 *  - a weighted percent rollup written as one statement.
 *
 * A mocked repository would agree with whatever these statements claimed, which
 * is why none of it is mocked. Connection, schema check and cleanup come from
 * `support/stagingHarness`; its header documents the isolation rules.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/importSpine.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`the import spine (${importDatabase.target})`, () => {
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

  const stageDrop = (filename?: string) => harness.stageDrop(filename);
  const startRun = (dropId: string) => harness.startRunForDrop(dropId);

  // -------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------

  describe('startRun', () => {
    it('creates the run, its stage bar, and claims the drop in one go', async () => {
      const dropId = await stageDrop('Takeout.zip');
      const { run, stages } = await startRun(dropId);

      expect(run.status).toBe('queued');
      expect(run.label).toBe('Takeout.zip');
      // Four, since the media stage joined IMPORT_STAGE_KINDS: the default is
      // taken from that list rather than restated, so a new kind reaches every
      // new run without anything here having to be told.
      expect(stages.map((stage) => stage.kind)).toEqual(['unpack', 'parse', 'media', 'push']);
      expect(stages.map((stage) => stage.seq)).toEqual([0, 1, 2, 3]);

      // The stage bar is recorded up front so the UI can draw the whole thing on
      // the first poll instead of growing it a box at a time.
      expect(run.requestedStages).toEqual(['unpack', 'parse', 'media', 'push']);

      const [drop] = await dataSource.query<Array<{ status: string; run_id: string }>>(
        `SELECT status, run_id FROM ci_import.staged_sources WHERE user_id = $1::uuid AND drop_id = $2`,
        [userId, dropId],
      );

      expect(drop.status).toBe('claimed');
      expect(drop.run_id).toBe(run.id);
    });

    it('enqueues only the FIRST stage — later ones are chained by the worker', async () => {
      events.send.mockClear();

      const { stages } = await startRun(await stageDrop());

      expect(events.send).toHaveBeenCalledTimes(1);
      expect(events.send.mock.calls[0][1]).toMatchObject({ stageId: stages[0].id });
    });

    it('lets exactly one of two racing starts win, leaving no orphan run', async () => {
      const dropId = await stageDrop();

      await startRun(dropId);

      const runsBefore = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.import_runs WHERE user_id = $1::uuid`,
        [userId],
      );

      await expect(service.startRun({ userId }, { dropId })).rejects.toThrow(/already been claimed/);

      const runsAfter = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.import_runs WHERE user_id = $1::uuid`,
        [userId],
      );

      // The whole point of doing the claim inside the transaction: the loser's
      // run row must not survive its lost claim.
      expect(runsAfter[0].count).toBe(runsBefore[0].count);
    });

    it('refuses to start on an upload that does not exist', async () => {
      await expect(service.startRun({ userId }, { dropId: randomUUID() })).rejects.toThrow(
        /No staged upload/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  describe('the services a run is named after', () => {
    it('reads back the array the parse stage stamped on the run', async () => {
      // The column is `data_sources` and the property is `dataSources`. That gap
      // is exactly where a driver row once arrived snake_cased and the upload
      // endpoint answered `dropId is required`, so the mapping is asserted
      // against a real row rather than assumed.
      const { run } = await startRun(await stageDrop('All Data Categories.zip'));

      await dataSource.query(
        `UPDATE ci_import.import_runs SET data_sources = $2::text[] WHERE id = $1::uuid`,
        [run.id, ['audible', 'amazon', 'prime_video']],
      );

      const listed = (await service.listRuns({ userId })).find((entry) => entry.id === run.id);

      expect(listed?.dataSources).toEqual(['audible', 'amazon', 'prime_video']);
    });

    it('is an empty array on a run that has not parsed yet, not null', async () => {
      // So a reader never has to tell "no services" apart from "not known yet";
      // the run's status already says which.
      const { run } = await startRun(await stageDrop());
      const listed = (await service.listRuns({ userId })).find((entry) => entry.id === run.id);

      expect(listed?.dataSources).toEqual([]);
    });
  });

  describe('stage transitions', () => {
    it('claims a queued stage once, and refuses the redelivery', async () => {
      const { stages } = await startRun(await stageDrop());

      expect(await service.beginStage(stages[0].id)).toBe(true);
      expect(await service.beginStage(stages[0].id)).toBe(false);
    });

    it('records progress while a stage runs', async () => {
      // The first thing every stage runner does. It went unexercised, and the
      // statement it runs failed against a real driver on the first tick:
      // `$2` fed both `processed` (bigint) and a division (double precision),
      // which Postgres refuses to deduce one type for.
      const { stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.recordProgress(stages[0].id, { processed: 3, total: 10, phase: 'extracting' });

      const [after] = await dataSource.query<
        Array<{ processed: string; total: string; phase: string; items_per_sec: number | null }>
      >(`SELECT processed, total, phase, items_per_sec FROM ci_import.import_stages WHERE id = $1::uuid`, [
        stages[0].id,
      ]);

      expect(Number(after.processed)).toBe(3);
      expect(Number(after.total)).toBe(10);
      expect(after.phase).toBe('extracting');
    });

    it('leaves a total alone when a tick does not know one', async () => {
      // An unpack ticks with no denominator; that must not wipe a total a
      // previous tick established.
      const { stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.recordProgress(stages[0].id, { processed: 1, total: 5 });
      await service.recordProgress(stages[0].id, { processed: 2 });

      const [after] = await dataSource.query<Array<{ processed: string; total: string }>>(
        `SELECT processed, total FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(Number(after.processed)).toBe(2);
      expect(Number(after.total)).toBe(5);
    });

    it('weights the percent rollup by stage rather than counting stages', async () => {
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.completeStage(stages[0].id, { processed: 1, total: 1, detail: {} });

      const [after] = await dataSource.query<Array<{ percent: number }>>(
        `SELECT percent FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      // unpack is 20 of the run's 100 weight (20 + 35 + 30 + 15), not 1 of 4.
      expect(after.percent).toBe(20);
    });

    it('normalizes the rollup by the run’s OWN stages, not an assumed 100', async () => {
      // The wizard starts parse-only runs (unpack + parse, weights 20 + 35).
      // If the rollup divided by a fixed 100 instead of SUM(weight), this run
      // would crawl to 20% and jump to 100 at the finish line — the divisor
      // has to be the 55 the run actually materialized: 100·20/55 = 36.
      const { run, stages } = await harness.startRunForDrop(await stageDrop(), ['unpack', 'parse']);

      await service.beginStage(stages[0].id);
      await service.completeStage(stages[0].id, { processed: 1, total: 1, detail: {} });

      const [after] = await dataSource.query<Array<{ percent: number }>>(
        `SELECT percent FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(after.percent).toBe(36);
    });

    it('ends a run partial when a stage reported partial, not failed', async () => {
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      // `partial` is a SIBLING of `detail` on `StageOutcome` — the shape every
      // real stage runner returns (UnpackStage, ParseStage, MediaStage,
      // PushStage all set the top-level field, never a nested `detail.partial`).
      await service.completeStage(stages[0].id, {
        processed: 1,
        total: 1,
        partial: true,
        detail: { rejected: [{ archive: 'part-2.zip', reason: 'truncated' }] },
      });
      await service.beginStage(stages[1].id);
      await service.completeStage(stages[1].id, { processed: 3, total: 3, detail: {} });
      await service.finishRun(run.id);

      const [finished] = await dataSource.query<Array<{ status: string; percent: number }>>(
        `SELECT status, percent FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(finished.status).toBe('partial');
      expect(finished.percent).toBe(100);
    });

    it('leaves a run completed when no stage reported partial', async () => {
      // The other half of the wiring: a stage's own `detail` fields must not be
      // mistaken for the sibling `partial` flag `finishRun` actually rolls up
      // on. Regression guard for the bug where `completeStage` never persisted
      // `outcome.partial` anywhere `finishRun` read it, so this always passed
      // for the wrong reason — nothing ever reported partial at all.
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.completeStage(stages[0].id, { processed: 1, total: 1, detail: { rejected: [] } });
      await service.beginStage(stages[1].id);
      await service.completeStage(stages[1].id, { processed: 3, total: 3, detail: {} });
      await service.finishRun(run.id);

      const [finished] = await dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(finished.status).toBe('completed');
    });

    it('fails the run when a stage fails', async () => {
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.failStage(stages[0].id, 'unzip: cannot find central directory');

      const [failed] = await dataSource.query<Array<{ status: string; error: string }>>(
        `SELECT status, error FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/central directory/);
      expect(await service.isFinished(run.id)).toBe(true);
    });

    it('records the phase a stage failed in, not the last one a progress write kept', async () => {
      const { stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.recordProgress(stages[0].id, { processed: 0, total: 1, phase: 'acquiring' });
      // The runner moved on to `extracting` but the row never heard (the
      // listener's throttle used to drop that write). The failure's context
      // is what knows where it was.
      await service.failStage(
        stages[0].id,
        'unpack [phase=extracting file=export.zip] cannot unpack export.zip',
        {
          stage: 'unpack',
          phase: 'extracting',
          file: 'export.zip',
          message: 'cannot unpack export.zip',
        },
      );

      expect((await service.getStage(stages[0].id))?.phase).toBe('extracting');
    });

    it('keeps the recorded phase when there is no failure context', async () => {
      const { stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.recordProgress(stages[0].id, { processed: 0, total: 1, phase: 'acquiring' });
      await service.failStage(stages[0].id, 'unreadable');

      expect((await service.getStage(stages[0].id))?.phase).toBe('acquiring');
    });

    it.each([
      ['names no phase', { stage: 'unpack', message: 'unreadable', name: 'Error' }],
      ['names an empty phase', { stage: 'unpack', phase: '', message: 'unreadable', name: 'Error' }],
    ])('keeps the recorded phase when the failure %s', async (_case, failure) => {
      const { stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.recordProgress(stages[0].id, { processed: 0, total: 1, phase: 'acquiring' });
      await service.failStage(stages[0].id, 'unpack unreadable', failure);

      expect((await service.getStage(stages[0].id))?.phase).toBe('acquiring');
    });

    it('cancels queued stages but leaves a running one to its worker', async () => {
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);

      expect(await service.cancel({ userId }, run.id)).toBe(true);

      const rows = await dataSource.query<Array<{ seq: number; status: string }>>(
        `SELECT seq, status FROM ci_import.import_stages WHERE run_id = $1::uuid ORDER BY seq`,
        [run.id],
      );

      // Marking the running stage cancelled underneath its worker would make the
      // row lie while the work continued.
      expect(rows[0].status).toBe('running');
      expect(rows[1].status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  describe('resumeInterrupted', () => {
    /**
     * The sweep is deliberately appliance-wide, so a parallel suite's runs can
     * ride along in `events.send`. Every assertion here filters by run id
     * rather than counting calls.
     */
    function sendsFor(runId: string): Array<Record<string, unknown>> {
      return events.send.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .filter((payload) => payload.runId === runId);
    }

    /**
     * Make a stage read as abandoned. Every recovery gate is a staleness test
     * on `updated_at` — a live stage is touched by progress writes and the
     * listener's heartbeat, so silence is what death looks like.
     */
    async function age(stageId: string): Promise<void> {
      await dataSource.query(
        `UPDATE ci_import.import_stages SET updated_at = now() - interval '20 minutes' WHERE id = $1::uuid`,
        [stageId],
      );
    }

    it('requeues a stage a dead process left running, and re-enqueues its run', async () => {
      const { run, stages } = await startRun(await stageDrop());

      // The crash: claimed, then the process died — which reads as a claim
      // that has gone silent past the staleness window.
      expect(await service.beginStage(stages[0].id)).toBe(true);
      await age(stages[0].id);
      events.send.mockClear();

      await service.resumeInterrupted();

      const [stage] = await dataSource.query<Array<{ status: string; started_at: string | null }>>(
        `SELECT status, started_at FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(stage.status).toBe('queued');
      expect(stage.started_at).toBeNull();
      expect(sendsFor(run.id).map((payload) => payload.stageId)).toEqual([stages[0].id]);

      // And the requeued stage is claimable again — the whole point.
      expect(await service.beginStage(stages[0].id)).toBe(true);
    });

    it('never takes back a stage the calling process says it is running, however silent', async () => {
      // A process KNOWS its own work is alive. Silence past the window used to
      // be enough on its own: a parser that blocked the event loop — or a
      // database away for longer than the window — lost its stage to the very
      // process running it.
      const { run, stages } = await startRun(await stageDrop());

      expect(await service.beginStage(stages[0].id)).toBe(true);
      await age(stages[0].id);
      events.send.mockClear();

      await service.resumeInterrupted({ liveStageIds: [stages[0].id] });

      const [stage] = await dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(stage.status).toBe('running');
      expect(sendsFor(run.id)).toEqual([]);
    });

    it('fences out the claim it takes back', async () => {
      // The worker it judged dead may only have been slow. Its token is cleared
      // with the reclaim, so its progress, completion and failure all miss —
      // rather than landing in the attempt that replaces it.
      const { stages } = await startRun(await stageDrop());
      const token = await service.claimStage(stages[0].id);

      expect(token).not.toBeNull();
      await age(stages[0].id);

      await service.resumeInterrupted();

      expect(await service.touchStage(stages[0].id, token!)).toBe(false);
      expect(await service.recordProgress(stages[0].id, { processed: 5 }, token!)).toBe(false);
      expect(await service.completeStage(stages[0].id, { processed: 5, total: 5, detail: {} }, token!)).toBe(
        false,
      );

      const [stage] = await dataSource.query<Array<{ status: string; claim_token: string | null }>>(
        `SELECT status, claim_token FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(stage).toEqual({ status: 'queued', claim_token: null });
    });

    it('leaves a LIVE claim alone, however it got there', async () => {
      // The failure the staleness gate exists for, observed in the wild: a dev
      // restart leaked the old process, its push loop was alive and writing
      // progress, and a sweep that assumed "running at boot means orphaned"
      // requeued the stage out from under it — two executors then interleaved
      // progress with different totals. A claim touched inside the window
      // belongs to somebody.
      const { run, stages } = await startRun(await stageDrop());

      expect(await service.beginStage(stages[0].id)).toBe(true);
      events.send.mockClear();

      await service.resumeInterrupted();

      const [stage] = await dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(stage.status).toBe('running');
      expect(sendsFor(run.id)).toEqual([]);
    });

    it('enqueues the queued stage a crash left jobless', async () => {
      // The crash landed between completeStage and the enqueue of the next
      // stage: nothing is running, the next stage is queued, no job carries it.
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await service.completeStage(stages[0].id, { processed: 1, total: 1, detail: {} });

      // Fresh, the queued stage is just waiting its turn in the queue and must
      // not collect a duplicate job from every sweep.
      events.send.mockClear();
      await service.resumeInterrupted();
      expect(sendsFor(run.id)).toEqual([]);

      await age(stages[1].id);
      await service.resumeInterrupted();

      expect(sendsFor(run.id).map((payload) => payload.stageId)).toEqual([stages[1].id]);
    });

    it('keys every stage job on its stage id, so a waiting stage cannot collect duplicates', async () => {
      // The staleness gate above cannot actually distinguish "waiting its turn"
      // from "its job was lost": both look like a queued stage nothing has
      // touched, because nothing touches a stage while it waits. Stage jobs run
      // at localConcurrency 1 appliance-wide, so on a real multi-source import
      // that wait is long — a measured 13-source run had a single Google Takeout
      // parse hold the worker for 45 minutes, and the twelve stages queued
      // behind it had accumulated 107 pending jobs across 16 stage ids.
      //
      // pg-boss refuses the duplicate at insert time when the send carries a
      // singletonKey, which is why the key is asserted here rather than the
      // sweep being taught a distinction it has no data for.
      const { run, stages } = await startRun(await stageDrop());

      events.send.mockClear();
      await age(stages[0].id);
      await service.resumeInterrupted();

      const call = events.send.mock.calls.find(
        (each) => (each[1] as Record<string, unknown>).runId === run.id,
      );

      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ singletonKey: stages[0].id });
    });

    it('never enqueues past a stage that is still RUNNING', async () => {
      // The data-loss regression this exists to stop, observed on a real
      // 13-source import of a full personal-data corpus:
      //
      //   unpack  completed 03:34:53
      //   parse   started   03:45:08   <- waited ten minutes for its queue slot
      //   media   started   03:45:40   completed 0/0
      //   push    started   03:49:00   completed 0/0
      //   run     completed, percent 100, finished 03:49:00 — while parse ran on
      //
      // `media` and `push` had been queued since 03:34:50, so by the time parse
      // finally started they were long past STALE_STAGE_MINUTES. parse going
      // RUNNING removed it from the queued set, `media` became the first queued
      // stage, and the sweep enqueued it. The Google Takeout run reported
      // success and landed ZERO of its 703,956 items.
      //
      // Waiting for the stage in front of you is indistinguishable from a lost
      // job if you only look at staleness — nothing touches a waiting stage.
      const { run, stages } = await startRun(await stageDrop());

      // Stage 0 is executing; stages 1..n are queued and long stale.
      expect(await service.beginStage(stages[0].id)).toBe(true);
      for (const stage of stages.slice(1)) {
        await age(stage.id);
      }

      events.send.mockClear();

      await service.resumeInterrupted();

      // Nothing enqueued, and above all the run is NOT closed out.
      expect(sendsFor(run.id)).toEqual([]);

      const [row] = await dataSource.query<Array<{ finished_at: string | null; status: string }>>(
        `SELECT finished_at, status FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(row.finished_at).toBeNull();

      // And the running stage is untouched — still claimed by its owner.
      const [live] = await dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(live.status).toBe('running');
    });

    it('closes out a run whose last stage completed but never finished', async () => {
      const { run, stages } = await startRun(await stageDrop());

      for (const stage of stages) {
        await service.beginStage(stage.id);
        await service.completeStage(stage.id, { processed: 1, total: 1, detail: {} });
      }

      events.send.mockClear();

      // Freshly completed, the run is protected: a live worker sits in the
      // milliseconds between completeStage and advance() exactly here, and a
      // periodic sweep must not close the run out from under it.
      await service.resumeInterrupted();

      const [fresh] = await dataSource.query<Array<{ finished_at: string | null }>>(
        `SELECT finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(fresh.finished_at).toBeNull();

      for (const stage of stages) {
        await age(stage.id);
      }

      await service.resumeInterrupted();

      const [row] = await dataSource.query<Array<{ status: string; finished_at: string | null }>>(
        `SELECT status, finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
        [run.id],
      );

      expect(row.status).toBe('completed');
      expect(row.finished_at).not.toBeNull();
      expect(sendsFor(run.id)).toEqual([]);
    });

    it('leaves a cancelled run alone, running stage and all', async () => {
      // Cancel deliberately does not touch a running stage (the worker notices
      // at its next transition); recovery must not resurrect the run.
      const { run, stages } = await startRun(await stageDrop());

      await service.beginStage(stages[0].id);
      await age(stages[0].id);
      await service.cancel({ userId }, run.id);
      events.send.mockClear();

      await service.resumeInterrupted();

      const [stage] = await dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM ci_import.import_stages WHERE id = $1::uuid`,
        [stages[0].id],
      );

      expect(stage.status).toBe('running');
      expect(sendsFor(run.id)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Staging writes
  // -------------------------------------------------------------------------

  describe('StagedWriter', () => {
    async function writerFor(): Promise<{ writer: StagedWriter; runId: string }> {
      const { run } = await startRun(await stageDrop());
      const writer = new StagedWriter(dataSource.manager, {
        userId,
        runId: run.id,
        dataSource: 'google_photos',
      });

      return { writer, runId: run.id };
    }

    it('collapses one photo replicated across album folders into a single staged item', async () => {
      const { writer, runId } = await writerFor();

      for (const folder of ['European Vacation/', 'Photos from 2012/', 'Favourites/']) {
        writer.push({
          item: {
            classification: 'photo',
            timestamp: new Date('2012-07-04T10:00:00Z'),
            content: { filename: 'IMAG0262.jpg' },
            intermediateLocation: folder,
          },
        });
      }

      await writer.settled();

      const [{ count }] = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.staged_items WHERE run_id = $1::uuid`,
        [runId],
      );

      expect(count).toBe('1');
      expect(writer.totals.items).toBe(1);
      // Counted, not silently swallowed — "we staged 4,000 of your 12,000 photo
      // files" is a question people ask.
      expect(writer.totals.itemsDeduped).toBe(2);
    });

    it('collapses one person spelled three ways onto their handle', async () => {
      const { writer, runId } = await writerFor();

      for (const name of ['Alice', 'Alice Smith', undefined]) {
        writer.push({
          item: { id: `msg-${name ?? 'none'}`, classification: 'email' },
          entity: { name, attributes: [{ name: 'email', value: 'Alice@Example.com' }] },
        });
      }

      await writer.settled();

      const rows = await dataSource.query<Array<{ identity_key: string; type: string }>>(
        `SELECT identity_key, type FROM ci_import.staged_entities WHERE run_id = $1::uuid`,
        [runId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].identity_key).toBe('alice@example.com');
      // The parser omitted a type; a handle-carrying entity defaults to contact.
      expect(rows[0].type).toBe('contact');
    });

    it('keeps handle-less entities apart instead of collapsing them on a NULL key', async () => {
      const { writer, runId } = await writerFor();

      for (const name of ['European Vacation', 'Photos from 2012']) {
        writer.push({ item: { id: `album-${name}` }, entity: { type: 'album', name } });
      }

      await writer.settled();

      const [{ count }] = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.staged_entities WHERE run_id = $1::uuid AND identity_key IS NULL`,
        [runId],
      );

      expect(count).toBe('2');
    });

    it('grows accumulating metadata on a second sighting and marks the row dirty', async () => {
      const { writer, runId } = await writerFor();

      writer.push({
        item: { id: 'order-jan' },
        entity: {
          name: 'Burger',
          accumulate: ['prices'],
          metadata: { prices: ['10.19'] },
          attributes: [{ name: 'email', value: 'orders@ubereats.com' }],
        },
      });
      writer.push({
        item: { id: 'order-mar' },
        entity: {
          name: 'Burger',
          accumulate: ['prices'],
          metadata: { prices: ['15.92'] },
          attributes: [{ name: 'email', value: 'orders@ubereats.com' }],
        },
      });

      await writer.settled();

      const [row] = await dataSource.query<
        Array<{ metadata: Record<string, unknown>; graph_dirty: boolean; accumulate: string[] | null }>
      >(`SELECT metadata, graph_dirty, accumulate FROM ci_import.staged_entities WHERE run_id = $1::uuid`, [
        runId,
      ]);

      expect(row.metadata.prices).toEqual(['10.19', '15.92']);
      // The push resumes from a high-water mark, so a row that changed after it
      // was already sent would never be revisited without this.
      expect(row.graph_dirty).toBe(true);
      expect(writer.totals.entitiesGrown).toBe(1);
      // And the declaration itself is kept, so the push unions `prices` into
      // the graph row too instead of replacing what an earlier run put there.
      // This entity is a contact (it has an email), and staging adds the keys it
      // accumulates for every contact (`withContactIdentifiers`) to the parser's.
      expect(row.accumulate).toEqual(['prices', ...CONTACT_IDENTIFIER_KEYS, CONTACT_NAMES_KEY]);
    });

    it('does not collapse item→item edges that point at different items', async () => {
      const { writer, runId } = await writerFor();

      // The exact shape PR 2 split the two partial indexes to protect: a single
      // combined index reads both of these as (item_id, NULL, 'reply_to').
      writer.push({
        item: { id: 'thread-root', classification: 'email' },
        edges: [
          { relation: 'reply_to', to: { item: { id: 'reply-1', classification: 'email' } } },
          { relation: 'reply_to', to: { item: { id: 'reply-2', classification: 'email' } } },
        ],
      });

      await writer.settled();

      const rows = await dataSource.query<Array<{ related_item_id: string }>>(
        `SELECT related_item_id FROM ci_import.staged_relationships
          WHERE run_id = $1::uuid AND related_item_id IS NOT NULL`,
        [runId],
      );

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.related_item_id)).size).toBe(2);
    });

    it('is idempotent for the same edge pushed twice', async () => {
      const { writer, runId } = await writerFor();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        writer.push({
          item: { id: 'msg-1', classification: 'email' },
          edges: [
            {
              relation: 'to',
              to: { entity: { attributes: [{ name: 'email', value: 'bob@example.com' }] } },
            },
          ],
        });
      }

      await writer.settled();

      const [{ count }] = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.staged_relationships WHERE run_id = $1::uuid AND relation = 'to'`,
        [runId],
      );

      expect(count).toBe('1');
      expect(writer.totals.relationships).toBe(1);
    });

    it('stages an item owner as an ordinary edge', async () => {
      const { writer, runId } = await writerFor();

      writer.push({
        item: {
          id: 'photo-1',
          classification: 'photo',
          owner: { name: 'Me', attributes: [{ name: 'email', value: 'me@example.com' }] },
        },
      });

      await writer.settled();

      const rows = await dataSource.query<Array<{ relation: string; entity_id: string }>>(
        `SELECT relation, entity_id FROM ci_import.staged_relationships WHERE run_id = $1::uuid`,
        [runId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].relation).toBe('owner');
      expect(rows[0].entity_id).not.toBeNull();
    });

    it('counts dropped records by reason without staging them', async () => {
      const { writer, runId } = await writerFor();

      writer.drop('reaction_only');
      writer.drop('reaction_only');
      writer.drop('unsupported_variant');

      await writer.settled();

      const [{ count }] = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) FROM ci_import.staged_items WHERE run_id = $1::uuid`,
        [runId],
      );

      expect(count).toBe('0');
      expect(writer.totals.drops).toEqual({ reaction_only: 2, unsupported_variant: 1 });
    });

    it('cascades every staged row away with its run', async () => {
      const { writer, runId } = await writerFor();

      writer.push({
        item: { id: 'doomed', classification: 'email' },
        edges: [{ relation: 'to', to: { entity: { attributes: [{ name: 'email', value: 'x@y.com' }] } } }],
      });

      await writer.settled();
      await dataSource.query(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [runId]);

      for (const table of ['staged_items', 'staged_entities', 'staged_relationships']) {
        const [{ count }] = await dataSource.query<Array<{ count: string }>>(
          `SELECT count(*) FROM ci_import.${table} WHERE run_id = $1::uuid`,
          [runId],
        );

        expect(count).toBe('0');
      }
    });
  });

  // -------------------------------------------------------------------------
  // The data-loss guard and its neighbours
  // -------------------------------------------------------------------------

  describe('hasUnstoredMedia', () => {
    /**
     * Stages one raw `ci_import.staged_items` row with exactly the columns
     * `hasUnstoredMedia`'s predicate reads, so each case controls precisely one
     * of them. Bypasses `StagedWriter` on purpose — this is a test of the SQL
     * predicate itself, hand-duplicated from `MediaStage.mediaPredicate()`
     * (see ImportRunService.ts, `hasUnstoredMedia`'s doc comment: "Mirrors
     * MediaStage.mediaPredicate()"). A drift between the two — a classification
     * added to `FILE_CLASSIFICATIONS` that this copy forgets, a metadata key
     * renamed on one side only — is exactly what this proves does not exist,
     * against the real column types and the real `~` regex operator.
     */
    async function stageRow(
      runId: string,
      overrides: {
        mediaType?: string | null;
        classification?: string | null;
        intermediateLocation?: string | null;
        originalLocation?: string | null;
        metadata?: Record<string, unknown>;
      } = {},
    ): Promise<void> {
      await dataSource.query(
        `INSERT INTO ci_import.staged_items
           (run_id, user_id, data_source, classification, content_hash, media_type,
            intermediate_location, original_location, metadata)
         VALUES ($1::uuid, $2::uuid, 'apple_photos', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          runId,
          userId,
          overrides.classification ?? null,
          randomUUID(),
          overrides.mediaType ?? null,
          'intermediateLocation' in overrides ? overrides.intermediateLocation : '/scratch/IMG_0001.jpg',
          overrides.originalLocation ?? null,
          JSON.stringify(overrides.metadata ?? {}),
        ],
      );
    }

    it('is false for a run that has staged nothing yet', async () => {
      const { run } = await startRun(await stageDrop());

      expect(await service.hasUnstoredMedia(run.id)).toBe(false);
    });

    it('is true for an image on disk with no FileId yet', async () => {
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, { mediaType: 'image/jpeg' });

      expect(await service.hasUnstoredMedia(run.id)).toBe(true);
    });

    it('is true for a file-backed classification even with no media MIME', async () => {
      // FILE_CLASSIFICATIONS carries 'file' for exactly this case: a
      // drive-walk document MediaStage still has to upload, whose MIME the
      // parser never determined.
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, { mediaType: null, classification: 'file' });

      expect(await service.hasUnstoredMedia(run.id)).toBe(true);
    });

    it('turns false once MediaStage stamps FileId', async () => {
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, { mediaType: 'image/jpeg', metadata: { FileId: randomUUID() } });

      expect(await service.hasUnstoredMedia(run.id)).toBe(false);
    });

    it('turns false once MediaStage stamps FileMediaError instead', async () => {
      // A row MediaStage tried and gave up on is SETTLED, not pending — the
      // stage's own skip query reads the same way (see MediaStage's row
      // selection), so a permanently-broken file must not wedge the reclaim
      // guard forever.
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, { mediaType: 'image/jpeg', metadata: { FileMediaError: 'ENOENT' } });

      expect(await service.hasUnstoredMedia(run.id)).toBe(false);
    });

    it('is false for a media row with no path on disk to lose', async () => {
      // Neither intermediate_location nor original_location: there are no
      // bytes on disk for the reclaim to destroy, so nothing is at risk.
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, {
        mediaType: 'image/jpeg',
        intermediateLocation: null,
        originalLocation: null,
      });

      expect(await service.hasUnstoredMedia(run.id)).toBe(false);
    });

    it('is false for a plain text row that is neither media MIME nor a file classification', async () => {
      const { run } = await startRun(await stageDrop());

      await stageRow(run.id, { mediaType: 'text/plain', classification: 'email' });

      expect(await service.hasUnstoredMedia(run.id)).toBe(false);
    });

    it('does not see another run’s unstored media', async () => {
      const { run: runA } = await startRun(await stageDrop());
      const { run: runB } = await startRun(await stageDrop());

      await stageRow(runB.id, { mediaType: 'image/jpeg' });

      expect(await service.hasUnstoredMedia(runA.id)).toBe(false);
      expect(await service.hasUnstoredMedia(runB.id)).toBe(true);
    });
  });

  describe('pulledRecords', () => {
    it('is false for a run that has staged neither an item nor an entity', async () => {
      const { run } = await startRun(await stageDrop());

      expect(await service.pulledRecords(run.id)).toBe(false);
    });

    it('is true once the run has staged an item', async () => {
      const { writer, runId } = await harness.writerFor('gmail');

      writer.push({ item: { id: 'msg-1', classification: 'email' } });
      await writer.settled();

      expect(await service.pulledRecords(runId)).toBe(true);
    });

    it('is true for an entity-only run, e.g. a contact list with no items', async () => {
      // The same asymmetry rankDataSources guards against on the naming side:
      // a source that produced only entities is still something the run
      // pulled, not an empty run.
      const { writer, runId } = await harness.writerFor('contact_list');

      writer.push({ entity: { name: 'Alice', attributes: [{ name: 'email', value: 'alice@example.com' }] } });
      await writer.settled();

      expect(await service.pulledRecords(runId)).toBe(true);
    });
  });

  describe('runBelongsTo', () => {
    it('is true for the run’s own owner', async () => {
      const { run } = await startRun(await stageDrop());

      expect(await service.runBelongsTo(run.id, userId)).toBe(true);
    });

    it('rejects a different user’s id — the check a worker makes before executing a stage', async () => {
      // The tenancy guard itself: ImportStageListener trusts this before
      // running a stage against payload.userId, precisely so a payload that
      // disagreed with the run row could not file one account's data under
      // another's. A test that only proves the true case cannot catch that.
      const { run } = await startRun(await stageDrop());
      const stranger = randomUUID();

      expect(await service.runBelongsTo(run.id, stranger)).toBe(false);
    });

    it('is false for a run id that does not exist at all', async () => {
      expect(await service.runBelongsTo(randomUUID(), userId)).toBe(false);
    });
  });
});
