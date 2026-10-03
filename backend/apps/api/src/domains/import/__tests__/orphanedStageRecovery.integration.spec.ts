import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventEmitter2 } from '@nestjs/event-emitter';
import PgBoss from 'pg-boss';
import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { PGBossEventService, type Acknowledgement } from '@ci/domains/events';

import { resolveConnection } from '../../__tests__/support/databaseConnection';
import {
  IMPORT_STAGE_KINDS,
  IMPORT_STAGE_ORPHAN_SECONDS,
  IMPORT_STAGE_QUEUE_BY_KIND,
  type ImportStageKindName,
} from '../constants';
import { ImportStageEvent } from '../events';
import { ImportStageListener } from '../listeners/ImportStageListener';
import type { ImportRunService } from '../services/ImportRunService';

import {
  createStagingHarness,
  IMPORT_DATABASE_ENV,
  importDatabase,
  type StagingHarness,
} from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STAGE WHOSE WORKER DIED IS RETRIED IN MINUTES. AGAINST REAL POSTGRES AND
 * A REAL PG-BOSS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reproduced 2026-09-29 on a full-corpus inbox import: the worker was restarted
 * mid-parse. The parse stage stayed `running` with `processed` frozen at 8141
 * and no error, and `ci runs` said `running`, for twelve minutes — until the
 * ten-minute rule in `resumeInterrupted`'s five-minute sweep re-queued it
 * behind a brand-new job. The dead worker's own job stayed `active` with a
 * twelve-hour lease; forcing it to expire by hand retried it into a no-op,
 * because the stage was still claimed.
 *
 * The reaper under test closes all of that: the stage back in minutes, the
 * SAME job retried by pg-boss (so it keeps its place in line and its retry
 * budget means something), the worker that lost it fenced out, and nothing
 * left `active` that nobody is running.
 *
 * What is asserted here is almost all pg-boss's behaviour and SQL fences,
 * which is why none of it is mocked: that failing a job re-issues it under the
 * same id and `created_on` (so it keeps its place in line); that failing it at
 * its retry limit dead-letters it; that a fenced write lands or does not. A
 * stubbed queue would agree with whatever this file claimed about all three.
 *
 * ── Isolation ──────────────────────────────────────────────────────────────
 *
 * pg-boss runs on a schema of its own, created by the real provisioning code
 * (`PGBossEventService.onModuleInit`, so the import queues carry production's
 * policy, expiry, retry limit and dead-letter queue) and dropped afterwards.
 * Stages are silenced just past {@link IMPORT_STAGE_ORPHAN_SECONDS} and never
 * near the ten-minute backstop, which sibling suites' sweeps apply to every
 * stage in the database; and those suites' queue-less event stub refuses to
 * look a job up, which keeps their sweeps off the claims this file holds
 * against a real queue (see `stagingHarness`). Every assertion about what the
 * reaper did is filtered to this file's own stages.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/orphanedStageRecovery.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

/**
 * The queue a job lands on when it has spent its retries. Spelled out rather
 * than imported: the constant is the events domain's, and this suite asserts
 * where pg-boss put the job, not what the code believes it is called.
 */
const DEAD_LETTER_QUEUE = 'dead-letter';

type StagePayload = { runId: string; stageId: string; userId: string };
type StageJob = PgBoss.JobWithMetadata<StagePayload>;

const HANDLER_BY_KIND = {
  unpack: 'handleUnpackStage',
  parse: 'handleParseStage',
  media: 'handleMediaStage',
  push: 'handlePushStage',
} as const satisfies Record<ImportStageKindName, keyof ImportStageListener>;

function quietLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describeWithDatabase(`orphaned import stage recovery (${importDatabase.target})`, () => {
  const schema = `pgboss_orphan_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let dataSource: DataSource;
  let service: ImportRunService;
  let events: PGBossEventService;
  let boss: PgBoss;
  let emitter: EventEmitter2;
  let scratchRoot: string;

  beforeAll(async () => {
    const connection = resolveConnection(IMPORT_DATABASE_ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
    }

    boss = new PgBoss({
      ...(connection.url != null
        ? { connectionString: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            user: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      schema,
      // No maintenance timers: every transition this suite asserts on is one
      // it caused, not one pg-boss's supervisor happened to make meanwhile.
      supervise: false,
      schedule: false,
      max: 4,
    });

    emitter = new EventEmitter2();
    events = new PGBossEventService(
      emitter,
      quietLogger() as unknown as LoggerService,
      // Provisioning serializes on an advisory lock through the app pool; a
      // schema nobody else provisions has nothing to serialize against.
      {
        createQueryRunner: () => ({
          connect: async () => undefined,
          query: async () => [],
          release: async () => undefined,
        }),
      } as never,
    );
    (events as unknown as { boss: PgBoss }).boss = boss;

    // The production provisioning path. Importing ImportStageListener above is
    // what put the import queues in the registry it reads.
    await events.onModuleInit();

    ({ harness, teardown } = await createStagingHarness({ eventService: events }));
    ({ dataSource, service } = harness);

    scratchRoot = await mkdtemp(join(tmpdir(), 'ci-orphan-reap-'));
  });

  afterEach(async () => {
    // Hygiene between tests, on this suite's own rows only. Close whatever a
    // test left in flight so a later test's reap cannot find it, and empty the
    // private queues so a later test's first fetch is its own job.
    await dataSource.query(
      `UPDATE ci_import.import_stages s
          SET status = 'cancelled', claim_token = NULL
         FROM ci_import.import_runs r
        WHERE r.id = s.run_id AND r.user_id = $1::uuid AND s.status IN ('queued', 'running')`,
      [harness.userId],
    );
    await dataSource.query(
      `UPDATE ci_import.import_runs SET status = 'cancelled', finished_at = now()
        WHERE user_id = $1::uuid AND finished_at IS NULL`,
      [harness.userId],
    );
    await dataSource.query(`DELETE FROM ${schema}.job`);
  });

  afterAll(async () => {
    try {
      await events?.onModuleDestroy();
    } finally {
      try {
        await dataSource?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
        await teardown?.();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** A worker's fetch — the same call `PGBossEventService.work` makes. */
  async function fetchNext(
    kind: ImportStageKindName,
    options: { ignoreStartAfter?: boolean } = {},
  ): Promise<StageJob> {
    const [job] = await boss.fetch<StagePayload>(IMPORT_STAGE_QUEUE_BY_KIND[kind], {
      includeMetadata: true,
      batchSize: 1,
      ...options,
    });

    if (job == null) {
      throw new Error(`nothing to fetch on ${IMPORT_STAGE_QUEUE_BY_KIND[kind]}`);
    }

    return job;
  }

  /**
   * A worker that fetched an unpack job, claimed the stage the way
   * `ImportStageListener.runStage` does, reported some progress — and then
   * died. What is left is exactly the reproduction: a `running` stage holding a
   * claim, and an `active` job nobody is working.
   */
  async function unpackWhoseWorkerDied(): Promise<{
    runId: string;
    stageId: string;
    parseStageId: string;
    jobId: string;
    token: string;
  }> {
    const { run, stages } = await harness.startRunForDrop(await harness.stageDrop(), ['unpack', 'parse']);
    const job = await fetchNext('unpack');

    expect(job.data.stageId).toBe(stages[0].id);

    const token = await service.claimStage(stages[0].id, {
      jobId: job.id,
      queue: IMPORT_STAGE_QUEUE_BY_KIND.unpack,
    });

    if (token == null) {
      throw new Error('the worker should have won the claim');
    }

    await service.recordProgress(stages[0].id, { processed: 8141, total: null, phase: 'extracting' }, token);

    return { runId: run.id, stageId: stages[0].id, parseStageId: stages[1].id, jobId: job.id, token };
  }

  /** The heartbeat stops: backdate it as if nothing has beaten for `seconds`. */
  async function silence(stageId: string, seconds = IMPORT_STAGE_ORPHAN_SECONDS + 60): Promise<void> {
    await dataSource.query(
      `UPDATE ci_import.import_stages SET updated_at = now() - make_interval(secs => $2::int)
        WHERE id = $1::uuid`,
      [stageId, seconds],
    );
  }

  async function stageRow(stageId: string): Promise<{
    status: string;
    processed: string;
    error: string | null;
    claim_token: string | null;
    claim_job_id: string | null;
    detail: Record<string, unknown>;
  }> {
    const [row] = await dataSource.query(
      `SELECT status, processed, error, claim_token, claim_job_id, detail
         FROM ci_import.import_stages WHERE id = $1::uuid`,
      [stageId],
    );

    return row;
  }

  async function jobRow(
    queue: string,
    jobId: string,
  ): Promise<{
    state: string;
    retry_count: number;
    retry_limit: number;
    start_after: Date;
    output: Record<string, unknown> | null;
  }> {
    const [row] = await dataSource.query(
      `SELECT state, retry_count, retry_limit, start_after, output FROM ${schema}.job
        WHERE name = $1 AND id = $2::uuid`,
      [queue, jobId],
    );

    return row;
  }

  async function jobsFor(stageId: string, queue: string = IMPORT_STAGE_QUEUE_BY_KIND.unpack) {
    return dataSource.query<Array<{ id: string; state: string; singleton_key: string | null }>>(
      `SELECT id, state, singleton_key FROM ${schema}.job
        WHERE name = $1 AND data->>'stageId' = $2 ORDER BY created_on`,
      [queue, stageId],
    );
  }

  /**
   * A listener wired onto this suite's emitter the way Nest's subscriber
   * loader wires one in the app, over the REAL run service. Runners are stubs:
   * what is under test is the claim, the fence and the acknowledgement.
   */
  function listenerWith(unpackRun?: jest.Mock): ImportStageListener {
    const scratch = {
      ensureDir: async (_userId: string, runId: string) => {
        const dir = join(scratchRoot, runId);

        await mkdir(dir, { recursive: true });

        return dir;
      },
      reclaim: async () => true,
    };
    const runner = (kind: ImportStageKindName, run?: jest.Mock) => ({
      kind,
      run: run ?? jest.fn(async () => ({ processed: 1, total: 1, detail: {} })),
    });
    const listener = new ImportStageListener(
      service,
      scratch as never,
      runner('unpack', unpackRun) as never,
      runner('parse') as never,
      runner('media') as never,
      runner('push') as never,
      quietLogger() as never,
    );

    emitter.removeAllListeners();

    for (const kind of IMPORT_STAGE_KINDS) {
      const handler = HANDLER_BY_KIND[kind];

      emitter.on(
        `${ImportStageEvent}:${IMPORT_STAGE_QUEUE_BY_KIND[kind]}`,
        (payload: unknown, ack: Acknowledgement) => listener[handler](payload, ack),
      );
    }

    return listener;
  }

  /**
   * One delivery, end to end: `PGBossEventService`'s own job runner, through
   * the emitter, into the listener, and its acknowledgement back into pg-boss.
   */
  async function deliver(job: StageJob): Promise<void> {
    await (events as unknown as { runJob(queue: string, job: StageJob): Promise<void> }).runJob(
      job.name,
      job,
    );
  }

  async function until(condition: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await condition()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('condition never became true');
  }

  // ---------------------------------------------------------------------------
  // The reproduction
  // ---------------------------------------------------------------------------

  it('retries a stage whose worker died holding an active job — promptly, and at the head of its queue', async () => {
    const orphan = await unpackWhoseWorkerDied();

    // Another run's unpack is enqueued while the orphan sits there. A FRESH job
    // for the orphan would queue behind it; its own job, retried, does not.
    await harness.startRunForDrop(await harness.stageDrop(), ['unpack']);
    await silence(orphan.stageId);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.filter((entry) => entry.stageId === orphan.stageId)).toEqual([
      { stageId: orphan.stageId, runId: orphan.runId, kind: 'unpack', outcome: 'retried' },
    ]);

    // The stage: back in the queue, its claim cleared, and saying why.
    const stage = await stageRow(orphan.stageId);

    expect(stage.status).toBe('queued');
    expect(stage.claim_token).toBeNull();
    expect(stage.claim_job_id).toBeNull();
    expect(Number(stage.processed)).toBe(0);
    expect(stage.detail.interrupted).toMatchObject({
      reason: 'worker stopped heartbeating',
      processed: 8141,
      phase: 'extracting',
      jobId: orphan.jobId,
      jobState: 'active',
      retry: 1,
      retryLimit: 3,
    });

    // The job: pg-boss's own retry of the SAME job, due in seconds — not a
    // twelve-hour lease, and not a second job for the same stage.
    const job = await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId);

    expect(job.state).toBe('retry');
    expect(job.retry_count).toBe(0);
    expect(job.output).toMatchObject({ reason: 'import-stage-worker-lost', stageId: orphan.stageId });
    expect(new Date(job.start_after).getTime() - Date.now()).toBeLessThan(30_000);
    expect(await jobsFor(orphan.stageId)).toHaveLength(1);

    // Next in line, ahead of the run that queued after it — `ignoreStartAfter`
    // stands in for waiting out the backoff.
    listenerWith();

    const retried = await fetchNext('unpack', { ignoreStartAfter: true });

    expect(retried.id).toBe(orphan.jobId);
    expect(retried.retryCount).toBe(1);

    // And it runs: a fresh claim, a completed stage, a completed job, and the
    // run moved on to its parse.
    await deliver(retried);

    const after = await stageRow(orphan.stageId);

    expect(after.status).toBe('completed');
    expect(after.claim_token).toBeNull();
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId)).state).toBe('completed');
    expect(
      (await jobsFor(orphan.parseStageId, IMPORT_STAGE_QUEUE_BY_KIND.parse)).map((j) => j.state),
    ).toEqual(['created']);
  });

  // ---------------------------------------------------------------------------
  // What must NOT be reclaimed
  // ---------------------------------------------------------------------------

  it('leaves a heartbeating stage alone, however long it has been running', async () => {
    const live = await unpackWhoseWorkerDied();

    // Eleven hours in — nearly the whole lease — but it beat a moment ago.
    await dataSource.query(
      `UPDATE ci_import.import_stages SET started_at = now() - interval '11 hours' WHERE id = $1::uuid`,
      [live.stageId],
    );
    expect(await service.touchStage(live.stageId, live.token)).toBe(true);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.find((entry) => entry.stageId === live.stageId)).toBeUndefined();

    const stage = await stageRow(live.stageId);

    expect(stage.status).toBe('running');
    expect(stage.claim_token).toBe(live.token);
    expect(Number(stage.processed)).toBe(8141);

    const job = await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, live.jobId);

    expect(job.state).toBe('active');
    expect(job.output).toBeNull();
  });

  it('waits out the whole orphan window — four missed beats is not yet a dead worker', async () => {
    const quiet = await unpackWhoseWorkerDied();

    await silence(quiet.stageId, IMPORT_STAGE_ORPHAN_SECONDS - 30);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.find((entry) => entry.stageId === quiet.stageId)).toBeUndefined();
    expect((await stageRow(quiet.stageId)).status).toBe('running');
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, quiet.jobId)).state).toBe('active');
  });

  it('never takes back a stage its own process is running, however silent', async () => {
    // The owner's event loop blocked by a parser, or its database away: silent
    // for three orphan windows, and still certainly alive, because the process
    // asking is the one running it.
    const own = await unpackWhoseWorkerDied();

    await silence(own.stageId, IMPORT_STAGE_ORPHAN_SECONDS * 3);

    const reaped = await service.reclaimOrphanedStages({ liveStageIds: [own.stageId] });

    expect(reaped.find((entry) => entry.stageId === own.stageId)).toBeUndefined();
    expect((await stageRow(own.stageId)).claim_token).toBe(own.token);
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, own.jobId)).state).toBe('active');
  });

  it.each([
    ['retries left', false],
    ['retries spent', true],
  ])('yields to a worker whose heartbeat lands mid-reap (%s)', async (_label, exhausted) => {
    // The window between choosing a candidate and taking it: the reaper asks
    // pg-boss about the job right there, so the owner's beat is landed from
    // inside that lookup. The take re-checks silence, and loses.
    const orphan = await unpackWhoseWorkerDied();

    if (exhausted) {
      // Spent retries route the take through the dead-letter path's seize.
      await dataSource.query(
        `UPDATE ${schema}.job SET retry_count = retry_limit WHERE name = $1 AND id = $2::uuid`,
        [IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId],
      );
    }

    await silence(orphan.stageId);

    const lookup = events.getJob.bind(events);
    const spy = jest.spyOn(events, 'getJob').mockImplementationOnce(async (queue, jobId) => {
      expect(await service.touchStage(orphan.stageId, orphan.token)).toBe(true);

      return lookup(queue, jobId);
    });

    try {
      const reaped = await service.reclaimOrphanedStages();

      expect(reaped.find((entry) => entry.stageId === orphan.stageId)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    const stage = await stageRow(orphan.stageId);

    expect(stage.status).toBe('running');
    expect(stage.claim_token).toBe(orphan.token);
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId)).state).toBe('active');
  });

  it('leaves a claim no pg-boss job holds to the ten-minute backstop', async () => {
    // The in-process connector runs (BlueBubbles): no job to hand back, and a
    // heartbeat that is only its own progress reports, from whichever process
    // called it. The short window was never argued for them.
    const { stages } = await harness.startRunForDrop(await harness.stageDrop(), ['unpack']);

    expect(await service.beginStage(stages[0].id)).toBe(true);
    await silence(stages[0].id, 5 * 60);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.find((entry) => entry.stageId === stages[0].id)).toBeUndefined();
    expect((await stageRow(stages[0].id)).status).toBe('running');
  });

  // ---------------------------------------------------------------------------
  // No double run
  // ---------------------------------------------------------------------------

  it('fences out the worker it took the stage from', async () => {
    const orphan = await unpackWhoseWorkerDied();

    await silence(orphan.stageId);
    await service.reclaimOrphanedStages();

    // Every write the old claim could make now misses — and says so.
    expect(await service.touchStage(orphan.stageId, orphan.token)).toBe(false);
    expect(await service.recordProgress(orphan.stageId, { processed: 9000 }, orphan.token)).toBe(false);
    expect(
      await service.completeStage(orphan.stageId, { processed: 9000, total: 9000, detail: {} }, orphan.token),
    ).toBe(false);
    expect(await service.failStage(orphan.stageId, 'late failure', undefined, orphan.token)).toBe(false);

    const stage = await stageRow(orphan.stageId);

    expect(stage.status).toBe('queued');
    expect(Number(stage.processed)).toBe(0);

    const [run] = await dataSource.query<Array<{ status: string; finished_at: Date | null }>>(
      `SELECT status, finished_at FROM ci_import.import_runs WHERE id = $1::uuid`,
      [orphan.runId],
    );

    expect(run.finished_at).toBeNull();
    expect(run.status).not.toBe('failed');

    // The retry's claim is a new token, and only it writes.
    const retried = await fetchNext('unpack', { ignoreStartAfter: true });
    const fresh = await service.claimStage(orphan.stageId, {
      jobId: retried.id,
      queue: IMPORT_STAGE_QUEUE_BY_KIND.unpack,
    });

    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(orphan.token);
    expect(await service.touchStage(orphan.stageId, orphan.token)).toBe(false);
    expect(await service.touchStage(orphan.stageId, fresh!)).toBe(true);
  });

  it('keeps a worker that was only slow from completing the stage, advancing the run, or acking the retry', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowUnpack = jest.fn(async () => {
      await gate;

      return { processed: 5, total: 5, detail: {} };
    });

    listenerWith(slowUnpack);

    const { run, stages } = await harness.startRunForDrop(await harness.stageDrop(), ['unpack', 'parse']);
    const job = await fetchNext('unpack');

    // The slow worker takes the job through the real delivery path and claims
    // the stage...
    const delivery = deliver(job);

    await until(async () => slowUnpack.mock.calls.length > 0);
    expect((await stageRow(stages[0].id)).claim_job_id).toBe(job.id);

    // ...then goes quiet long enough that ANOTHER process's reaper judges it
    // dead. (Its own process would not: it would pass the stage as live.)
    await silence(stages[0].id);
    await service.reclaimOrphanedStages();
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, job.id)).state).toBe('retry');

    // The replacement attempt picks the retry up — the SAME job id, now
    // `active` again on its behalf.
    const replacement = await fetchNext('unpack', { ignoreStartAfter: true });

    expect(replacement.id).toBe(job.id);

    // The slow worker finishes after all. Its result is discarded, the next
    // stage is not started on top of the replacement, and the job is left to
    // the replacement: the stale delivery DEFERS. Completing it instead would
    // mark the replacement's job done while it is still running.
    release();
    await delivery;

    expect((await stageRow(stages[0].id)).status).toBe('queued');
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, job.id)).state).toBe('active');
    expect(
      await dataSource.query(`SELECT 1 FROM ${schema}.job WHERE name = $1 AND data->>'runId' = $2`, [
        IMPORT_STAGE_QUEUE_BY_KIND.parse,
        run.id,
      ]),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // pg-boss's policy decides
  // ---------------------------------------------------------------------------

  it('fails the stage once pg-boss dead-letters a job whose worker keeps dying', async () => {
    const { run, stages } = await harness.startRunForDrop(await harness.stageDrop(), ['unpack']);
    const stageId = stages[0].id;
    const first = await fetchNext('unpack');
    const retryLimit = first.retryLimit;

    expect(retryLimit).toBe(3);

    // The first delivery and each of pg-boss's retries die mid-stage.
    let job = first;

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      expect(job.id).toBe(first.id);
      expect(job.retryCount).toBe(attempt);

      const token = await service.claimStage(stageId, {
        jobId: job.id,
        queue: IMPORT_STAGE_QUEUE_BY_KIND.unpack,
      });

      expect(token).not.toBeNull();
      await silence(stageId);

      const reaped = await service.reclaimOrphanedStages();

      expect(reaped.find((entry) => entry.stageId === stageId)?.outcome).toBe(
        attempt < retryLimit ? 'retried' : 'deadLettered',
      );

      if (attempt < retryLimit) {
        job = await fetchNext('unpack', { ignoreStartAfter: true });
      }
    }

    const stage = await stageRow(stageId);

    expect(stage.status).toBe('failed');
    expect(stage.error).toMatch(/went silent 4 times/);
    expect(stage.claim_token).toBeNull();

    const [runRow] = await dataSource.query<Array<{ status: string }>>(
      `SELECT status FROM ci_import.import_runs WHERE id = $1::uuid`,
      [run.id],
    );

    expect(runRow.status).toBe('failed');
    expect((await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, first.id)).state).toBe('failed');
    expect(
      await dataSource.query(`SELECT 1 FROM ${schema}.job WHERE name = $1 AND data->>'stageId' = $2`, [
        DEAD_LETTER_QUEUE,
        stageId,
      ]),
    ).toHaveLength(1);

    // Nothing is left pending to re-run it behind the dead letter's back.
    expect((await jobsFor(stageId)).filter((j) => j.state === 'created' || j.state === 'retry')).toEqual([]);
  });

  it('does not fail a job again that pg-boss has already moved to retry', async () => {
    // pg-boss's own expiry got there first. A second failure would spend a
    // retry the worker never had.
    const orphan = await unpackWhoseWorkerDied();

    await boss.fail(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId, { message: 'expired' });

    const before = await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId);

    await silence(orphan.stageId);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.find((entry) => entry.stageId === orphan.stageId)?.outcome).toBe('awaiting');
    expect((await stageRow(orphan.stageId)).status).toBe('queued');

    const after = await jobRow(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId);

    expect(after.state).toBe('retry');
    expect(after.start_after).toEqual(before.start_after);
    expect(after.output).toEqual(before.output);
  });

  it('enqueues a fresh job when the one holding the claim can no longer carry it', async () => {
    const orphan = await unpackWhoseWorkerDied();

    // Completed out from under the claim — a redelivery acked it, or an
    // operator did. Nothing would ever run the stage again.
    await boss.complete(IMPORT_STAGE_QUEUE_BY_KIND.unpack, orphan.jobId);
    await silence(orphan.stageId);

    const reaped = await service.reclaimOrphanedStages();

    expect(reaped.find((entry) => entry.stageId === orphan.stageId)?.outcome).toBe('reenqueued');
    expect((await stageRow(orphan.stageId)).status).toBe('queued');

    const pending = (await jobsFor(orphan.stageId)).filter((job) => job.state === 'created');

    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(orphan.jobId);
    expect(pending[0].singleton_key).toBe(orphan.stageId);
  });
});
