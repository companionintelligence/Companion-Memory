import type { DataSource } from 'typeorm';

import { JobControlStore } from '../JobControlStore';

/**
 * The store is the only thing standing between a settings table and the two
 * hottest paths in the appliance, and it answers every question synchronously
 * off a cached snapshot. Everything that can go wrong with that shape is a
 * correctness bug that nothing else would catch:
 *
 *  - a snapshot that fails OPEN would let a database blip un-pause every queue
 *    an operator paused, on a box they paused because it was overheating;
 *  - a snapshot that fails CLOSED would let a missing migration disable the
 *    memory system on every appliance that has not been upgraded;
 *  - a revision that ticks on every poll would re-assign `p-limit.concurrency`
 *    forever, scheduling a microtask per queue per five seconds;
 *  - a skip counter that upserted per drop would make a settings table the
 *    most-written table on the appliance during an import.
 *
 * So these assert on the store's observable behaviour under each of those,
 * driving the real SQL through a fake DataSource rather than stubbing the
 * getters.
 */

interface SettingsRow {
  kind: string;
  key: string;
  mode: string | null;
  concurrency: number | null;
  skipped_count: string;
  last_skipped_at: Date | null;
  updated_at: Date;
}

function row(partial: Partial<SettingsRow> & Pick<SettingsRow, 'kind' | 'key'>): SettingsRow {
  return {
    mode: null,
    concurrency: null,
    skipped_count: '0',
    last_skipped_at: null,
    updated_at: new Date('2026-09-01T00:00:00Z'),
    ...partial,
  };
}

interface FakeDb {
  dataSource: DataSource;
  rows: SettingsRow[];
  selects: number;
  updates: Array<{ kind: string; key: string; count: number }>;
  failNextSelect: (message: string) => void;
}

function fakeDb(initial: SettingsRow[] = []): FakeDb {
  const state: FakeDb = {
    rows: [...initial],
    selects: 0,
    updates: [],
    failNextSelect: (message: string) => {
      pendingFailure = message;
    },
    dataSource: null as unknown as DataSource,
  };

  let pendingFailure: string | null = null;

  state.dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('SELECT kind, key')) {
        state.selects += 1;

        if (pendingFailure) {
          const message = pendingFailure;

          pendingFailure = null;

          return Promise.reject(new Error(message));
        }

        return Promise.resolve(state.rows.map((entry) => ({ ...entry })));
      }

      if (sql.includes('UPDATE ci.job_settings')) {
        const [kind, key, count] = params as [string, string, number, Date];

        state.updates.push({ kind, key, count });

        return Promise.resolve([]);
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as DataSource;

  return state;
}

afterEach(async () => {
  await JobControlStore.configure(null);
});

describe('JobControlStore snapshot', () => {
  it('reports no opinion for every control when the table is empty', async () => {
    await JobControlStore.configure(fakeDb().dataSource);

    expect(JobControlStore.globalConcurrency()).toBeNull();
    expect(JobControlStore.perQueueConcurrency()).toBeNull();
    expect(JobControlStore.nonInteractivePaused()).toBe(false);
    expect(JobControlStore.queueMode('search-index', { interactive: false })).toBe('enabled');
    expect(JobControlStore.cronMode('PlanningJobsCron.todoScan')).toBe('enabled');
  });

  it('reads a queue mode and a concurrency ceiling back out', async () => {
    await JobControlStore.configure(
      fakeDb([
        row({ kind: 'queue', key: 'image-description', mode: 'disabled' }),
        row({ kind: 'queue', key: 'search-index', concurrency: 2 }),
        row({ kind: 'global', key: 'concurrency', concurrency: 12 }),
        row({ kind: 'global', key: 'per_queue_concurrency', concurrency: 3 }),
      ]).dataSource,
    );

    expect(JobControlStore.queueMode('image-description', { interactive: false })).toBe('disabled');
    expect(JobControlStore.row('queue', 'search-index')?.concurrency).toBe(2);
    expect(JobControlStore.globalConcurrency()).toBe(12);
    expect(JobControlStore.perQueueConcurrency()).toBe(3);
  });

  it('discards rows whose kind or mode this build does not understand', async () => {
    await JobControlStore.configure(
      fakeDb([
        row({ kind: 'tenant', key: 'whatever', mode: 'disabled' }),
        row({ kind: 'queue', key: 'etl', mode: 'quarantined' }),
      ]).dataSource,
    );

    // A row from a newer schema must not be given a meaning here. Guessing is
    // how a setting comes to do the opposite of what the operator chose.
    expect(JobControlStore.row('tenant' as never, 'whatever')).toBeUndefined();
    expect(JobControlStore.queueMode('etl', { interactive: false })).toBe('enabled');
  });

  it('reads bigint skip counts back as numbers', async () => {
    await JobControlStore.configure(
      fakeDb([row({ kind: 'queue', key: 'geocode', mode: 'disabled', skipped_count: '4200' })]).dataSource,
    );

    expect(JobControlStore.row('queue', 'geocode')?.skippedCount).toBe(4200);
  });
});

describe('JobControlStore global pause', () => {
  it('pauses a non-interactive queue and spares an interactive one', async () => {
    await JobControlStore.configure(
      fakeDb([row({ kind: 'global', key: 'non_interactive', mode: 'paused' })]).dataSource,
    );

    expect(JobControlStore.queueMode('search-index', { interactive: false })).toBe('paused');
    expect(JobControlStore.queueMode('llm', { interactive: true })).toBe('enabled');
  });

  it('leaves a queue the operator disabled by name disabled, not merely paused', async () => {
    await JobControlStore.configure(
      fakeDb([
        row({ kind: 'global', key: 'non_interactive', mode: 'paused' }),
        row({ kind: 'queue', key: 'geocode', mode: 'disabled' }),
      ]).dataSource,
    );

    // The global switch can only ever make a queue MORE restricted. If it could
    // relax one, un-pausing the appliance would silently switch a disabled queue
    // back on.
    expect(JobControlStore.queueMode('geocode', { interactive: false })).toBe('disabled');
  });
});

describe('JobControlStore degradation', () => {
  it('behaves exactly as if the table did not exist when it does not', async () => {
    const db = fakeDb();

    db.failNextSelect('relation "ci.job_settings" does not exist');

    await JobControlStore.configure(db.dataSource);

    expect(JobControlStore.queueMode('search-index', { interactive: false })).toBe('enabled');
    expect(JobControlStore.cronMode('AccountPurgeCron.purgeDueAccounts')).toBe('enabled');
    expect(JobControlStore.globalConcurrency()).toBeNull();
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    const db = fakeDb([row({ kind: 'queue', key: 'etl', mode: 'paused' })]);

    await JobControlStore.configure(db.dataSource);
    expect(JobControlStore.queueMode('etl', { interactive: false })).toBe('paused');

    db.failNextSelect('connection terminated unexpectedly');
    await JobControlStore.refresh();

    // A dropped connection must not un-pause a queue. The operator paused this
    // because the box was too hot; the box is still too hot.
    expect(JobControlStore.queueMode('etl', { interactive: false })).toBe('paused');
  });

  it('answers with shipped defaults before it has ever been configured', async () => {
    await JobControlStore.configure(null);

    expect(JobControlStore.queueMode('anything', { interactive: false })).toBe('enabled');
    expect(JobControlStore.cronMode('anything')).toBe('enabled');
    expect(JobControlStore.rows()).toEqual([]);
  });
});

describe('JobControlStore revision', () => {
  it('bumps when a mode changes', async () => {
    const db = fakeDb([row({ kind: 'queue', key: 'etl', mode: 'enabled' })]);

    await JobControlStore.configure(db.dataSource);
    const before = JobControlStore.revision();

    db.rows = [row({ kind: 'queue', key: 'etl', mode: 'paused' })];
    await JobControlStore.refresh();

    expect(JobControlStore.revision()).not.toBe(before);
  });

  it('does not bump when only the skip tally moved', async () => {
    const db = fakeDb([row({ kind: 'queue', key: 'etl', mode: 'disabled', skipped_count: '10' })]);

    await JobControlStore.configure(db.dataSource);
    const before = JobControlStore.revision();

    // A disabled queue refuses work continuously, so this column moves on every
    // poll. Treating it as a change would re-size every semaphore every five
    // seconds for as long as the queue stays off.
    db.rows = [row({ kind: 'queue', key: 'etl', mode: 'disabled', skipped_count: '99999' })];
    await JobControlStore.refresh();

    expect(JobControlStore.revision()).toBe(before);
  });
});

describe('JobControlStore skip counters', () => {
  it('batches many drops into one update per key', async () => {
    const db = fakeDb([row({ kind: 'queue', key: 'search-index', mode: 'disabled' })]);

    await JobControlStore.configure(db.dataSource);

    for (let i = 0; i < 5000; i += 1) {
      JobControlStore.recordSkip('queue', 'search-index');
    }

    JobControlStore.recordSkip('queue', 'geocode', 3);

    await JobControlStore.flushSkips();

    // One write per key, not one per dropped job — the whole reason the counter
    // is in memory at all.
    expect(db.updates).toEqual([
      { kind: 'queue', key: 'search-index', count: 5000 },
      { kind: 'queue', key: 'geocode', count: 3 },
    ]);
  });

  it('drains the pending counts so a second flush cannot double-count them', async () => {
    const db = fakeDb();

    await JobControlStore.configure(db.dataSource);

    JobControlStore.recordSkip('cron', 'PlanningJobsCron.todoScan', 2);
    await JobControlStore.flushSkips();
    await JobControlStore.flushSkips();

    expect(db.updates).toEqual([{ kind: 'cron', key: 'PlanningJobsCron.todoScan', count: 2 }]);
  });

  it('ignores a non-positive count rather than writing a no-op update', async () => {
    const db = fakeDb();

    await JobControlStore.configure(db.dataSource);

    JobControlStore.recordSkip('queue', 'etl', 0);
    await JobControlStore.flushSkips();

    expect(db.updates).toEqual([]);
  });
});
