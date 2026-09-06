import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { SYNC_WINDOW_DAYS, SyncWindowSweepCron } from '../cron/SyncWindowSweepCron';

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as LoggerService;

/** Both statements return `[{ count }]`; hand back the two counts in order. */
const dataSource = (events: string, entities: string) => {
  const query = jest.fn().mockResolvedValueOnce([{ count: events }]).mockResolvedValueOnce([{ count: entities }]);

  return { query } as unknown as DataSource & { query: jest.Mock };
};

describe('SyncWindowSweepCron', () => {
  it('clears the marker on both tables and reports what it evicted', async () => {
    const source = dataSource('7', '3');
    const cron = new SyncWindowSweepCron(source, logger());

    await expect(cron.sweepOnce()).resolves.toEqual({ events: 7, entities: 3 });

    expect(source.query).toHaveBeenCalledTimes(2);
    const [eventsSql, eventsParams] = source.query.mock.calls[0];
    const [entitiesSql] = source.query.mock.calls[1];

    expect(eventsSql).toContain('ci.events');
    expect(eventsSql).toContain('SET sync_period = NULL');
    expect(entitiesSql).toContain('ci.entities');
    expect(eventsParams).toEqual([SYNC_WINDOW_DAYS]);
  });

  // The sweep must only ever widen the NULL set. An UPDATE that dropped this
  // predicate would rewrite every row in the table on each tick, and every one
  // of those writes is a replication event PowerSync would push to every device.
  it('only touches rows still inside the window', async () => {
    const source = dataSource('0', '0');

    await new SyncWindowSweepCron(source, logger()).sweepOnce();

    for (const [sql] of source.query.mock.calls) {
      expect(sql).toContain('sync_period IS NOT NULL');
    }
  });

  // The insert trigger admits a row on COALESCE(observed_at, start_time,
  // created_at). Ageing it out on a different clock would evict rows that were
  // never admitted, or strand ones that were.
  it('ages events out on the same clock the insert trigger admits them on', async () => {
    const source = dataSource('0', '0');

    await new SyncWindowSweepCron(source, logger()).sweepOnce();

    expect(source.query.mock.calls[0][0]).toContain('COALESCE(observed_at, start_time, created_at)');
  });

  it('honours an explicit window instead of the default', async () => {
    const source = dataSource('1', '1');

    await new SyncWindowSweepCron(source, logger()).sweepOnce(7);

    expect(source.query.mock.calls[0][1]).toEqual([7]);
  });

  it('does not let a slow sweep stack on itself', async () => {
    // Every call parks until released — the sweep issues two statements, so
    // releasing only the first would leave the run hanging on the second.
    const pending: (() => void)[] = [];
    const query = jest.fn().mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve([{ count: '0' }]))),
    );
    const cron = new SyncWindowSweepCron({ query } as unknown as DataSource, logger());

    const first = cron.sweepOnSchedule();
    await cron.sweepOnSchedule();

    // The second call saw `running` and returned without issuing anything, so
    // only the first statement of the first run is outstanding.
    expect(query).toHaveBeenCalledTimes(1);

    while (pending.length > 0) {
      pending.shift()?.();
      await Promise.resolve();
    }
    await first;
  });

  it('swallows a failing sweep so the schedule survives it', async () => {
    const query = jest.fn().mockRejectedValue(new Error('deadlock detected'));
    const log = logger();

    await expect(
      new SyncWindowSweepCron({ query } as unknown as DataSource, log).sweepOnSchedule(),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalled();
  });
});
