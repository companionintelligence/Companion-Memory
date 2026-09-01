import type { DataSource } from 'typeorm';

import { JobControlStore } from '../../job-controls';
import { CronRunStore } from '../CronRunStore';
import { Cron } from '../decorators/Cron';

/**
 * The `@Cron` wrapper is the ONE place a recurring job can be switched off — all
 * 53 scheduled methods on the appliance go through it, and importing Nest's raw
 * `Cron` anywhere else is an eslint error. So everything "the user disabled this
 * schedule" means has to be true here, and the two halves matter equally:
 *
 *  - the body must not run (obviously);
 *  - `ci.cron_runs` must NOT be stamped, because the Jobs page reads that column
 *    as "last run" and a disabled schedule showing a fresh timestamp is a job
 *    reporting that it did work it did not do.
 */

interface CronRunRow {
  name: string;
  last_run_at: Date;
  last_success_at: Date | null;
}

function fakeCronRuns(rows: Map<string, CronRunRow>) {
  return {
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

      return Promise.resolve([...rows.values()]);
    },
  } as unknown as DataSource;
}

interface SettingsRow {
  kind: string;
  key: string;
  mode: string | null;
  concurrency: number | null;
  skipped_count: string;
  last_skipped_at: Date | null;
  updated_at: Date;
}

function fakeSettings(rows: SettingsRow[], updates: Array<[string, string, number]>) {
  return {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('UPDATE ci.job_settings')) {
        const [kind, key, count] = params as [string, string, number, Date];

        updates.push([kind, key, count]);

        return Promise.resolve([]);
      }

      return Promise.resolve(rows.map((row) => ({ ...row })));
    },
  } as unknown as DataSource;
}

function disabledCron(name: string): SettingsRow {
  return {
    kind: 'cron',
    key: name,
    mode: 'disabled',
    concurrency: null,
    skipped_count: '0',
    last_skipped_at: null,
    updated_at: new Date('2026-09-01T00:00:00Z'),
  };
}

describe('a disabled @Cron', () => {
  let cronRuns: Map<string, CronRunRow>;
  let skips: Array<[string, string, number]>;

  beforeEach(() => {
    cronRuns = new Map();
    skips = [];
    CronRunStore.configure(fakeCronRuns(cronRuns));
  });

  afterEach(async () => {
    await JobControlStore.configure(null);
    CronRunStore.configure(null as unknown as DataSource);
  });

  it('does not run its body', async () => {
    await JobControlStore.configure(
      fakeSettings([disabledCron('Probe.disabled')], skips) as unknown as DataSource,
    );

    const ran = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.disabled' })
      async tick(): Promise<void> {
        ran();
      }
    }

    await new Probe().tick();

    expect(ran).not.toHaveBeenCalled();
  });

  it('records no run, so the dashboard cannot report it as healthy', async () => {
    await JobControlStore.configure(
      fakeSettings([disabledCron('Probe.disabled')], skips) as unknown as DataSource,
    );

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.disabled' })
      async tick(): Promise<void> {
        /* never reached */
      }
    }

    await new Probe().tick();

    // The stamp lands BEFORE the body for a normal tick, so a naive gate placed
    // after it would leave a switched-off schedule advertising a fresh "last
    // run" forever.
    expect(await CronRunStore.runsByName()).toEqual(new Map());
  });

  it('counts the skipped tick so being off is visible rather than silent', async () => {
    await JobControlStore.configure(
      fakeSettings([disabledCron('Probe.disabled')], skips) as unknown as DataSource,
    );

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.disabled' })
      async tick(): Promise<void> {
        /* never reached */
      }
    }

    await new Probe().tick();
    await new Probe().tick();
    await JobControlStore.flushSkips();

    expect(skips).toEqual([['cron', 'Probe.disabled', 2]]);
  });

  it('runs again as soon as the setting is removed', async () => {
    const rows: SettingsRow[] = [disabledCron('Probe.toggled')];

    await JobControlStore.configure(fakeSettings(rows, skips) as unknown as DataSource);

    const ran = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.toggled' })
      async tick(): Promise<void> {
        ran();
      }
    }

    const probe = new Probe();

    await probe.tick();
    expect(ran).not.toHaveBeenCalled();

    rows.length = 0;
    await JobControlStore.refresh();
    await probe.tick();

    expect(ran).toHaveBeenCalledTimes(1);
    expect((await CronRunStore.runsByName()).get('Probe.toggled')?.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('leaves every other schedule alone', async () => {
    await JobControlStore.configure(
      fakeSettings([disabledCron('Probe.disabled')], skips) as unknown as DataSource,
    );

    const ran = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.neighbour' })
      async tick(): Promise<void> {
        ran();
      }
    }

    await new Probe().tick();

    expect(ran).toHaveBeenCalledTimes(1);
  });
});
