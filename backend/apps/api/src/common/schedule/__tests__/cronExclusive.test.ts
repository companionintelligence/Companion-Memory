import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { JobControlStore } from '../../job-controls';
import { CronRunStore } from '../CronRunStore';
import { Cron, cronSkipReason } from '../decorators/Cron';

/**
 * A cron that overlaps itself was, until `exclusive`, completely invisible: the
 * wrapper swallows errors, `ci.cron_runs` only ever showed the newest stamp, and
 * two copies of the same sweep interleaving looks from the dashboard exactly
 * like one healthy schedule.
 *
 * The guard's own failure mode is the mirror image — a body that never finishes
 * silences the schedule for the life of the process — so these assert on both
 * halves: that a second tick really is refused while the first is in flight, and
 * that every way a tick can end (return, throw) hands the schedule back.
 *
 * Every probe below opts in explicitly. The option is opt-in precisely because
 * most schedules already guard themselves (see the note on `exclusive`), so a
 * test of the guard has to ask for it — which is also what the last case here
 * pins down.
 */

interface CronRunRow {
  name: string;
  last_run_at: Date;
  last_success_at: Date | null;
}

/**
 * An in-memory `ci.cron_runs` honouring the two upserts the store issues, and
 * counting the attempt stamps so a test can assert one tick fired, not two.
 */
function fakeCronRuns(rows: Map<string, CronRunRow>, attempts: string[] = []) {
  return {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('INSERT INTO ci.cron_runs')) {
        const [name, at] = params as [string, Date];
        const row = rows.get(name) ?? { name, last_run_at: at, last_success_at: null };

        if (sql.includes('last_success_at')) {
          row.last_success_at = at;
        } else {
          attempts.push(name);
          row.last_run_at = at;
        }

        rows.set(name, row);

        return Promise.resolve([]);
      }

      return Promise.resolve([...rows.values()]);
    },
  } as unknown as DataSource;
}

/** Settings table that records the folded skip counts and nothing else. */
function fakeSettings(updates: Array<[string, string, number]>) {
  return {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('UPDATE ci.job_settings')) {
        const [kind, key, count] = params as [string, string, number, Date];

        updates.push([kind, key, count]);

        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    },
  } as unknown as DataSource;
}

/** A promise a cron body can park on, so a tick stays in flight until released. */
function gate(): { readonly held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { held, release };
}

describe('an exclusive @Cron', () => {
  let cronRuns: Map<string, CronRunRow>;
  let attempts: string[];
  let warn: jest.SpyInstance;

  beforeEach(() => {
    cronRuns = new Map();
    attempts = [];
    CronRunStore.configure(fakeCronRuns(cronRuns, attempts));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await JobControlStore.configure(null);
    CronRunStore.configure(null as unknown as DataSource);
  });

  it('does not start a second tick while the first is still running', async () => {
    const first = gate();
    const started = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.exclusive', exclusive: true })
      async tick(): Promise<void> {
        started();

        await first.held;
      }
    }

    const probe = new Probe();
    const inFlight = probe.tick();

    await probe.tick();

    expect(started).toHaveBeenCalledTimes(1);

    first.release();
    await inFlight;
  });

  it('says which schedule it skipped rather than returning silently', async () => {
    const first = gate();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.noisy', exclusive: true })
      async tick(): Promise<void> {
        await first.held;
      }
    }

    const probe = new Probe();
    const inFlight = probe.tick();

    await probe.tick();

    // A schedule whose body hangs goes quiet forever; this line is the only
    // thing that tells an operator the difference between that and idleness.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Probe.noisy'));

    first.release();
    await inFlight;
  });

  it('counts the skipped tick and does not stamp it as a run', async () => {
    const skips: Array<[string, string, number]> = [];

    await JobControlStore.configure(fakeSettings(skips));

    const first = gate();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.counted', exclusive: true })
      async tick(): Promise<void> {
        await first.held;
      }
    }

    const probe = new Probe();
    const inFlight = probe.tick();

    await probe.tick();
    await JobControlStore.flushSkips();

    expect(skips).toEqual([['cron', 'Probe.counted', 1]]);
    // The overlapping tick did no work, so it must not stamp `ci.cron_runs` —
    // the gate sits ahead of the attempt stamp for exactly this reason.
    expect(attempts).toEqual(['Probe.counted']);
    expect(cronRuns.get('Probe.counted')?.last_success_at).toBeNull();

    first.release();
    await inFlight;
  });

  it('releases the schedule once a tick returns', async () => {
    const ran = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.released', exclusive: true })
      async tick(): Promise<void> {
        ran();
      }
    }

    const probe = new Probe();

    await probe.tick();
    await probe.tick();

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('releases the schedule when a tick throws', async () => {
    const ran = jest.fn();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.throwing', exclusive: true })
      async tick(): Promise<void> {
        ran();

        throw new Error('the sidecar went away');
      }
    }

    const probe = new Probe();

    // The wrapper swallows the error, so without the `finally` this schedule
    // would be off for the life of the process and nothing would say so.
    await probe.tick();
    await probe.tick();

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('lets ticks overlap by default, and when exclusive is off', async () => {
    const first = gate();
    const started = jest.fn();

    class Probe {
      // No option: the default. A schedule that guards itself — a `running`
      // flag, an advisory lock, a pg-boss singleton key — must reach its own
      // body, or its richer skip reporting never fires.
      @Cron('0 0 * * * *', { name: 'Probe.default' })
      async byDefault(): Promise<void> {
        started();

        await first.held;
      }

      @Cron('0 0 * * * *', { name: 'Probe.reentrant', exclusive: false })
      async explicitly(): Promise<void> {
        started();

        await first.held;
      }
    }

    const probe = new Probe();
    const inFlight = [probe.byDefault(), probe.byDefault(), probe.explicitly(), probe.explicitly()];

    expect(started).toHaveBeenCalledTimes(4);

    first.release();
    await Promise.all(inFlight);
  });

  it('tells "Run now" that a schedule is in flight before it fires the tick', async () => {
    const first = gate();

    class Probe {
      @Cron('0 0 * * * *', { name: 'Probe.queried', exclusive: true })
      async tick(): Promise<void> {
        await first.held;
      }

      @Cron('0 0 * * * *', { name: 'Probe.unqueried' })
      async reentrant(): Promise<void> {
        await first.held;
      }
    }

    const probe = new Probe();
    const inFlight = probe.tick();
    const reentrant = probe.reentrant();

    // `fireOnTick()` does not await the body, so JobMonitorService has to ask
    // before firing rather than read a result afterwards — otherwise a schedule
    // whose previous tick is still running is reported as `fired`.
    expect(cronSkipReason('Probe.queried')).toBe('in-flight');
    // A schedule left re-entrant never enters the set, so it is never skipped.
    expect(cronSkipReason('Probe.unqueried')).toBeNull();

    first.release();
    await Promise.all([inFlight, reentrant]);

    expect(cronSkipReason('Probe.queried')).toBeNull();
  });
});
