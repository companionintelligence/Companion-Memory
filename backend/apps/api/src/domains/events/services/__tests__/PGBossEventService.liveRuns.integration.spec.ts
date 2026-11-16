import { EventEmitter2 } from '@nestjs/event-emitter';
import { PgBoss } from 'pg-boss';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { PGBossEventService } from '../PGBossEventService';

/**
 * What Predict and the hbpe queue lean on, against pg-boss 12 itself rather
 * than a stub that answers either way: a person's runs are found by the
 * payload's `userId` whatever key each was sent with. An active job whose
 * heartbeat stops is failed into a retry, while one that keeps beating is left
 * alone.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/PGBossEventService.liveRuns] SKIPPED: ${availability.reason}`);
}

// CREATE DATABASE, plus one heartbeat window of real waiting.
jest.setTimeout(300_000);

const QUEUE = 'live-runs-spec';
// pg-boss's floor; the hbpe queue itself uses five minutes.
const HEARTBEAT_SECONDS = 10;

const logger = { setContext() {}, log() {}, warn() {}, error() {}, debug() {} } as unknown as LoggerService;

describeWithDatabase(`PGBossEventService live runs on pg-boss 12 (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let boss: PgBoss;
  let service: PGBossEventService;

  /**
   * A job shaped as PythonFunctionService sends one, under its own singleton
   * key and with the heartbeat window on the job, as it sends hbpe runs.
   * `heartbeatSeconds: null` sends one without, as a release before heartbeats did.
   */
  async function sendRun(
    userId: string,
    key: string,
    heartbeatSeconds: number | null = HEARTBEAT_SECONDS,
  ): Promise<string> {
    const id = await boss.send(
      QUEUE,
      { name: 'python.function.run', target: 'hbpe', function: 'nightly', args: { user_id: userId }, userId },
      { singletonKey: key, ...(heartbeatSeconds === null ? {} : { heartbeatSeconds }) },
    );

    if (id == null) {
      throw new Error(`pg-boss refused ${key}`);
    }

    return id;
  }

  /** Take the next job, as the dispatcher does before it hands the run to the sidecar. */
  async function start(): Promise<string> {
    const [job] = await boss.fetch(QUEUE, { batchSize: 1 });

    if (!job) {
      throw new Error('nothing to fetch');
    }

    return job.id;
  }

  async function stateOf(id: string): Promise<{ state: string; output: unknown }> {
    const job = await boss.getJobById(QUEUE, id);

    return { state: String(job?.state), output: job?.output };
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'PGBossEventService.liveRuns.integration.spec' });
    await scratch.assertOwn();

    const { host, port, username, password, database } = scratch.dataSource
      .options as PostgresDataSourceOptions;

    // Supervision only when the test asks, so the timing is the test's.
    boss = new PgBoss({
      host,
      port,
      user: username,
      password,
      database,
      schema: 'pgboss',
      schedule: false,
      supervise: false,
    });
    boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));
    await boss.start();
    // No heartbeat window on the queue itself, as the hbpe queue is provisioned.
    await boss.createQueue(QUEUE, {
      policy: 'short',
      retryLimit: 2,
      retryDelay: 300,
    });

    service = new PGBossEventService(new EventEmitter2(), logger, {} as never);
    (service as unknown as { boss: PgBoss }).boss = boss;
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await scratch?.drop();
  });

  it("finds a person's waiting or running job whatever key it was sent with and nobody else's", async () => {
    const someone = uuidv7();
    const other = uuidv7();

    await expect(service.hasLiveJobForUser(QUEUE, someone)).resolves.toBe(false);

    // The 02:30 nightly's key, not Predict's.
    const nightly = await sendRun(someone, `fn:hbpe:${someone}:2026-11-16`);
    await expect(service.hasLiveJobForUser(QUEUE, someone)).resolves.toBe(true);
    await expect(service.hasLiveJobForUser(QUEUE, other)).resolves.toBe(false);

    expect(await start()).toBe(nightly);
    await expect(service.hasLiveJobForUser(QUEUE, someone)).resolves.toBe(true);

    await boss.complete(QUEUE, nightly);
    await expect(service.hasLiveJobForUser(QUEUE, someone)).resolves.toBe(false);
  });

  it('fails an active job into a retry once its heartbeat stops and leaves one that beats alone', async () => {
    const quiet = await sendRun(uuidv7(), 'fn:nightly:quiet:manual');
    expect(await start()).toBe(quiet);
    const beating = await sendRun(uuidv7(), 'fn:nightly:beating:manual');
    expect(await start()).toBe(beating);
    // Sent without a window, as an older release (or one rolled back to) sends
    // its jobs: nothing beats for it and nothing fails it before its expiry.
    const unwatched = await sendRun(uuidv7(), 'fn:nightly:unwatched:manual', null);
    expect(await start()).toBe(unwatched);

    await expect(service.touchJob(QUEUE, quiet)).resolves.toBe(true);

    // Past the window for `quiet`; `beating` reports in throughout.
    const deadline = Date.now() + (HEARTBEAT_SECONDS + 3) * 1000;
    while (Date.now() < deadline) {
      await expect(service.touchJob(QUEUE, beating)).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    await boss.supervise(QUEUE);

    expect(await stateOf(quiet)).toMatchObject({
      state: 'retry',
      output: expect.objectContaining({ value: { message: 'job heartbeat timeout' } }),
    });
    expect((await stateOf(beating)).state).toBe('active');
    expect((await stateOf(unwatched)).state).toBe('active');
    expect((await boss.getQueue(QUEUE))?.heartbeatSeconds ?? null).toBeNull();

    // A beat for a job that is no longer running moves nothing; the runner logs it.
    await expect(service.touchJob(QUEUE, quiet)).resolves.toBe(false);

    // The run behind `quiet` finished before its retry was fetched. Plain
    // complete() takes only an active job, so its result would be dropped and
    // the retry would run it again; the callback's includeQueued takes it.
    await service.completeJob(QUEUE, quiet, { ok: true });
    expect((await stateOf(quiet)).state).toBe('retry');
    await service.completeJob(QUEUE, quiet, { ok: true }, { includeQueued: true });
    expect((await stateOf(quiet)).state).toBe('completed');
  });
});
