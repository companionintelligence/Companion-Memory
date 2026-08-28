import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { CronRunStore } from '@ci/common/schedule';
import {
  OrphanCleanupService,
  type OrphanCleanupOptions,
  type OrphanCleanupResult,
} from '@ci/domains/search-ingress';

import {
  ORPHAN_CLEANUP_BATCH_SIZE,
  ORPHAN_CLEANUP_CRON,
  ORPHAN_CLEANUP_STATEMENT_TIMEOUT_MS,
  OrphanCleanupCron,
} from '../OrphanCleanupCron';
import { RETRIEVAL_HEALTH_CRON } from '../RetrievalHealthCron';

/**
 * `OrphanCleanupService.cleanOrphans()` was finished, bounded, batched and
 * tested — and reachable only from two manual HTTP routes, so search-index
 * orphans accumulated until somebody thought to click. These tests pin the one
 * thing that was missing: that something fires it, on a schedule, under a name
 * the Jobs dashboard can find it by.
 */

const SCHEDULE_NAME = 'OrphanCleanupCron.sweepOnSchedule';

/** Seconds past midnight a fixed `second minute hour * * *` expression fires at. */
function timeOfDaySeconds(expression: string): number {
  const [second, minute, hour, ...rest] = expression.split(' ');

  // Only meaningful for a once-a-day expression; assert that rather than
  // silently comparing two things that never line up.
  expect(rest).toEqual(['*', '*', '*']);
  for (const field of [second, minute, hour]) {
    expect(Number.isInteger(Number(field))).toBe(true);
  }

  return Number(hour) * 3600 + Number(minute) * 60 + Number(second);
}

const stubLogger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }) as unknown as LoggerService;

function result(totalDeleted: number, dryRun: boolean): OrphanCleanupResult {
  return {
    results: [{ searchTable: 'ci_search.embeddings', entityType: 'event', deleted: totalDeleted }],
    totalDeleted,
    dryRun,
  };
}

/** A stand-in that records how the sweep was asked for. */
function build(counts: { swept: number }) {
  const calls: OrphanCleanupOptions[] = [];

  const cleanOrphans = jest.fn(async (options: OrphanCleanupOptions = {}) => {
    calls.push(options);

    return result(counts.swept, options.dryRun === true);
  });

  const service = { cleanOrphans } as unknown as OrphanCleanupService;
  const logger = stubLogger();

  return { cron: new OrphanCleanupCron(service, logger), cleanOrphans, calls, logger };
}

describe('OrphanCleanupCron schedule', () => {
  it('runs nightly at a second-offset, not on second 0 with the other twelve', () => {
    const fields = ORPHAN_CLEANUP_CRON.split(' ');
    const [second, minute, hour, dayOfMonth, month, dayOfWeek] = fields;

    expect(fields).toHaveLength(6);
    expect(Number(second)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(minute))).toBe(true);
    expect(Number.isInteger(Number(hour))).toBe(true);
    // Nightly: a fixed hour, every day.
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
  });

  /**
   * Sweep BEFORE measure, and this ordering is load-bearing.
   *
   * `EmbedCoverageTelemetryService` reports `embedded / total`, where `embedded`
   * is a plain count of `ci_search.embeddings` rows for the type — orphans
   * included. An orphan therefore inflates the numerator and not the
   * denominator, so a health snapshot taken over an unswept index reads a type
   * as better covered than it is (and `ratio` clamps at 1). Accumulated orphans
   * would mask the very coverage hole the health cron exists to find.
   *
   * Stated as an ordering, not a fixed time: RetrievalHealthCron may move
   * anywhere later in the night without failing this.
   */
  it('sweeps before RetrievalHealthCron measures, so orphans cannot inflate the coverage ratio', () => {
    expect(timeOfDaySeconds(ORPHAN_CLEANUP_CRON)).toBeLessThan(timeOfDaySeconds(RETRIEVAL_HEALTH_CRON));
  });
});

describe('OrphanCleanupCron sweep', () => {
  /**
   * One pass, not two.
   *
   * The sweep's unit of work is an anti-join between an index table and a source
   * table, issued once per (index table x indexable type) — the heaviest
   * scheduled query shape on the appliance. A `dryRun` survey ahead of the
   * delete doubles that for a "would remove N" log line nothing branches on, and
   * the delete pass reports the same number having actually done the work.
   */
  it('deletes in a single pass and logs what it actually reclaimed', async () => {
    const { cron, cleanOrphans, calls, logger } = build({ swept: 7 });

    const summary = await cron.sweepOnce();

    expect(cleanOrphans).toHaveBeenCalledTimes(1);
    expect(calls[0]?.dryRun).toBeUndefined();

    expect(logger.log).toHaveBeenCalledWith(
      'Nightly orphan sweep complete',
      expect.objectContaining({ deleted: 7 }),
    );
    expect(summary).toEqual({ deleted: 7 });
  });

  it('bounds every statement, so the nightly sweep cannot take a long lock on the live index', async () => {
    const { cron, calls } = build({ swept: 3 });

    await cron.sweepOnce();

    expect(ORPHAN_CLEANUP_BATCH_SIZE).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.batchSize).toBe(ORPHAN_CLEANUP_BATCH_SIZE);
    }
  });

  /**
   * Its sibling `RetrievalHealthCron` measures under a ceiling; this sweep is
   * the heavier of the two and runs with nobody watching, so it must not be the
   * one that can pin a connection out of the pool indefinitely.
   */
  it('bounds every statement in time as well as in rows', async () => {
    const { cron, calls } = build({ swept: 1 });

    await cron.sweepOnce();

    expect(ORPHAN_CLEANUP_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.statementTimeoutMs).toBe(ORPHAN_CLEANUP_STATEMENT_TIMEOUT_MS);
    }
  });

  it('sweeps every indexable type — it never narrows entityTypes, or a type silently keeps its orphans', async () => {
    const { cron, calls } = build({ swept: 1 });

    await cron.sweepOnce();

    for (const call of calls) {
      expect(call.entityTypes).toBeUndefined();
    }
  });

  it('reports a clean index as nothing reclaimed', async () => {
    const { cron, cleanOrphans } = build({ swept: 0 });

    const summary = await cron.sweepOnce();

    expect(cleanOrphans).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ deleted: 0 });
  });

  it('never stamps a failed sweep a success', async () => {
    const { cron, cleanOrphans } = build({ swept: 1 });

    cleanOrphans.mockRejectedValueOnce(new Error('database went away'));

    const record = jest.spyOn(CronRunStore, 'record').mockImplementation(() => undefined);
    const recordSuccess = jest.spyOn(CronRunStore, 'recordSuccess').mockImplementation(() => undefined);

    try {
      // The @ci/common/schedule wrapper swallows so the schedule survives, but
      // it only records success when the body RETURNS. Catching inside
      // sweepOnSchedule would return normally and paint a permanently broken
      // sweep green on the Jobs dashboard.
      await expect(cron.sweepOnSchedule()).resolves.toBeUndefined();

      expect(record).toHaveBeenCalledWith(SCHEDULE_NAME);
      expect(recordSuccess).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
      recordSuccess.mockRestore();
    }
  });
});

/**
 * The dashboard joins the live SchedulerRegistry to the durable `ci.cron_runs`
 * row on the schedule name, so an unregistered — or differently-named — cron
 * is invisible there and cannot be fired by hand. This is the test that fails
 * if the schedule is removed.
 */
describe('OrphanCleanupCron schedule identity', () => {
  it('registers with the scheduler under the same name it stamps ci.cron_runs with', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        OrphanCleanupCron,
        {
          provide: OrphanCleanupService,
          useValue: { cleanOrphans: jest.fn().mockResolvedValue(result(0, false)) },
        },
        { provide: LoggerService, useValue: stubLogger() },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();

    try {
      await app.init();

      const registered = Array.from(app.get(SchedulerRegistry).getCronJobs().keys());

      expect(registered).toContain(SCHEDULE_NAME);

      const record = jest.spyOn(CronRunStore, 'record').mockImplementation(() => undefined);

      try {
        await app.get(OrphanCleanupCron).sweepOnSchedule();

        expect(record).toHaveBeenCalledWith(SCHEDULE_NAME);
      } finally {
        record.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
});

/**
 * Reclamation is worker work. The `role` option is resolved at module-load
 * time, so the only way to observe the gate is to re-import the class against a
 * process that does not serve the worker half and watch whether the underlying
 * `@nestjs/schedule` decorator is applied at all.
 */
describe('OrphanCleanupCron role', () => {
  async function scheduledUnderRole(processRole: 'web' | 'worker'): Promise<Array<string | undefined>> {
    const applied: Array<string | undefined> = [];

    await jest.isolateModulesAsync(async () => {
      jest.doMock('@ci/common/roles', () => ({
        processRole: () => processRole,
        serves: (target: string) => target === processRole,
      }));

      const schedule = jest.requireActual<typeof import('@nestjs/schedule')>('@nestjs/schedule');

      jest.doMock('@nestjs/schedule', () => ({
        ...schedule,
        Cron: (expression: string, options?: { name?: string }) => {
          applied.push(options?.name);

          return schedule.Cron(expression, options);
        },
      }));

      // The cron only needs this symbol as a DI token; stubbing it keeps the
      // isolated registry from re-executing the whole search-ingress barrel.
      jest.doMock('@ci/domains/search-ingress', () => ({ OrphanCleanupService: class {} }));

      await import('../OrphanCleanupCron');
    });

    return applied;
  }

  it('schedules on the worker and stays silent on the web process', async () => {
    expect(await scheduledUnderRole('worker')).toEqual([SCHEDULE_NAME]);
    expect(await scheduledUnderRole('web')).toEqual([]);
  });
});
