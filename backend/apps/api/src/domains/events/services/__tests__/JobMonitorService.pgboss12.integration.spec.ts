import { readFileSync } from 'fs';
import { join } from 'path';

import { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { DEAD_LETTER_QUEUE } from '../../constants';
import { JobCategoryMetricEntity } from '../../entities/JobCategoryMetricEntity';
import { JobMetricEntity } from '../../entities/JobMetricEntity';
import { PgBossJobEntity } from '../../entities/PgBossJobEntity';
import { PgBossQueueEntity } from '../../entities/PgBossQueueEntity';
import { PgBossScheduleEntity } from '../../entities/PgBossScheduleEntity';
import { JobMonitorService } from '../JobMonitorService';
import { JobQueryService } from '../JobQueryService';

/**
 * The Jobs page's queries against the schema pg-boss 12 builds for itself.
 *
 * Mocks and hand-written DDL cannot catch this class of bug: pg-boss 12 has no
 * `pgboss.archive` and renamed `queue.retention_minutes`, and a stubbed
 * repository answers either way. So pg-boss creates the tables here and moves
 * real jobs through them, and the services read what it left.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/JobMonitorService.pgboss12] SKIPPED: ${availability.reason}`);
}

// CREATE DATABASE plus every migration.
jest.setTimeout(300_000);

const WORK_QUEUE = 'jobs-page-work';
const RETENTION_SECONDS = 2 * 60 * 60;
const BACKFILL_SCRIPT = join(__dirname, '../../../../../db/postgres/scripts/backfill_job_metrics.sql');

describeWithDatabase(`Jobs page on pg-boss 12's own schema (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let mapped: DataSource;
  let boss: PgBoss;
  let monitor: JobMonitorService;
  let query: JobQueryService;

  const context = { userId: uuidv7() } as RequestContext;

  /** Send one job and take it, so it is `active` and ready to be finished. */
  async function startJob(eventName: string): Promise<string> {
    const id = await boss.send(WORK_QUEUE, { name: eventName, userId: context.userId });

    if (id == null) {
      throw new Error(`pg-boss refused the ${eventName} job`);
    }

    const [job] = await boss.fetch(WORK_QUEUE, { batchSize: 1 });

    expect(job?.id).toBe(id);

    return id;
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({
      createdBy: 'JobMonitorService.pgboss12.integration.spec',
    });

    await scratch.assertOwn();

    const { host, port, username, password, database } = scratch.dataSource
      .options as PostgresDataSourceOptions;

    boss = new PgBoss({ host, port, user: username, password, database, schema: 'pgboss', schedule: false });
    boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));

    await boss.start();
    await boss.createQueue(DEAD_LETTER_QUEUE);
    await boss.createQueue(WORK_QUEUE, {
      deadLetter: DEAD_LETTER_QUEUE,
      retryLimit: 0,
      retentionSeconds: RETENTION_SECONDS,
    });

    mapped = new DataSource({
      type: 'postgres',
      host,
      port,
      username,
      password,
      database,
      entities: [
        PgBossJobEntity,
        PgBossScheduleEntity,
        PgBossQueueEntity,
        JobMetricEntity,
        JobCategoryMetricEntity,
      ],
      synchronize: false,
      extra: { max: 4 },
    });

    await mapped.initialize();

    monitor = new JobMonitorService(
      mapped.getRepository(PgBossJobEntity),
      mapped.getRepository(PgBossScheduleEntity),
      mapped.getRepository(PgBossQueueEntity),
    );
    query = new JobQueryService(
      mapped.getRepository(PgBossJobEntity),
      mapped.getRepository(JobMetricEntity),
      mapped.getRepository(JobCategoryMetricEntity),
    );
  });

  beforeEach(async () => {
    await scratch.dataSource.query('DELETE FROM pgboss.job');

    await boss.complete(WORK_QUEUE, await startJob('finished.ok'));
    await boss.complete(WORK_QUEUE, await startJob('finished.ok'));
    await boss.fail(WORK_QUEUE, await startJob('finished.bad'), { message: 'boom' });
    await boss.cancel(WORK_QUEUE, await startJob('finished.cancelled'));
    await boss.send(WORK_QUEUE, { name: 'still.waiting', userId: context.userId });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await mapped?.destroy();
    await scratch?.drop();
  });

  it('runs against a pg-boss that keeps no archive table', async () => {
    const [row] = await scratch.dataSource.query<Array<{ archive: string | null }>>(
      `SELECT to_regclass('pgboss.archive')::text AS archive`,
    );

    expect(row.archive).toBeNull();
  });

  it('counts finished jobs from pgboss.job', async () => {
    const { summary } = await monitor.getDashboard(context);

    expect(summary).toMatchObject({
      pending: 1,
      active: 0,
      retry: 0,
      completed: 2,
      failed: 1,
      cancelled: 1,
      deadLettered: 1,
    });
  });

  it('lists finished jobs as the archive, stamped with when they finished', async () => {
    const { archive } = await monitor.getDashboard(context);

    expect(archive.map((job) => job.state).sort()).toEqual(['cancelled', 'completed', 'completed', 'failed']);

    for (const job of archive) {
      expect(job.queue).toBe(WORK_QUEUE);
      expect(job.completedOn).toEqual(expect.any(String));
      expect(job.archivedOn).toBe(job.completedOn);
    }
  });

  it('groups finished jobs by handler and leaves out work still waiting', async () => {
    const { archiveDistribution } = await monitor.getDashboard(context);

    expect(archiveDistribution).toHaveLength(3);
    expect(archiveDistribution).toEqual(
      expect.arrayContaining([
        { jobName: 'finished.ok', count: 2 },
        { jobName: 'finished.bad', count: 1 },
        { jobName: 'finished.cancelled', count: 1 },
      ]),
    );
  });

  // pg-boss 12 copies a job that ran out of retries onto the dead-letter queue
  // as a new job that has not run: its own `output` is empty and the failure is
  // in `source_output`. Reading `output` alone showed that row with no error.
  it('shows a dead-lettered job with the failure it died with', async () => {
    const { items } = await query.list(context, { state: DEAD_LETTER_QUEUE });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      event: 'finished.bad',
      deadLettered: true,
      failure: { message: 'boom' },
    });

    const { jobs } = await monitor.getDashboard(context);
    const copy = jobs.find((job) => job.queue === DEAD_LETTER_QUEUE);

    expect(copy).toMatchObject({ event: 'finished.bad', failure: { message: 'boom' } });
  });

  it('finds a dead-lettered job by the failure it died with, for its owner only', async () => {
    const asOwner = await query.list(context, { state: DEAD_LETTER_QUEUE, search: 'boom' });

    expect(asOwner.items.map((item) => item.event)).toEqual(['finished.bad']);

    const asStranger = await query.list({ userId: uuidv7() } as RequestContext, {
      state: DEAD_LETTER_QUEUE,
      search: 'boom',
    });

    expect(asStranger.items).toEqual([]);
  });

  it('reports each queue with the retention pg-boss stores in seconds, in minutes', async () => {
    const { queues } = await monitor.getDashboard(context);

    expect(queues.find((queue) => queue.name === WORK_QUEUE)?.retentionMinutes).toBe(RETENTION_SECONDS / 60);
  });

  it('clears failed jobs until the count reaches zero and keeps everything else', async () => {
    await expect(query.clearTerminal(context, 'failed')).resolves.toEqual({
      scope: 'failed',
      deleted: 1,
      retained: 0,
    });

    const { summary } = await monitor.getDashboard(context);

    expect(summary).toMatchObject({ pending: 1, completed: 2, failed: 0, cancelled: 1, deadLettered: 1 });
  });

  it('backfills job metrics from what pg-boss holds', async () => {
    await scratch.dataSource.query('DELETE FROM ci.job_metrics');
    await scratch.dataSource.query(readFileSync(BACKFILL_SCRIPT, 'utf8'));

    const [row] = await scratch.dataSource.query<Array<{ completed: number; failed: number }>>(
      `SELECT COALESCE(SUM(completed), 0)::int AS completed, COALESCE(SUM(failed), 0)::int AS failed
         FROM ci.job_metrics
        WHERE queue = $1`,
      [WORK_QUEUE],
    );

    expect(row).toEqual({ completed: 2, failed: 1 });
  });
});
