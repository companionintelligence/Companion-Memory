import { UnauthorizedException } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { DataSource, Repository } from 'typeorm';

import { JobControlStore } from '@ci/common/job-controls';
import { CronRegistry, CronRunStore } from '@ci/common/schedule';

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

// The registry is a module-level singleton filled by `@Cron` at import time.
// Nothing here imports a cron class, so it is already empty — cleared anyway so
// a test that declares into it cannot leak rows into the next one's dashboard.
beforeEach(() => {
  CronRegistry.clear();
});

afterEach(() => {
  CronRegistry.clear();
});

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
        disabled: false,
        role: 'web',
        servedHere: true,
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
        disabled: false,
        role: 'web',
        servedHere: true,
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
          disabled: false,
          role: 'web',
          servedHere: true,
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

  it('reports a schedule the operator switched off as disabled, not overdue', async () => {
    jest.useFakeTimers({ now: saturdayNoon });

    await JobControlStore.configure({
      query: (sql: string) =>
        sql.includes('UPDATE ci.job_settings')
          ? Promise.resolve([])
          : Promise.resolve([
              {
                kind: 'cron',
                key: 'Probe.tick',
                mode: 'disabled',
                concurrency: null,
                skipped_count: '0',
                last_skipped_at: null,
                updated_at: new Date(),
              },
            ]),
    } as unknown as DataSource);

    try {
      // A disabled schedule is not late — it is doing exactly what it was told.
      // Reporting it as overdue would turn every deliberate choice into an alarm
      // and teach operators to ignore the column that catches real failures.
      const cron = await cronRow(everyTwoMinutes, new Date(saturdayNoon - 30 * MINUTE));

      expect(cron).toMatchObject({ disabled: true, overdue: false });
    } finally {
      await JobControlStore.configure(null);
    }
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

describe('JobMonitorService schedules the answering process does not run', () => {
  it('lists a worker schedule with its durable history and no invented live state', async () => {
    // Under CI_ROLE=web the 11 `role: 'worker'` schedules never register, so this
    // card reported 42 of 53 — leaving no health signal at all for the derivation
    // pass or the import retention purge. The durable half was already in hand:
    // `ci.cron_runs` is written by whichever process ticks, and these rows were
    // being loaded and thrown away for want of a registry entry.
    const lastRunAt = new Date('2026-09-01T03:00:00.000Z');
    // Half an hour after a daily tick: on cadence, so `overdue` is a computed
    // false here rather than the hardcoded one it used to be.
    jest.useFakeTimers({ now: lastRunAt.getTime() + 30 * 60_000 });
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(new Map([['DerivationCron.deriveNightly', { lastRunAt, lastSuccessAt: null }]]));

    try {
      CronRegistry.declare({
        name: 'DerivationCron.deriveNightly',
        cron: '0 0 3 * * *',
        timeZone: null,
        role: 'worker',
        servedHere: false,
      });

      const cronJobs = new Map<string, unknown>([
        [
          'PipelineTickCron.tick',
          {
            cronTime: { source: '0 */2 * * * *', timeZone: 'UTC' },
            isActive: true,
            nextDate: () => null,
            lastDate: () => null,
          },
        ],
      ]);

      const { service } = makeService({ cronJobs });
      const { crons } = await service.getDashboard(context);

      expect(crons.map((cron) => cron.name)).toEqual([
        'DerivationCron.deriveNightly',
        'PipelineTickCron.tick',
      ]);

      const derivation = crons.find((cron) => cron.name === 'DerivationCron.deriveNightly');

      // Durable state: real, and the same whichever process reads it.
      expect(derivation).toMatchObject({
        cron: '0 0 3 * * *',
        role: 'worker',
        servedHere: false,
        lastRunAt: lastRunAt.toISOString(),
        lastSuccessAt: null,
      });

      // Live state: not this process's to claim. `running` is null rather than
      // false — false renders as "stopped", and a schedule ticking perfectly
      // well in the worker is the last thing that should read as stopped here.
      expect(derivation?.running).toBeNull();
      expect(derivation?.nextRunAt).toBeNull();
      expect(derivation?.overdue).toBe(false);
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('lets the "run and never succeeded" signal reach a worker schedule', async () => {
    // The page's own critical verdict reads this list, so while the 11 were
    // missing it could not fire for any of them however long one had been
    // failing. `lastRunAt` set with `lastSuccessAt` null is exactly that shape.
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(
        new Map([['OrphanCleanupCron.sweepOnSchedule', { lastRunAt: new Date(), lastSuccessAt: null }]]),
      );

    try {
      CronRegistry.declare({
        name: 'OrphanCleanupCron.sweepOnSchedule',
        cron: '0 30 4 * * *',
        timeZone: null,
        role: 'worker',
        servedHere: false,
      });

      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);
      const orphan = crons.find((cron) => cron.name === 'OrphanCleanupCron.sweepOnSchedule');

      expect(orphan?.lastRunAt).not.toBeNull();
      expect(orphan?.lastSuccessAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the operator switch for a schedule it does not run', async () => {
    CronRegistry.declare({
      name: 'ImportRetentionCron.runOnSchedule',
      cron: '0 0 5 * * 0',
      timeZone: null,
      role: 'worker',
      servedHere: false,
    });

    await JobControlStore.configure({
      query: (sql: string) =>
        sql.includes('UPDATE ci.job_settings')
          ? Promise.resolve([])
          : Promise.resolve([
              {
                kind: 'cron',
                key: 'ImportRetentionCron.runOnSchedule',
                mode: 'disabled',
                concurrency: null,
                skipped_count: '0',
                last_skipped_at: null,
                updated_at: new Date(),
              },
            ]),
    } as unknown as DataSource);

    try {
      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);

      // The setting is appliance-wide, so "off" is as true here as in the
      // process that would have ticked it.
      expect(crons[0]).toMatchObject({ name: 'ImportRetentionCron.runOnSchedule', disabled: true });
    } finally {
      await JobControlStore.configure(null);
    }
  });

  it('reports a registered schedule by its declared role, not the process role', async () => {
    // Under CI_ROLE=all — the single-process default — every worker schedule
    // registers with the local scheduler, and deriving `role` from the process
    // role reported all eleven as `web`. Role is a fact about the build, and the
    // preview fixture already models it that way.
    CronRegistry.declare({
      name: 'DerivationCron.deriveNightly',
      cron: '0 0 3 * * *',
      timeZone: null,
      role: 'worker',
      servedHere: true,
    });

    const cronJobs = new Map<string, unknown>([
      [
        'DerivationCron.deriveNightly',
        {
          cronTime: { source: '0 0 3 * * *', timeZone: 'UTC' },
          isActive: true,
          nextDate: () => null,
          lastDate: () => null,
        },
      ],
    ]);

    const { service } = makeService({ cronJobs });
    const { crons } = await service.getDashboard(context);

    expect(crons.find((cron) => cron.name === 'DerivationCron.deriveNightly')).toMatchObject({
      role: 'worker',
      servedHere: true,
    });
  });

  it('flags a worker schedule as overdue from its durable last attempt', async () => {
    // A daily 03:00 schedule whose last attempt is three days old. Nothing local
    // registered it, so the verdict comes from the declaration's expression
    // evaluated against ci.cron_runs — which is the signal that says the worker
    // process is dead, and the one that used to be hardcoded false.
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    jest.useFakeTimers({ now });
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(
        new Map([
          [
            'DerivationCron.deriveNightly',
            { lastRunAt: new Date(now - 3 * 24 * 60 * 60_000), lastSuccessAt: null },
          ],
        ]),
      );

    try {
      CronRegistry.declare({
        name: 'DerivationCron.deriveNightly',
        cron: '0 0 3 * * *',
        timeZone: 'UTC',
        role: 'worker',
        servedHere: false,
      });

      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);

      expect(crons[0]).toMatchObject({
        name: 'DerivationCron.deriveNightly',
        servedHere: false,
        overdue: true,
      });
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('leaves a worker schedule that fired on cadence alone', async () => {
    // 05:00 after a 03:00 tick: past the one-hour grace, so the expression is
    // actually evaluated, and the previous expected fire is the one recorded.
    const now = Date.UTC(2026, 8, 4, 5, 0, 0);
    jest.useFakeTimers({ now });
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(
        new Map([
          [
            'DerivationCron.deriveNightly',
            { lastRunAt: new Date(Date.UTC(2026, 8, 4, 3, 0, 0)), lastSuccessAt: null },
          ],
        ]),
      );

    try {
      CronRegistry.declare({
        name: 'DerivationCron.deriveNightly',
        cron: '0 0 3 * * *',
        timeZone: 'UTC',
        role: 'worker',
        servedHere: false,
      });

      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);

      expect(crons[0]?.overdue).toBe(false);
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('reports a switched-off worker schedule as disabled, not overdue', async () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    jest.useFakeTimers({ now });
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(
        new Map([
          [
            'ImportRetentionCron.runOnSchedule',
            { lastRunAt: new Date(now - 9 * 24 * 60 * 60_000), lastSuccessAt: null },
          ],
        ]),
      );

    CronRegistry.declare({
      name: 'ImportRetentionCron.runOnSchedule',
      cron: '0 0 5 * * 0',
      timeZone: 'UTC',
      role: 'worker',
      servedHere: false,
    });

    await JobControlStore.configure({
      query: (sql: string) =>
        sql.includes('UPDATE ci.job_settings')
          ? Promise.resolve([])
          : Promise.resolve([
              {
                kind: 'cron',
                key: 'ImportRetentionCron.runOnSchedule',
                mode: 'disabled',
                concurrency: null,
                skipped_count: '0',
                last_skipped_at: null,
                updated_at: new Date(),
              },
            ]),
    } as unknown as DataSource);

    try {
      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);

      // Same rule as a local schedule: a decision outranks a symptom.
      expect(crons[0]).toMatchObject({ disabled: true, overdue: false });
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
      await JobControlStore.configure(null);
    }
  });

  it('does not let a declaration with a bad expression take the dashboard down', async () => {
    const spy = jest
      .spyOn(CronRunStore, 'runsByName')
      .mockResolvedValue(new Map([['Broken.tick', { lastRunAt: new Date(0), lastSuccessAt: null }]]));

    try {
      CronRegistry.declare({
        name: 'Broken.tick',
        cron: 'not a cron',
        timeZone: null,
        role: 'worker',
        servedHere: false,
      });

      const { service } = makeService({ cronJobs: new Map() });
      const { crons } = await service.getDashboard(context);

      // `cron` rejects the expression; the honest verdict is "cannot say".
      expect(crons[0]).toMatchObject({ name: 'Broken.tick', overdue: false });
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

  it('reports a name it cannot fire instead of returning an empty success', () => {
    // The endpoint is documented as "docker exec into the api container and curl
    // localhost", and under the split that container is CI_ROLE=web, which holds
    // none of the 11 worker schedules. Asking it for one walked a registry the
    // name was not in and answered {fired: [], skipped: [], errors: []} — a
    // success-shaped reply to a request that did nothing.
    CronRegistry.declare({
      name: 'DerivationCron.deriveNightly',
      cron: '0 0 3 * * *',
      timeZone: null,
      role: 'worker',
      servedHere: false,
    });

    const cronJobs = new Map<string, unknown>([['A.run', { fireOnTick: () => undefined }]]);
    const { service } = makeService({ cronJobs });

    const result = service.fireCronJobs(['DerivationCron.deriveNightly']);

    expect(result.fired).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('DerivationCron.deriveNightly');
    // Naming the process that CAN fire it is the actionable half — firing across
    // processes is not possible, `fireOnTick` being a handle on a live job.
    expect(result.errors[0]?.error).toMatch(/worker process/);
  });

  it('distinguishes a schedule that is elsewhere from one that does not exist', () => {
    const cronJobs = new Map<string, unknown>([['A.run', { fireOnTick: () => undefined }]]);
    const { service } = makeService({ cronJobs });

    const result = service.fireCronJobs(['NoSuchCron.tick']);

    expect(result.fired).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/not a schedule in this build/);
  });

  it('skips a schedule the operator disabled instead of reporting it fired', async () => {
    // Manually firing a disabled cron must not report success for a run that
    // did nothing, and must not double-count the attempt against the
    // setting's drop tally on top of the skip the `@Cron` wrapper itself
    // records when the (unawaited) body actually runs.
    await JobControlStore.configure({
      query: (sql: string) =>
        sql.includes('UPDATE ci.job_settings')
          ? Promise.resolve([])
          : Promise.resolve([
              {
                kind: 'cron',
                key: 'X',
                mode: 'disabled',
                concurrency: null,
                skipped_count: '0',
                last_skipped_at: null,
                updated_at: new Date(),
              },
            ]),
    } as unknown as DataSource);

    try {
      const ticks: string[] = [];
      const cronJobs = new Map<string, unknown>([
        ['X', { fireOnTick: () => ticks.push('X') }],
        ['Y', { fireOnTick: () => ticks.push('Y') }],
      ]);
      const { service } = makeService({ cronJobs });

      const result = service.fireCronJobs();

      expect(result.fired).toEqual(['Y']);
      expect(result.skipped).toEqual(['X']);
      expect(result.errors).toEqual([]);
      // Never invoked — a disabled schedule must not run even the no-op path.
      expect(ticks).toEqual(['Y']);
    } finally {
      await JobControlStore.configure(null);
    }
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
