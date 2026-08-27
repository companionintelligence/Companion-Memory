import { UnauthorizedException } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { Repository } from 'typeorm';

import { CronRunStore } from '@ci/common/schedule';

import type { PgBossArchiveEntity } from '../../entities/PgBossArchiveEntity';
import type { PgBossJobEntity } from '../../entities/PgBossJobEntity';
import type { PgBossQueueEntity } from '../../entities/PgBossQueueEntity';
import type { PgBossScheduleEntity } from '../../entities/PgBossScheduleEntity';
import { JobMonitorService } from '../JobMonitorService';

/**
 * The dashboard's read model. Until now it had no tests at all, and the two
 * things that were wrong with it were both invisible from the outside — the
 * numbers looked plausible, they were just counting the wrong rows.
 *
 * The state counts are asserted against grouped rows shaped exactly like the
 * ones a live appliance returns (queue names and magnitudes taken from a real
 * `GROUP BY state` against pgboss), because the bug being pinned is arithmetic
 * over those groups, not SQL.
 */

type RawRow = Record<string, unknown>;

interface StubQueryBuilder {
  /** Every WHERE/andWHERE clause the service asked for, in order. */
  wheres: string[];
  select: jest.Mock;
  addSelect: jest.Mock;
  setParameter: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  getRawMany: jest.Mock;
}

/** A query builder stub that records its WHERE clauses and returns fixed rows. */
function stubQueryBuilder(rows: RawRow[]): StubQueryBuilder {
  const wheres: string[] = [];

  const builder: StubQueryBuilder = {
    wheres,
    select: jest.fn(() => builder),
    addSelect: jest.fn(() => builder),
    setParameter: jest.fn(() => builder),
    where: jest.fn((clause: string) => {
      wheres.push(clause);

      return builder;
    }),
    andWhere: jest.fn((clause: string) => {
      wheres.push(clause);

      return builder;
    }),
    groupBy: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    getRawMany: jest.fn(async () => rows),
  };

  return builder;
}

function stubRepository(options: { rows?: RawRow[]; entities?: unknown[]; count?: number } = {}) {
  const builders: StubQueryBuilder[] = [];

  return {
    builders,
    find: jest.fn(async () => options.entities ?? []),
    count: jest.fn(async () => options.count ?? 0),
    createQueryBuilder: jest.fn(() => {
      const builder = stubQueryBuilder(options.rows ?? []);

      builders.push(builder);

      return builder;
    }),
  };
}

/**
 * A job repository stub whose query builder actually applies its predicates
 * to `jobs`, instead of returning fixed rows regardless of the query. Needed
 * to prove a row is excluded from a distribution's output, not just that the
 * exclusion clause was requested.
 */
function stubFilteringJobRepository(jobs: Array<{ name: string; state: string; data: RawRow }>) {
  return {
    find: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => {
      const clauses: Array<{ clause: string; params?: RawRow }> = [];
      const applyWhere = (clause: string, params?: RawRow) => {
        clauses.push({ clause, params });

        return builder;
      };

      const builder: Omit<StubQueryBuilder, 'wheres'> = {
        select: jest.fn(() => builder),
        addSelect: jest.fn(() => builder),
        setParameter: jest.fn(() => builder),
        where: jest.fn(applyWhere),
        andWhere: jest.fn(applyWhere),
        groupBy: jest.fn(() => builder),
        orderBy: jest.fn(() => builder),
        limit: jest.fn(() => builder),
        getRawMany: jest.fn(async () => {
          let rows = jobs;

          for (const { clause, params } of clauses) {
            if (clause.includes('job.state IN')) {
              const states = params?.states as string[];
              rows = rows.filter((job) => states.includes(job.state));
            } else if (clause.includes('!= :deadLetter')) {
              rows = rows.filter((job) => job.name !== params?.deadLetter);
            } else if (clause.includes("data->>'name' = :eventName")) {
              rows = rows.filter((job) => job.data.name === params?.eventName);
            }
          }

          const counts = new Map<string, number>();
          for (const job of rows) {
            const workType = (job.data.workType as string | undefined) ?? 'unknown';
            counts.set(workType, (counts.get(workType) ?? 0) + 1);
          }

          return Array.from(counts, ([workType, count]) => ({ workType, count }));
        }),
      };

      return builder;
    }),
  };
}

function makeService(options: {
  jobStateRows?: RawRow[];
  archiveStateRows?: RawRow[];
  cronJobs?: Map<string, unknown>;
  jobEntities?: unknown[];
}) {
  // getSummary asks the job repo for grouped state rows; the distribution
  // queries reuse the same repo, so the stub returns the same rows to all of
  // them. Only the summary's arithmetic is under test here.
  const jobRepository = stubRepository({
    rows: options.jobStateRows ?? [],
    entities: options.jobEntities ?? [],
  });
  const archiveRepository = stubRepository({ rows: options.archiveStateRows ?? [] });
  const scheduleRepository = stubRepository({ count: 0 });
  const queueRepository = stubRepository();

  const schedulerRegistry = {
    getCronJobs: () => options.cronJobs ?? new Map(),
  } as unknown as SchedulerRegistry;

  const service = new JobMonitorService(
    jobRepository as unknown as Repository<PgBossJobEntity>,
    archiveRepository as unknown as Repository<PgBossArchiveEntity>,
    scheduleRepository as unknown as Repository<PgBossScheduleEntity>,
    queueRepository as unknown as Repository<PgBossQueueEntity>,
    schedulerRegistry,
  );

  return { service, jobRepository, archiveRepository };
}

const context = { userId: 'user-1' };

describe('JobMonitorService.getDashboard', () => {
  it('refuses to report anything without a user context', async () => {
    const { service } = makeService({});

    await expect(service.getDashboard({})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still returns the queue summary when ci.cron_runs.last_success_at is missing', async () => {
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockRejectedValueOnce(
        Object.assign(new Error('column "last_success_at" does not exist'), { code: '42703' }),
      );

    try {
      const { service } = makeService({
        jobStateRows: [{ state: 'active', count: 2, deadLettered: 0 }],
      });
      const dash = await service.getDashboard(context);

      expect(dash.summary.active).toBe(2);
      expect(dash.crons).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The defect this pins: pg-boss inserts a dead-lettered job into the
   * `dead-letter` queue in state `created` — byte-identical, by state, to work
   * that is waiting to run. Counting `state = 'created'` across every queue
   * therefore reported jobs that had already exhausted their retries as a live
   * backlog, WHILE the same jobs were also counted under `failed` on the queue
   * they came from. Measured on a live appliance: 1,191 of a reported 13,907
   * "pending" jobs were dead, and the "failed" tile showed the same 1,191.
   */
  it('excludes dead letters from pending and counts them separately', async () => {
    const { service } = makeService({
      jobStateRows: [
        { state: 'created', count: 13907, deadLettered: 1191 },
        { state: 'active', count: 12, deadLettered: 0 },
        { state: 'retry', count: 3, deadLettered: 0 },
        { state: 'failed', count: 821, deadLettered: 0 },
        { state: 'completed', count: 26837, deadLettered: 0 },
      ],
      archiveStateRows: [
        { state: 'completed', count: 88298 },
        { state: 'failed', count: 370 },
      ],
    });

    const { summary } = await service.getDashboard(context);

    // 13907 created - 1191 dead-lettered = the work actually waiting to run.
    expect(summary.pending).toBe(12716);
    expect(summary.deadLettered).toBe(1191);
    expect(summary.active).toBe(12);
    expect(summary.retry).toBe(3);
    expect(summary.completed).toBe(26837 + 88298);
    expect(summary.failed).toBe(821 + 370);
  });

  it('reports zero rather than a negative when every created job is dead-lettered', async () => {
    const { service } = makeService({
      jobStateRows: [{ state: 'created', count: 40, deadLettered: 40 }],
    });

    const { summary } = await service.getDashboard(context);

    expect(summary.pending).toBe(0);
    expect(summary.deadLettered).toBe(40);
  });

  it('reports zeroes for states absent from the grouped rows', async () => {
    const { service } = makeService({ jobStateRows: [{ state: 'active', count: 2, deadLettered: 0 }] });

    const { summary } = await service.getDashboard(context);

    expect(summary).toMatchObject({
      pending: 0,
      active: 2,
      retry: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      deadLettered: 0,
    });
  });

  /**
   * The same exclusion has to hold for the charts, or "what is the appliance
   * working on?" is topped by jobs that already gave up. Asserted on the WHERE
   * clauses because the stub returns rows regardless of the filter.
   */
  it('filters the dead-letter queue out of the live-work distributions', async () => {
    const { service, jobRepository } = makeService({ jobStateRows: [] });

    await service.getDashboard(context);

    const clauses = jobRepository.builders.flatMap((builder) => builder.wheres);
    const deadLetterExclusions = clauses.filter((clause) => clause.includes('!= :deadLetter'));

    // The by-handler, by-queue, and smart.rotation.work distributions must all exclude it.
    expect(deadLetterExclusions).toHaveLength(3);
  });

  /**
   * getSmartRotationDistribution used to be missing this exclusion entirely —
   * a dead-lettered smart.rotation.work job (state `created`, like live work)
   * inflated its own workType bucket exactly the way the other two
   * distributions were fixed to avoid above. Filtering happens for real here,
   * not just clause-presence, because the bug is in what comes OUT.
   */
  it('excludes a dead-lettered smart.rotation.work job from the rotation distribution', async () => {
    const jobRepository = stubFilteringJobRepository([
      {
        name: 'smart-rotation',
        state: 'created',
        data: { name: 'smart.rotation.work', workType: 'geo-refresh' },
      },
      {
        name: 'smart-rotation',
        state: 'active',
        data: { name: 'smart.rotation.work', workType: 'geo-refresh' },
      },
      {
        name: 'dead-letter',
        state: 'created',
        data: { name: 'smart.rotation.work', workType: 'geo-refresh' },
      },
    ]);
    const archiveRepository = stubRepository();
    const scheduleRepository = stubRepository({ count: 0 });
    const queueRepository = stubRepository();
    const schedulerRegistry = { getCronJobs: () => new Map() } as unknown as SchedulerRegistry;

    const service = new JobMonitorService(
      jobRepository as unknown as Repository<PgBossJobEntity>,
      archiveRepository as unknown as Repository<PgBossArchiveEntity>,
      scheduleRepository as unknown as Repository<PgBossScheduleEntity>,
      queueRepository as unknown as Repository<PgBossQueueEntity>,
      schedulerRegistry,
    );

    const { smartRotationDistribution } = await service.getDashboard(context);

    // The dead-lettered row must not inflate the count.
    expect(smartRotationDistribution).toEqual([{ workType: 'geo-refresh', count: 2 }]);
  });

  /**
   * The endpoint is guarded by "some user is authenticated" and returns the 25
   * newest rows with no owner predicate, so a job payload it serialises is
   * handed to whoever opens /jobs — not to the user who generated it.
   * `graph.person.created` carries name, email, phone and bio;
   * `graph.node.upserted` carries the node's name, description and searchable
   * text.
   *
   * Nothing that is not on this projection may cross the wire.
   */
  it('never returns a raw job payload or output', async () => {
    const timestamp = new Date('2026-08-17T00:00:00.000Z');

    const { service } = makeService({
      jobEntities: [
        {
          id: 'job-1',
          name: 'default',
          state: 'failed',
          priority: 0,
          retryLimit: 3,
          retryCount: 3,
          retryDelay: 10,
          retryBackoff: true,
          createdOn: timestamp,
          startAfter: timestamp,
          deadLetter: 'dead-letter',
          policy: 'standard',
          data: {
            name: 'graph.person.created',
            workType: null,
            email: 'someone.else@example.com',
            bio: 'private biography text',
          },
          output: {
            message: 'column fq.metadata does not exist',
            stack: 'QueryFailedError: column fq.metadata does not exist',
            failedAt: '2026-08-17T04:42:09.806Z',
          },
        },
      ],
    });

    const { jobs } = await service.getDashboard(context);
    const [record] = jobs;
    const serialised = JSON.stringify(jobs);

    expect(record).not.toHaveProperty('data');
    expect(record).not.toHaveProperty('output');
    expect(serialised).not.toContain('someone.else@example.com');
    expect(serialised).not.toContain('private biography text');

    // ...while everything the dashboard actually renders survives.
    expect(record.event).toBe('graph.person.created');
    expect(record.payloadBytes).toBeGreaterThan(0);
    expect(record.failure).toEqual({
      message: 'column fq.metadata does not exist',
      stack: 'QueryFailedError: column fq.metadata does not exist',
      failedAt: '2026-08-17T04:42:09.806Z',
    });
  });

  it('projects a deferred success payload to no failure at all', async () => {
    const timestamp = new Date('2026-08-17T00:00:00.000Z');

    const { service } = makeService({
      jobEntities: [
        {
          id: 'job-2',
          name: 'py-fn-summary',
          state: 'completed',
          priority: 0,
          retryLimit: 3,
          retryCount: 0,
          retryDelay: 10,
          retryBackoff: true,
          createdOn: timestamp,
          startAfter: timestamp,
          data: { name: 'python.function.run' },
          // Deferred completions write real success payloads here, and those can
          // carry user content. No `message` means no failure — and nothing else
          // from this object is copied out.
          output: { summary: 'a private summary of the user documents' },
        },
      ],
    });

    const { jobs } = await service.getDashboard(context);

    expect(jobs[0].failure).toBeNull();
    expect(JSON.stringify(jobs)).not.toContain('a private summary');
  });

  /**
   * `pgboss.schedule` is empty on every appliance — nothing calls
   * `boss.schedule()`. The recurring jobs that DO run are NestJS `@Cron`
   * methods, and until this they were absent from the dashboard entirely.
   */
  it('reports the recurring jobs from the live scheduler registry', async () => {
    const nextRun = { toISO: () => '2026-08-17T01:00:00.000Z' };
    const lastRun = new Date('2026-08-17T00:00:00.000Z');

    const cronJobs = new Map<string, unknown>([
      [
        'PipelineTickCron.tick',
        {
          cronTime: { source: '0 */2 * * * *', timeZone: 'UTC' },
          isActive: true,
          nextDate: () => nextRun,
          lastDate: () => lastRun,
        },
      ],
      [
        'ActivityRollupCron.rollup',
        {
          cronTime: { source: '0 0 * * * *' },
          isActive: false,
          // A stopped job throws rather than returning a next date.
          nextDate: () => {
            throw new Error('job is stopped');
          },
          lastDate: () => null,
        },
      ],
    ]);

    const { service } = makeService({ cronJobs });

    const { crons } = await service.getDashboard(context);

    expect(crons).toEqual([
      {
        name: 'ActivityRollupCron.rollup',
        cron: '0 0 * * * *',
        timezone: null,
        running: false,
        nextRunAt: null,
        lastRunAt: null,
        lastSuccessAt: null,
        overdue: false,
      },
      {
        name: 'PipelineTickCron.tick',
        cron: '0 */2 * * * *',
        timezone: 'UTC',
        running: true,
        nextRunAt: '2026-08-17T01:00:00.000Z',
        lastRunAt: '2026-08-17T00:00:00.000Z',
        lastSuccessAt: null,
        overdue: false,
      },
    ]);
  });

  it('uses durable ci.cron_runs when the process has never fired the job', async () => {
    const nextRun = { toISO: () => '2026-08-18T01:00:00.000Z' };
    const durableAt = new Date('2026-08-01T12:00:00.000Z');

    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValueOnce(
        new Map([['PipelineTickCron.tick', { lastRunAt: durableAt, lastSuccessAt: null }]]),
      );

    try {
      const cronJobs = new Map<string, unknown>([
        [
          'PipelineTickCron.tick',
          {
            cronTime: { source: '0 */2 * * * *', timeZone: 'UTC' },
            isActive: true,
            nextDate: () => nextRun,
            lastDate: () => {
              throw new Error('never fired since boot');
            },
          },
        ],
      ]);

      const { service } = makeService({ cronJobs });
      const { crons } = await service.getDashboard(context);

      expect(crons).toEqual([
        {
          name: 'PipelineTickCron.tick',
          cron: '0 */2 * * * *',
          timezone: 'UTC',
          running: true,
          nextRunAt: '2026-08-18T01:00:00.000Z',
          lastRunAt: '2026-08-01T12:00:00.000Z',
          lastSuccessAt: null,
          overdue: false,
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * A stand-in for the `cron` package's `CronTime`.
 *
 * The real class cannot be imported here — `cron` is a transitive dependency of
 * `@nestjs/schedule`, and PnP rejects an undeclared import, which is exactly why
 * the service works off the live instance the registry hands it rather than
 * parsing expressions itself. So what is modelled is the contract the service
 * depends on: the next fires from now, and a monotonic "next fire strictly after
 * this instant". Fire times are computed here from calendar arithmetic, not from
 * the service's own search, so the two can disagree.
 */
function cronTimeStub(source: string, nextFireAfter: (fromMs: number) => number) {
  return {
    source,
    timeZone: 'UTC',
    sendAt: (count: number) => {
      const fires: { toMillis: () => number }[] = [];
      let at = Date.now();

      for (let i = 0; i < count; i++) {
        at = nextFireAfter(at);
        const fireAt = at;
        fires.push({ toMillis: () => fireAt });
      }

      return fires;
    },
    getNextDateFrom: (start: Date) => {
      const at = nextFireAfter(start.getTime());

      return { toMillis: () => at, toISO: () => new Date(at).toISOString() };
    },
  };
}

/** Every two minutes on the minute, the cadence of the pipeline tick. */
const everyTwoMinutes = cronTimeStub(
  '0 */2 * * * *',
  (fromMs) => (Math.floor(fromMs / (2 * MINUTE)) + 1) * 2 * MINUTE,
);

/**
 * 09:00 UTC Monday–Friday. The case that rules out estimating the previous fire
 * as "next fire minus one cadence": read on a Saturday, the next two fires are
 * Monday and Tuesday — a one-day gap that lands on Sunday, a day the job never
 * runs, while the real previous fire was Friday.
 */
/**
 * 09:00 UTC Monday–Friday. The case that rules out estimating the previous fire
 * as "next fire minus one cadence": read on a Saturday, the next two fires are
 * Monday and Tuesday — a one-day gap that puts the estimate on Sunday, a day the
 * job never runs, while the real previous fire was Friday.
 */
const weekdaysAtNine = cronTimeStub('0 0 9 * * 1-5', (fromMs) => {
  const from = new Date(fromMs);
  let candidate = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 9, 0, 0);

  for (let day = 0; day <= 7; day++, candidate += DAY) {
    const weekday = new Date(candidate).getUTCDay();

    if (candidate > fromMs && weekday >= 1 && weekday <= 5) {
      return candidate;
    }
  }

  throw new Error('no weekday fire within a week');
});

async function cronRow(cronTime: unknown, lastRunAt: Date) {
  const spy = jest
    .spyOn(CronRunStore, 'runsByName')
    .mockResolvedValue(new Map([['Probe.tick', { lastRunAt, lastSuccessAt: null }]]));

  try {
    const cronJobs = new Map<string, unknown>([
      [
        'Probe.tick',
        {
          cronTime,
          isActive: true,
          nextDate: () => null,
          lastDate: () => null,
        },
      ],
    ]);

    const { service } = makeService({ cronJobs });
    const { crons } = await service.getDashboard(context);

    return crons[0];
  } finally {
    spy.mockRestore();
  }
}

/**
 * `running` is not health: the `@Cron` wrapper catches and returns, so a
 * schedule whose body throws every tick stays started with a two-minute-old
 * "last run" forever. Overdue is the only signal that says the scheduler
 * stopped firing something.
 */
describe('JobMonitorService cron overdue detection', () => {
  const saturdayNoon = Date.UTC(2026, 7, 22, 12, 0, 0);

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flags a schedule that has missed its own fire time', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    const cron = await cronRow(everyTwoMinutes, new Date(saturdayNoon - 30 * MINUTE));

    expect(cron.overdue).toBe(true);
  });

  it('leaves a schedule that fired on cadence alone', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    const cron = await cronRow(everyTwoMinutes, new Date(saturdayNoon - MINUTE));

    expect(cron.overdue).toBe(false);
  });

  it('does not call a weekday job overdue over a weekend it was never due', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    const fridayNine = Date.UTC(2026, 7, 21, 9, 0, 0);
    const cron = await cronRow(weekdaysAtNine, new Date(fridayNine));

    expect(cron.overdue).toBe(false);
  });

  it('flags a weekday job that skipped the weekdays it was due', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    const wednesdayNine = Date.UTC(2026, 7, 19, 9, 0, 0);
    const cron = await cronRow(weekdaysAtNine, new Date(wednesdayNine));

    expect(cron.overdue).toBe(true);
  });

  it('stays quiet when nothing has ever been recorded', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    const spy = jest.spyOn(CronRunStore, 'runsByName').mockResolvedValue(new Map());

    try {
      const cronJobs = new Map<string, unknown>([
        [
          'Probe.tick',
          {
            cronTime: everyTwoMinutes,
            isActive: true,
            nextDate: () => null,
            lastDate: () => null,
          },
        ],
      ]);

      const { service } = makeService({ cronJobs });
      const { crons } = await service.getDashboard(context);

      expect(crons[0]).toMatchObject({ lastRunAt: null, overdue: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the last successful tick apart from the last attempt', async () => {
    const attemptedAt = new Date('2026-08-20T11:58:00.000Z');
    const succeededAt = new Date('2026-08-01T09:00:00.000Z');

    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(new Map([['Probe.tick', { lastRunAt: attemptedAt, lastSuccessAt: succeededAt }]]));

    try {
      const cronJobs = new Map<string, unknown>([
        [
          'Probe.tick',
          {
            cronTime: { source: '0 */2 * * * *' },
            isActive: true,
            nextDate: () => null,
            lastDate: () => null,
          },
        ],
      ]);

      const { service } = makeService({ cronJobs });
      const { crons } = await service.getDashboard(context);

      expect(crons[0]).toMatchObject({
        running: true,
        lastRunAt: attemptedAt.toISOString(),
        lastSuccessAt: succeededAt.toISOString(),
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('JobMonitorService.fireCronJobs', () => {
  it('fires every registered cron once', () => {
    const ticks: string[] = [];
    const cronJobs = new Map<string, unknown>([
      ['A.run', { fireOnTick: () => ticks.push('A.run') }],
      ['B.run', { fireOnTick: () => ticks.push('B.run') }],
    ]);
    const { service } = makeService({ cronJobs });

    expect(service.fireCronJobs()).toEqual({
      fired: ['A.run', 'B.run'],
      skipped: [],
      errors: [],
    });
    expect(ticks).toEqual(['A.run', 'B.run']);
  });

  it('can fire a single named cron and skip the rest', () => {
    const ticks: string[] = [];
    const cronJobs = new Map<string, unknown>([
      ['A.run', { fireOnTick: () => ticks.push('A.run') }],
      ['B.run', { fireOnTick: () => ticks.push('B.run') }],
    ]);
    const { service } = makeService({ cronJobs });

    expect(service.fireCronJobs(['B.run'])).toEqual({
      fired: ['B.run'],
      skipped: ['A.run'],
      errors: [],
    });
    expect(ticks).toEqual(['B.run']);
  });

  it('records a fireOnTick throw without stopping the sweep', () => {
    const cronJobs = new Map<string, unknown>([
      [
        'bad.run',
        {
          fireOnTick: () => {
            throw new Error('boom');
          },
        },
      ],
      ['ok.run', { fireOnTick: () => undefined }],
    ]);
    const { service } = makeService({ cronJobs });

    expect(service.fireCronJobs()).toEqual({
      fired: ['ok.run'],
      skipped: [],
      errors: [{ name: 'bad.run', error: 'boom' }],
    });
  });
});
