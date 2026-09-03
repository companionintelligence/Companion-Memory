import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

// Sibling imports, not the `@ci/domains/events` barrel: a file inside a domain
// reaching back through its own index is `no-intra-domain-via-barrel`.
import { DEAD_LETTER_QUEUE } from '../../constants';
import { EventListenerRegistry } from '../../event-registration';
import { PGBossEventService } from '../PGBossEventService';

/**
 * What `onModuleInit` writes onto a pg-boss queue ROW.
 *
 * The queue row is not decoration: pg-boss resolves nearly every per-job
 * property as `COALESCE(job, queue, constructor)`, so a setting that lives only
 * in the constructor is invisible to the database and to anything reading it.
 * Retention is the case where that gap costs work rather than tidiness.
 *
 * `archive()` deletes from `pgboss.job` on three predicates, and the third is
 * `state < 'active' AND keep_until < now()` — `state < 'active'` covers
 * `created` and `retry`, i.e. jobs that have NEVER RUN. `keep_until` resolves as
 * `start_after + COALESCE(job.keep_until, queue.retention_minutes * 60,
 * constructor default, '14 days')`, and this codebase set none of the first
 * three, so every work queue inherited a silent 14-day fallback. A queue an
 * operator paused for a fortnight, or a bulk-import fan-out that outlived one,
 * had its oldest jobs archived and then deleted `deleteAfterHours` later —
 * with no log, no exception, and no dead letter.
 *
 * Two things make the assertions here the shape they are:
 *
 *  - **Both calls.** `createQueue` is a NO-OP on a queue that already exists, so
 *    it fixes nothing on an appliance that has been running. The adjacent
 *    `updateQueue` is the entire back-fill, and asserting only on `createQueue`
 *    would pass while every live appliance kept its NULL retention forever.
 *  - **Minutes.** pg-boss v10 destructures `retentionMinutes` alone and its
 *    `create_queue` reads `options->>'retentionMinutes'`, so a `retentionDays`
 *    is dropped on the floor. That failure mode is invisible from the code —
 *    it reads as a fix and does nothing — which is why the unit is asserted
 *    rather than the intent.
 *
 * pg-boss and the DataSource are stubs; no Postgres.
 */

/** 90 days, in minutes. Spelled out rather than imported: importing the constant
 *  from the file under test would make the assertion pass for any value. */
const EXPECTED_WORK_QUEUE_RETENTION_MINUTES = 129_600;

/** 30 days, in minutes — the dead-letter queue's own, longstanding window. */
const EXPECTED_DEAD_LETTER_RETENTION_MINUTES = 43_200;

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

interface QueueCall {
  queue: string;
  options: Record<string, unknown>;
}

interface Booted {
  service: PGBossEventService;
  createQueueCalls: QueueCall[];
  updateQueueCalls: QueueCall[];
  stop(): Promise<void>;
}

/** Push fake time forward in steps until `promise` settles. */
async function runUntilSettled(promise: Promise<unknown>, stepMs = 100, maxSteps = 500): Promise<void> {
  let settled = false;

  const tracked = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }

  await tracked;
}

const booted: Booted[] = [];

async function boot(): Promise<Booted> {
  const logger: StubLogger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  const createQueueCalls: QueueCall[] = [];
  const updateQueueCalls: QueueCall[] = [];

  const boss = {
    on: jest.fn(),
    start: jest.fn(async () => undefined),
    createQueue: jest.fn(async (queue: string, options: Record<string, unknown>) => {
      createQueueCalls.push({ queue, options });
    }),
    updateQueue: jest.fn(async (queue: string, options: Record<string, unknown>) => {
      updateQueueCalls.push({ queue, options });
    }),
    fetch: jest.fn(async () => []),
    stop: jest.fn(async () => undefined),
  };

  // The advisory lock the provisioning block takes runs on an app-pool query
  // runner, not through pg-boss.
  const queryRunner = {
    connect: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
    release: jest.fn(async () => undefined),
  };

  const dataSource = {
    createQueryRunner: () => queryRunner,
  } as unknown as DataSource;

  const service = new PGBossEventService(new EventEmitter2(), logger as unknown as LoggerService, dataSource);

  (service as unknown as { boss: unknown }).boss = boss;

  await service.onModuleInit();

  const entry: Booted = {
    service,
    createQueueCalls,
    updateQueueCalls,
    async stop() {
      await runUntilSettled(service.onModuleDestroy());
    },
  };

  booted.push(entry);

  return entry;
}

function optionsFor(calls: QueueCall[], queue: string): Record<string, unknown> {
  const call = calls.find((candidate) => candidate.queue === queue);

  if (call == null) {
    throw new Error(`no call recorded for queue ${queue}; saw ${calls.map((c) => c.queue).join(', ')}`);
  }

  return call.options;
}

describe('PGBossEventService queue provisioning', () => {
  beforeEach(() => {
    jest.useFakeTimers();

    // The registry is process-global and populated by decorator side effects at
    // import time. This spec imports no listener modules, so it starts empty —
    // clearing makes that explicit rather than incidental.
    EventListenerRegistry.clear();

    // A queue that declares NOTHING (33 of the 39 real ones), and a queue that
    // declares its own options — the case where an appliance-wide default has
    // to survive a spread it is merged with.
    EventListenerRegistry.register('fixture.plain', 'PlainListener', 'handlePlain', 'fixture-plain');
    EventListenerRegistry.register('fixture.tuned', 'TunedListener', 'handleTuned', 'fixture-tuned', {
      policy: 'short',
      expireInSeconds: 600,
      localConcurrency: 1,
    });
  });

  afterEach(async () => {
    for (const entry of booted) {
      await entry.stop();
    }

    booted.length = 0;
    EventListenerRegistry.clear();
    jest.useRealTimers();
  });

  it('stamps a 90-day retention on every work queue it creates', async () => {
    const { createQueueCalls } = await boot();

    const workQueues = createQueueCalls.filter((call) => call.queue !== DEAD_LETTER_QUEUE);

    // `default` is created unconditionally alongside the two fixtures.
    expect(workQueues.map((call) => call.queue).sort()).toEqual([
      'default',
      'fixture-plain',
      'fixture-tuned',
    ]);

    for (const call of workQueues) {
      expect(call.options).toMatchObject({
        retentionMinutes: EXPECTED_WORK_QUEUE_RETENTION_MINUTES,
      });
    }
  });

  it('stamps the same retention through updateQueue, which is what back-fills a live appliance', async () => {
    const { createQueueCalls, updateQueueCalls } = await boot();

    // Every queue that was created is also updated. `createQueue` is a no-op on
    // an existing queue, so without this pairing an appliance provisioned
    // before this change keeps `retention_minutes = NULL` for ever.
    expect(updateQueueCalls.map((call) => call.queue).sort()).toEqual(
      createQueueCalls.map((call) => call.queue).sort(),
    );

    for (const call of updateQueueCalls.filter((c) => c.queue !== DEAD_LETTER_QUEUE)) {
      expect(call.options).toMatchObject({
        retentionMinutes: EXPECTED_WORK_QUEUE_RETENTION_MINUTES,
      });
    }
  });

  it('states the retention in MINUTES, the only unit pg-boss v10 persists', async () => {
    const { createQueueCalls, updateQueueCalls } = await boot();

    for (const call of [...createQueueCalls, ...updateQueueCalls]) {
      expect(call.options).toHaveProperty('retentionMinutes');
      expect(typeof call.options.retentionMinutes).toBe('number');
      // `retentionDays` and `retentionSeconds` are both accepted by the type
      // and both silently discarded by createQueue/updateQueue.
      expect(call.options).not.toHaveProperty('retentionDays');
      expect(call.options).not.toHaveProperty('retentionSeconds');
    }
  });

  it('leaves the dead-letter queue on its own 30-day window', async () => {
    const { createQueueCalls, updateQueueCalls } = await boot();

    expect(optionsFor(createQueueCalls, DEAD_LETTER_QUEUE)).toMatchObject({
      retentionMinutes: EXPECTED_DEAD_LETTER_RETENTION_MINUTES,
    });
    expect(optionsFor(updateQueueCalls, DEAD_LETTER_QUEUE)).toMatchObject({
      retentionMinutes: EXPECTED_DEAD_LETTER_RETENTION_MINUTES,
    });
  });

  it('does not clobber a queue that declares its own retention', async () => {
    EventListenerRegistry.register(
      'fixture.ephemeral',
      'EphemeralListener',
      'handleEphemeral',
      'fixture-ephemeral',
      { retentionMinutes: 60 },
    );

    const { createQueueCalls, updateQueueCalls } = await boot();

    // The default is placed BEFORE the `...queueOptions` spread precisely so a
    // listener can still override it. Placed after, this would be 129600 and a
    // queue asking for an hour would silently get a quarter.
    expect(optionsFor(createQueueCalls, 'fixture-ephemeral')).toMatchObject({ retentionMinutes: 60 });
    expect(optionsFor(updateQueueCalls, 'fixture-ephemeral')).toMatchObject({ retentionMinutes: 60 });

    // …and its neighbours are unaffected.
    expect(optionsFor(createQueueCalls, 'fixture-plain')).toMatchObject({
      retentionMinutes: EXPECTED_WORK_QUEUE_RETENTION_MINUTES,
    });
  });

  it('keeps the retry policy and dead-letter routing it already wrote', async () => {
    const { createQueueCalls } = await boot();

    // Guard against a merge that lands `retentionMinutes` on top of the retry
    // spread instead of before it.
    expect(optionsFor(createQueueCalls, 'fixture-plain')).toMatchObject({
      deadLetter: DEAD_LETTER_QUEUE,
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
    });

    // A listener's own options still win over the shared retry policy too.
    expect(optionsFor(createQueueCalls, 'fixture-tuned')).toMatchObject({
      policy: 'short',
      expireInSeconds: 600,
    });

    // `localConcurrency` is OURS, not pg-boss's, and must not reach the queue.
    expect(optionsFor(createQueueCalls, 'fixture-tuned')).not.toHaveProperty('localConcurrency');
  });
});
