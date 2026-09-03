import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit, { type LimitFunction } from 'p-limit';
import type { DataSource } from 'typeorm';

import { JobControlStore } from '@ci/common/job-controls';
import type { LoggerService } from '@ci/common/logging';

import { EventListenerRegistry } from '../../event-registration';
import { PGBossEventService } from '../PGBossEventService';

/**
 * The two ends of an operator's switch, where they are actually enforced.
 *
 * The controls only mean anything if both hold, and they hold for different
 * reasons:
 *
 *  - **Enqueue.** A disabled queue must not accept new work, and must not take
 *    the rest of the fan-out down with it — switching off image descriptions
 *    cannot also stop the same upload being indexed for search.
 *  - **Execute.** A queue that is off must not work what is ALREADY queued.
 *    Without this, "disabled" still burns a box down through a backlog of
 *    12,000 jobs it accepted before the switch was flipped.
 *
 * And the distinction between the two off-states has to be real: `paused` keeps
 * enqueuing (so nothing is lost) and stops working (so the box cools), while
 * `disabled` stops both. A pause that quietly dropped work would be the most
 * dangerous control on the page, because it is the one that reads as safe.
 *
 * pg-boss is a stub; the settings table is a fake DataSource driving the real
 * store, so the parse and resolution paths are the ones that ship.
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

function setting(partial: Partial<SettingsRow> & Pick<SettingsRow, 'kind' | 'key'>): SettingsRow {
  return {
    mode: null,
    concurrency: null,
    skipped_count: '0',
    last_skipped_at: null,
    updated_at: new Date('2026-09-01T00:00:00Z'),
    ...partial,
  };
}

interface Settings {
  dataSource: DataSource;
  rows: SettingsRow[];
  skips: Array<{ kind: string; key: string; count: number }>;
}

function fakeSettings(rows: SettingsRow[] = []): Settings {
  const state: Settings = { rows, skips: [], dataSource: null as unknown as DataSource };

  state.dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('UPDATE ci.job_settings')) {
        const [kind, key, count] = params as [string, string, number, Date];

        state.skips.push({ kind, key, count });

        return Promise.resolve([]);
      }

      return Promise.resolve(state.rows.map((row) => ({ ...row })));
    },
  } as unknown as DataSource;

  return state;
}

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

interface Internals {
  boss: { send: jest.Mock; insert: jest.Mock; fetch: jest.Mock; complete: jest.Mock; fail: jest.Mock };
  globalSemaphore: LimitFunction;
  shippedConcurrency: number;
  shippedPerQueueConcurrency: number;
  perQueueSemaphores: Map<string, LimitFunction>;
  declaredQueueCeilings: Map<string, number>;
  interactiveQueues: Set<string>;
  controlsRevision: number;
  running: boolean;
  work(queue: string): Promise<void>;
  syncConcurrencyLimits(): void;
}

function internals(service: PGBossEventService): Internals {
  return service as unknown as Internals;
}

function makeService(): { service: PGBossEventService; logger: StubLogger; boss: Internals['boss'] } {
  const logger: StubLogger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  const service = new PGBossEventService(
    new EventEmitter2(),
    logger as unknown as LoggerService,
    {} as never,
  );

  const boss = {
    send: jest.fn(async () => 'job-1'),
    insert: jest.fn(async (jobs: unknown[]) => jobs.map((_, index) => `bulk-${index}`)),
    fetch: jest.fn(async () => []),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
  };

  internals(service).boss = boss;

  return { service, logger, boss };
}

const priorSuppress = process.env.CI_QUEUE_SUPPRESS;

beforeEach(() => {
  delete process.env.CI_QUEUE_SUPPRESS;
  EventListenerRegistry.clear();
});

afterEach(async () => {
  await JobControlStore.configure(null);
  EventListenerRegistry.clear();

  if (priorSuppress == null) {
    delete process.env.CI_QUEUE_SUPPRESS;
  } else {
    process.env.CI_QUEUE_SUPPRESS = priorSuppress;
  }
});

describe('enqueue side', () => {
  /** Two queues listening for the same event, so a drop on one is observable against the other. */
  function registerFanOut(): void {
    EventListenerRegistry.register(
      'file.uploaded',
      'ImageDescriptionListener',
      'describe',
      'image-description',
    );
    EventListenerRegistry.register('file.uploaded', 'FileSearchIndexListener', 'index', 'search-index');
  }

  it('drops a send to a disabled queue and still delivers to the others', async () => {
    registerFanOut();
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'queue', key: 'image-description', mode: 'disabled' })]).dataSource,
    );

    const { service, boss } = makeService();

    const jobIds = await service.send('file.uploaded' as never, { fileId: 'f1' } as never);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send.mock.calls[0][0]).toBe('search-index');
    expect(jobIds).toHaveLength(1);
  });

  it('counts what a disabled queue threw away', async () => {
    registerFanOut();
    const settings = fakeSettings([setting({ kind: 'queue', key: 'image-description', mode: 'disabled' })]);

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();

    await service.send('file.uploaded' as never, { fileId: 'f1' } as never);
    await service.send('file.uploaded' as never, { fileId: 'f2' } as never);
    await JobControlStore.flushSkips();

    // Without a tally, a queue silently evaporating thousands of jobs a minute
    // looks exactly like a quiet queue on the dashboard.
    expect(settings.skips).toEqual([{ kind: 'queue', key: 'image-description', count: 2 }]);
  });

  it('keeps enqueuing to a PAUSED queue, because pausing must not lose work', async () => {
    registerFanOut();
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'queue', key: 'image-description', mode: 'paused' })]).dataSource,
    );

    const { service, boss } = makeService();

    await service.send('file.uploaded' as never, { fileId: 'f1' } as never);

    expect(boss.send.mock.calls.map((call) => call[0]).sort()).toEqual(['image-description', 'search-index']);
  });

  it('drops an explicitly-addressed send to a disabled queue', async () => {
    registerFanOut();
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'queue', key: 'search-index', mode: 'disabled' })]).dataSource,
    );

    const { service, boss } = makeService();

    // Naming a queue explicitly is what a backfill does, and a backfill is
    // exactly the traffic someone switches a queue off to stop.
    const jobIds = await service.send('file.uploaded' as never, { fileId: 'f1' } as never, {
      queue: 'search-index',
    });

    expect(boss.send).not.toHaveBeenCalled();
    expect(jobIds).toEqual([]);
  });

  it('drops a bulk enqueue onto a disabled queue and counts every row', async () => {
    EventListenerRegistry.register('content.created', 'SearchIndexListener', 'index', 'search-index');

    const settings = fakeSettings([setting({ kind: 'queue', key: 'search-index', mode: 'disabled' })]);

    await JobControlStore.configure(settings.dataSource);

    const { service, boss } = makeService();

    await service.sendMany(
      'search-index',
      Array.from({ length: 500 }, (_, index) => ({ name: 'content.created', data: { id: `c${index}` } })),
    );
    await JobControlStore.flushSkips();

    expect(boss.insert).not.toHaveBeenCalled();
    // Jobs lost, not calls that lost them — the number an operator needs is how
    // much work is missing.
    expect(settings.skips).toEqual([{ kind: 'queue', key: 'search-index', count: 500 }]);
  });

  it('enqueues normally once the setting is cleared', async () => {
    registerFanOut();

    const settings = fakeSettings([setting({ kind: 'queue', key: 'image-description', mode: 'disabled' })]);

    await JobControlStore.configure(settings.dataSource);

    const { service, boss } = makeService();

    await service.send('file.uploaded' as never, { fileId: 'f1' } as never);
    expect(boss.send).toHaveBeenCalledTimes(1);

    settings.rows.length = 0;
    await JobControlStore.refresh();

    await service.send('file.uploaded' as never, { fileId: 'f2' } as never);
    expect(boss.send).toHaveBeenCalledTimes(3);
  });
});

describe('execute side', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Run the loop for a few wake-ups, then stop it, and report what it fetched. */
  async function pump(service: PGBossEventService, queue: string): Promise<void> {
    const worker = internals(service);

    worker.perQueueSemaphores.set(queue, plimit(6));

    const loop = worker.work(queue);

    // Several idle backoffs' worth, so a loop that WOULD fetch has had many
    // chances to.
    await jest.advanceTimersByTimeAsync(30_000);

    worker.running = false;
    await jest.advanceTimersByTimeAsync(30_000);
    await loop;
  }

  it('does not fetch from a paused queue', async () => {
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'queue', key: 'geocode', mode: 'paused' })]).dataSource,
    );

    const { service, boss } = makeService();

    await pump(service, 'geocode');

    // The jobs stay `created` with no lease held, so they run in order the
    // moment the queue comes back. That is what makes pausing safe to reach for.
    expect(boss.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch from a disabled queue, so an existing backlog stops too', async () => {
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'queue', key: 'geocode', mode: 'disabled' })]).dataSource,
    );

    const { service, boss } = makeService();

    await pump(service, 'geocode');

    expect(boss.fetch).not.toHaveBeenCalled();
  });

  it('fetches normally when nothing is set', async () => {
    await JobControlStore.configure(fakeSettings().dataSource);

    const { service, boss } = makeService();

    await pump(service, 'geocode');

    expect(boss.fetch).toHaveBeenCalled();
  });

  it('picks up a concurrency change without a restart', async () => {
    const settings = fakeSettings();

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();
    const worker = internals(service);

    worker.perQueueSemaphores.set('geocode', plimit(6));

    const loop = worker.work('geocode');

    await jest.advanceTimersByTimeAsync(10_000);
    expect(worker.perQueueSemaphores.get('geocode')?.concurrency).toBe(6);

    // The whole point of the control: an operator lowers the cap on a hot box
    // and the running worker honours it, rather than the number taking effect at
    // the next restart — which is exactly the env-var behaviour this replaces.
    settings.rows.push(setting({ kind: 'queue', key: 'geocode', concurrency: 2 }));
    await JobControlStore.refresh();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(worker.perQueueSemaphores.get('geocode')?.concurrency).toBe(2);

    worker.running = false;
    await jest.advanceTimersByTimeAsync(30_000);
    await loop;
  });

  it('spares an interactive queue from the global non-interactive pause', async () => {
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'global', key: 'non_interactive', mode: 'paused' })]).dataSource,
    );

    const { service, boss } = makeService();

    internals(service).interactiveQueues.add('llm');

    await pump(service, 'llm');

    // Pausing background work must leave chat answering, or it is
    // indistinguishable from the appliance being down.
    expect(boss.fetch).toHaveBeenCalled();
  });

  it('pauses a non-interactive queue under the global switch', async () => {
    await JobControlStore.configure(
      fakeSettings([setting({ kind: 'global', key: 'non_interactive', mode: 'paused' })]).dataSource,
    );

    const { service, boss } = makeService();

    await pump(service, 'search-index');

    expect(boss.fetch).not.toHaveBeenCalled();
  });
});

describe('live concurrency', () => {
  it('re-sizes a queue semaphore when the setting changes', async () => {
    const settings = fakeSettings();

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();
    const worker = internals(service);

    worker.perQueueSemaphores.set('search-index', plimit(6));
    worker.controlsRevision = -1;
    worker.syncConcurrencyLimits();

    expect(worker.perQueueSemaphores.get('search-index')?.concurrency).toBe(6);

    settings.rows.push(setting({ kind: 'queue', key: 'search-index', concurrency: 2 }));
    await JobControlStore.refresh();
    worker.syncConcurrencyLimits();

    expect(worker.perQueueSemaphores.get('search-index')?.concurrency).toBe(2);
  });

  it('refuses to raise a queue above the ceiling its code declared', async () => {
    const settings = fakeSettings([setting({ kind: 'queue', key: 'llm', concurrency: 8 })]);

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();
    const worker = internals(service);

    // `llm` declares localConcurrency: 1 — two chat generations at once thrash
    // the model. A settings page must not be able to overrule that.
    worker.declaredQueueCeilings.set('llm', 1);
    worker.perQueueSemaphores.set('llm', plimit(1));
    worker.controlsRevision = -1;
    worker.syncConcurrencyLimits();

    expect(worker.perQueueSemaphores.get('llm')?.concurrency).toBe(1);
  });

  it('will not size the global semaphore above what the build ships with', async () => {
    // `MAX_CONCURRENCY` is 64 and the API accepts it, so this is a value an
    // operator could really have stored. The control exists because an
    // unattended appliance already pegs the machine; a text box on that page
    // that multiplies the load by six inverts the whole feature.
    const settings = fakeSettings([setting({ kind: 'global', key: 'concurrency', concurrency: 64 })]);

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();
    const worker = internals(service);
    const shipped = worker.shippedConcurrency;

    worker.controlsRevision = -1;
    worker.syncConcurrencyLimits();

    expect(worker.globalSemaphore.concurrency).toBe(shipped);

    // …and a genuine reduction still lands, so the clamp is a ceiling rather
    // than the control being ignored.
    settings.rows.length = 0;
    settings.rows.push(setting({ kind: 'global', key: 'concurrency', concurrency: 2 }));
    await JobControlStore.refresh();
    worker.syncConcurrencyLimits();

    expect(worker.globalSemaphore.concurrency).toBe(2);
  });

  it('will not lift every queue at once through the global per-queue default', async () => {
    const settings = fakeSettings([
      setting({ kind: 'global', key: 'per_queue_concurrency', concurrency: 64 }),
    ]);

    await JobControlStore.configure(settings.dataSource);

    const { service } = makeService();
    const worker = internals(service);
    const shipped = worker.shippedPerQueueConcurrency;

    worker.perQueueSemaphores.set('search-index', plimit(shipped));
    worker.controlsRevision = -1;
    worker.syncConcurrencyLimits();

    // No queue names this number and each clamps to it faithfully, which is
    // exactly why raising it went unnoticed — every row stayed self-consistent.
    expect(worker.perQueueSemaphores.get('search-index')?.concurrency).toBe(shipped);
  });

  it('does no work when nothing has changed', async () => {
    await JobControlStore.configure(fakeSettings().dataSource);

    const { service } = makeService();
    const worker = internals(service);

    worker.perQueueSemaphores.set('etl', plimit(6));
    worker.controlsRevision = -1;
    worker.syncConcurrencyLimits();

    // Assigning `p-limit.concurrency` schedules a microtask, and this runs from
    // every queue's loop on every wake-up. Hand-poke a value the sync would
    // overwrite and assert that an unchanged revision leaves it alone.
    const semaphore = worker.perQueueSemaphores.get('etl');

    if (semaphore) {
      semaphore.concurrency = 3;
    }

    worker.syncConcurrencyLimits();

    expect(worker.perQueueSemaphores.get('etl')?.concurrency).toBe(3);
  });
});
