import type { DataSource } from 'typeorm';

import { CronRunStore } from '../CronRunStore';
import { Cron } from '../decorators/Cron';

/**
 * `ci.cron_runs.last_run_at` is stamped before the body, on purpose — a tick
 * that hangs or throws still fired. The cost was that the dashboard could not
 * tell that apart from a tick that worked: "last run two minutes ago" was true
 * of a schedule that had thrown on every tick for a fortnight. The second stamp
 * is what makes the outcome observable, so these assert on what the store reads
 * back rather than on the SQL that got there.
 */

interface CronRunRow {
  name: string;
  last_run_at: Date;
  last_success_at: Date | null;
}

/** An in-memory `ci.cron_runs` honouring the two upserts the store issues. */
function fakeCronRuns() {
  const rows = new Map<string, CronRunRow>();

  const dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('INSERT INTO ci.cron_runs')) {
        const [name, at] = params as [string, Date];
        const row = rows.get(name) ?? { name, last_run_at: at, last_success_at: null };

        if (sql.includes('last_success_at')) {
          row.last_success_at = at;
        } else {
          row.last_run_at = at;
        }

        rows.set(name, row);

        return Promise.resolve([]);
      }

      if (sql.includes('SELECT name, last_run_at')) {
        return Promise.resolve([...rows.values()]);
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  return dataSource as unknown as DataSource;
}

describe('Cron run outcome', () => {
  beforeEach(() => {
    CronRunStore.configure(fakeCronRuns());
  });

  it('records an attempt but no success when the body throws', async () => {
    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.failing' })
      async tick(): Promise<void> {
        throw new Error('transient database failure');
      }
    }

    await new Probe().tick();

    expect((await CronRunStore.runsByName()).get('Probe.failing')).toEqual({
      lastRunAt: expect.any(Date),
      lastSuccessAt: null,
    });
  });

  it('records both once the body returns', async () => {
    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.healthy' })
      async tick(): Promise<void> {
        /* a tick that does its work and returns */
      }
    }

    await new Probe().tick();

    const run = (await CronRunStore.runsByName()).get('Probe.healthy');

    expect(run?.lastSuccessAt).toBeInstanceOf(Date);
    expect(run?.lastSuccessAt?.getTime()).toBeGreaterThanOrEqual(run?.lastRunAt.getTime() ?? 0);
  });

  it('leaves the last success behind when a healthy schedule starts failing', async () => {
    let healthy = true;

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.degrading' })
      async tick(): Promise<void> {
        if (!healthy) {
          throw new Error('the sidecar went away');
        }
      }
    }

    const probe = new Probe();

    await probe.tick();
    const succeededAt = (await CronRunStore.runsByName()).get('Probe.degrading')?.lastSuccessAt;
    expect(succeededAt).toBeInstanceOf(Date);

    healthy = false;
    await probe.tick();
    await probe.tick();

    const run = (await CronRunStore.runsByName()).get('Probe.degrading');

    expect(run?.lastSuccessAt).toEqual(succeededAt);
    expect(run?.lastSuccessAt).toBeInstanceOf(Date);
    expect(run?.lastRunAt.getTime()).toBeGreaterThanOrEqual(succeededAt?.getTime() ?? 0);
  });

  it('serves last_run_at when last_success_at is not on the table', async () => {
    const at = new Date('2026-08-22T00:00:00.000Z');
    let fullSelects = 0;
    const dataSource = {
      query: (sql: string) => {
        if (sql.includes('SELECT') && sql.includes('last_success_at')) {
          fullSelects += 1;
          const err = Object.assign(new Error('column "last_success_at" does not exist'), {
            code: '42703',
          });

          return Promise.reject(err);
        }

        if (sql.includes('SELECT name, last_run_at FROM ci.cron_runs')) {
          return Promise.resolve([{ name: 'Probe.old', last_run_at: at }]);
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    CronRunStore.configure(dataSource as never);

    await expect(CronRunStore.runsByName()).resolves.toEqual(
      new Map([['Probe.old', { lastRunAt: at, lastSuccessAt: null }]]),
    );
    expect(fullSelects).toBe(1);
  });
});
