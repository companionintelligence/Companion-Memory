import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit, { type LimitFunction } from 'p-limit';

import type { LoggerService } from '@ci/common/logging';

// Sibling import, not the `@ci/domains/events` barrel: a file inside a domain
// reaching back through its own index is `no-intra-domain-via-barrel`, and it
// would make this spec depend on the module's whole boot graph to read one type.
import type { Acknowledgement } from '../../types';
import { PGBossEventService } from '../PGBossEventService';

/**
 * The pg-boss worker loop: fetch -> execute -> complete/fail.
 *
 * Every background job in this system goes through `work()`, and until now
 * nothing covered it — PGBossEventService.spec.ts tests the bulk-enqueue path,
 * EventRouting.spec.ts tests WHICH queue a send reaches, and
 * PGBossEventService.deferred.test.ts drives `executeJob` in isolation. The loop
 * that joins them (capacity arithmetic, backoff, complete/fail, drain on
 * shutdown) is where the production incidents actually happened:
 *
 *  - a queue burst consuming every global slot and starving the other queues
 *    (the search-index backlog stall behind image-description/embedding);
 *  - a failed job whose error never reached pgboss.job.output, leaving it
 *    undiagnosable after the fact.
 *
 * Both are invisible from the outside — nothing throws, the queue just behaves
 * badly — so the assertions here are on observable *mechanics*: the batchSize
 * asked of `fetch`, the peak overlap of executing listeners, and the arguments
 * handed to `complete`/`fail`.
 *
 * pg-boss is a stub; no Postgres. Fake timers stand in for both the loop's
 * backoff sleeps and each job's runtime, so "these jobs overlap" is expressed by
 * advancing the clock rather than by racing real wall time.
 */

/**
 * Mirrors the private backoff fields on PGBossEventService. Duplicated rather
 * than read off the instance so that the test asserts the intended values —
 * reading them back would pass no matter what they were changed to.
 */
const BACKOFF_WHEN_FULL_MS = 150;
const BACKOFF_WHEN_EMPTY_MS = 5000;

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

interface StubBoss {
  fetch: jest.Mock;
  complete: jest.Mock;
  fail: jest.Mock;
  stop: jest.Mock;
}

/** A row as pg-boss would hand it back from fetch(). */
interface QueuedJob {
  id: string;
  data: { name: string; durationMs: number };
}

interface FetchCall {
  queue: string;
  batchSize: number;
}

/**
 * The parts of PGBossEventService the loop tests have to reach. All private:
 * the loop is only reachable from onModuleInit, which would demand a live
 * Postgres, and the ceilings come from process-wide `config` read at
 * construction — overriding them per instance is how one test gets a 2-slot
 * ceiling without mutating config for every other suite in the run.
 */
interface WorkerInternals {
  boss: StubBoss;
  globalSemaphore: LimitFunction;
  perQueueSemaphores: Map<string, LimitFunction>;
  fetchBatchSize: number;
  running: boolean;
  stopTasks: Promise<void>[];
  work(queue: string): Promise<void>;
  flush(): Promise<void>;
}

function internals(service: PGBossEventService): WorkerInternals {
  return service as unknown as WorkerInternals;
}

/** Push fake time forward in steps until `promise` settles, so timer-driven work can finish. */
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

interface Harness {
  service: PGBossEventService;
  emitter: EventEmitter2;
  logger: StubLogger;
  boss: StubBoss;
  fetchCalls: FetchCall[];
  /** Jobs waiting in the fake queue, consumed batchSize-at-a-time by fetch(). */
  enqueue(queue: string, eventName: string, durationsMs: number[]): void;
  /** Attach a listener that holds its slot for the job's durationMs, then acks. */
  listen(queue: string, eventName: string, outcome?: 'done' | 'fail' | 'defer' | 'throw'): void;
  /** Start the worker loop for a queue (as onModuleInit would). */
  start(queue: string): void;
  /** Peak number of listeners executing simultaneously on one queue. */
  peakFor(queue: string): number;
  /** Peak number of listeners executing simultaneously across all queues. */
  peakTotal(): number;
  /** Job ids whose listener ran to completion, in order. */
  executed: string[];
  shutdown(): Promise<void>;
}

const harnesses: Harness[] = [];

function makeHarness(options: {
  queues: string[];
  globalConcurrency?: number;
  perQueueConcurrency?: number;
  fetchBatchSize?: number;
}): Harness {
  const { queues, globalConcurrency = 32, perQueueConcurrency = 6, fetchBatchSize = 20 } = options;

  const logger: StubLogger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  const emitter = new EventEmitter2();
  const service = new PGBossEventService(emitter, logger as unknown as LoggerService);

  const backlogs = new Map<string, QueuedJob[]>();
  const fetchCalls: FetchCall[] = [];

  const boss: StubBoss = {
    fetch: jest.fn(async (queue: string, fetchOptions: { batchSize: number }) => {
      fetchCalls.push({ queue, batchSize: fetchOptions.batchSize });

      const backlog = backlogs.get(queue) ?? [];

      return backlog.splice(0, fetchOptions.batchSize);
    }),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  };

  const worker = internals(service);

  worker.boss = boss;
  worker.globalSemaphore = plimit(globalConcurrency);
  worker.fetchBatchSize = fetchBatchSize;

  for (const queue of queues) {
    worker.perQueueSemaphores.set(queue, plimit(perQueueConcurrency));
  }

  // Peak overlap is measured at the listener boundary rather than from the
  // semaphores' counters: a slot is held slightly longer than the work itself
  // (through boss.complete), and the number that mattered in production is how
  // many listeners were hitting Ollama/Postgres at once.
  const inFlight = new Map<string, number>();
  const peaks = new Map<string, number>();
  let totalInFlight = 0;
  let totalPeak = 0;
  const executed: string[] = [];

  const enter = (queue: string) => {
    const next = (inFlight.get(queue) ?? 0) + 1;

    inFlight.set(queue, next);
    peaks.set(queue, Math.max(peaks.get(queue) ?? 0, next));
    totalInFlight += 1;
    totalPeak = Math.max(totalPeak, totalInFlight);
  };

  const exit = (queue: string, jobId: string) => {
    inFlight.set(queue, (inFlight.get(queue) ?? 1) - 1);
    totalInFlight -= 1;
    executed.push(jobId);
  };

  let jobSeq = 0;

  const harness: Harness = {
    service,
    emitter,
    logger,
    boss,
    fetchCalls,
    executed,

    enqueue(queue, eventName, durationsMs) {
      const backlog = backlogs.get(queue) ?? [];

      for (const durationMs of durationsMs) {
        jobSeq += 1;
        backlog.push({ id: `${queue}-job-${jobSeq}`, data: { name: eventName, durationMs } });
      }

      backlogs.set(queue, backlog);
    },

    listen(queue, eventName, outcome = 'done') {
      emitter.on(
        `${eventName}:${queue}`,
        (payload: { jobId: string; durationMs: number }, ack: Acknowledgement) => {
          enter(queue);

          const settle = () => {
            exit(queue, payload.jobId);

            if (outcome === 'fail') {
              ack.fail(new Error(`listener exploded on ${payload.jobId}`));

              return;
            }

            if (outcome === 'throw') {
              // A listener that never acks at all — the same failure path, but
              // reached by an exception escaping the emit() rather than by ack.
              throw new Error(`listener threw on ${payload.jobId}`);
            }

            if (outcome === 'defer') {
              ack.defer();

              return;
            }

            ack.done();
          };

          if (payload.durationMs > 0) {
            setTimeout(settle, payload.durationMs);

            return;
          }

          settle();
        },
      );
    },

    start(queue) {
      worker.stopTasks.push(worker.work(queue));
    },

    peakFor(queue) {
      return peaks.get(queue) ?? 0;
    },

    peakTotal() {
      return totalPeak;
    },

    async shutdown() {
      await runUntilSettled(worker.flush());
    },
  };

  harnesses.push(harness);

  return harness;
}

describe('PGBossEventService work loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Every loop must be stopped while timers are still faked, or it keeps
    // ticking into the next test (and holds the process open at the end).
    for (const harness of harnesses) {
      await harness.shutdown();
    }

    harnesses.length = 0;
    jest.useRealTimers();
  });

  describe('per-job outcome', () => {
    it('completes a job exactly once when its listener acks done', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
      expect(harness.boss.complete).toHaveBeenCalledWith('search-index', 'search-index-job-1');
      expect(harness.boss.fail).not.toHaveBeenCalled();
    });

    it('hands the listener the job payload plus its jobId, with the routing key stripped', async () => {
      const harness = makeHarness({ queues: ['search-index'] });
      const received: unknown[] = [];

      harness.emitter.on('note.created:search-index', (payload: unknown, ack: Acknowledgement) => {
        received.push(payload);
        ack.done();
      });
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      // `name` is the routing key, not payload — a listener that saw it would be
      // reading the queue's dispatch metadata as domain data.
      expect(received).toEqual([{ durationMs: 0, jobId: 'search-index-job-1' }]);
    });

    it('fails the job with the error message AND stack persisted in the job output', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created', 'fail');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.complete).not.toHaveBeenCalled();
      expect(harness.boss.fail).toHaveBeenCalledTimes(1);

      const [queue, jobId, output] = harness.boss.fail.mock.calls[0] as [
        string,
        string,
        { message: string; stack?: string; failedAt: string },
      ];

      expect(queue).toBe('search-index');
      expect(jobId).toBe('search-index-job-1');
      expect(output.message).toBe('listener exploded on search-index-job-1');
      // The stack is the whole point of the third argument: without it a job that
      // died in pgboss.job carries a message with no origin, and the failure is
      // undiagnosable once the process that logged it is gone.
      expect(output.stack).toContain('listener exploded on search-index-job-1');
      expect(output.stack).toContain('    at ');
      expect(Number.isNaN(Date.parse(output.failedAt))).toBe(false);
    });

    it('fails the job the same way when the listener throws instead of acking', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created', 'throw');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.complete).not.toHaveBeenCalled();
      expect(harness.boss.fail).toHaveBeenCalledTimes(1);

      const output = harness.boss.fail.mock.calls[0][2] as { message: string; stack?: string };

      expect(output.message).toBe('listener threw on search-index-job-1');
      expect(output.stack).toContain('    at ');
    });

    it('keeps working the queue after a job fails', async () => {
      // A failure must not take the loop down with it — before the try/catch the
      // whole worker for that queue would have died on the first bad job.
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'good.event');
      harness.listen('search-index', 'bad.event', 'fail');
      harness.enqueue('search-index', 'bad.event', [0]);
      harness.enqueue('search-index', 'good.event', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fail).toHaveBeenCalledTimes(1);
      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
      expect(harness.boss.complete).toHaveBeenCalledWith('search-index', 'search-index-job-2');
    });

    it('completes a job whose event has no listener on that queue, without running any work', async () => {
      const harness = makeHarness({ queues: ['search-index', 'geocode'] });

      // The listener exists, but on the other queue: fetching a job the queue
      // cannot handle must be a no-op ack, not a failure. Leaving it un-acked
      // would let it expire and retry forever.
      harness.listen('geocode', 'note.created');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual([]);
      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
      expect(harness.boss.complete).toHaveBeenCalledWith('search-index', 'search-index-job-1');
      expect(harness.boss.fail).not.toHaveBeenCalled();
    });

    it('leaves a deferred job active — the webhook completes it, not the loop', async () => {
      const harness = makeHarness({ queues: ['py-fn-summary'] });

      harness.listen('py-fn-summary', 'summary.requested', 'defer');
      harness.enqueue('py-fn-summary', 'summary.requested', [0]);
      harness.start('py-fn-summary');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual(['py-fn-summary-job-1']);
      expect(harness.boss.complete).not.toHaveBeenCalled();
      expect(harness.boss.fail).not.toHaveBeenCalled();
    });

    it('refuses to start a worker for a queue with no semaphore rather than running it uncapped', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.enqueue('unregistered', 'note.created', [0]);
      harness.start('unregistered');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).not.toHaveBeenCalled();
      expect(harness.logger.error).toHaveBeenCalledTimes(1);
      expect(harness.logger.error.mock.calls[0][0]).toContain('unregistered');
    });
  });

  describe('capacity ceilings', () => {
    it('never runs more than the per-queue ceiling at once, however deep the backlog', async () => {
      const harness = makeHarness({
        queues: ['image-description'],
        globalConcurrency: 32,
        perQueueConcurrency: 2,
        fetchBatchSize: 20,
      });

      harness.listen('image-description', 'file.uploaded');
      harness.enqueue(
        'image-description',
        'file.uploaded',
        Array.from({ length: 12 }, () => 100),
      );
      harness.start('image-description');

      await runUntilSettled(
        (async () => {
          while (harness.executed.length < 12) {
            await jest.advanceTimersByTimeAsync(50);
          }
        })(),
      );

      expect(harness.executed).toHaveLength(12);
      expect(harness.peakFor('image-description')).toBe(2);
    });

    it('never runs more than the global ceiling across all queues at once', async () => {
      const harness = makeHarness({
        queues: ['search-index', 'geocode', 'image-description'],
        globalConcurrency: 3,
        perQueueConcurrency: 3,
      });

      for (const queue of ['search-index', 'geocode', 'image-description']) {
        harness.listen(queue, 'file.uploaded');
        harness.enqueue(
          queue,
          'file.uploaded',
          Array.from({ length: 6 }, () => 100),
        );
        harness.start(queue);
      }

      await runUntilSettled(
        (async () => {
          while (harness.executed.length < 18) {
            await jest.advanceTimersByTimeAsync(50);
          }
        })(),
      );

      expect(harness.executed).toHaveLength(18);
      // Exactly the ceiling: below it would mean the pool is under-used, above it
      // means the global cap leaks.
      expect(harness.peakTotal()).toBe(3);
    });

    it('does not let a burst on one queue consume every global slot and starve another', async () => {
      // The production stall: slow image-description/embedding jobs took every
      // global slot and search-index sat idle behind them. The per-queue ceiling
      // is sized below the global one precisely so a single queue can only ever
      // hold its share.
      const harness = makeHarness({
        queues: ['image-description', 'search-index'],
        globalConcurrency: 4,
        perQueueConcurrency: 2,
      });

      harness.listen('image-description', 'file.uploaded');
      harness.listen('search-index', 'note.created');
      harness.enqueue(
        'image-description',
        'file.uploaded',
        Array.from({ length: 20 }, () => 2000),
      );
      harness.enqueue('search-index', 'note.created', [100, 100, 100]);
      harness.start('image-description');
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1000);

      // The slow queue is still holding slots (its jobs run for 2000ms), yet the
      // fast queue has drained its whole backlog.
      expect(harness.executed).toEqual(['search-index-job-21', 'search-index-job-22', 'search-index-job-23']);
      expect(harness.peakFor('image-description')).toBe(2);
      expect(harness.peakTotal()).toBeLessThanOrEqual(4);
    });

    it('asks for no more jobs than it has room to run', async () => {
      const harness = makeHarness({
        queues: ['image-description'],
        globalConcurrency: 32,
        perQueueConcurrency: 4,
        fetchBatchSize: 20,
      });

      harness.listen('image-description', 'file.uploaded');
      // One job outlives the others by an order of magnitude, so the second fetch
      // happens with exactly one slot still occupied.
      harness.enqueue('image-description', 'file.uploaded', [4000, 100, 100, 100, 100, 100, 100, 100]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.fetchCalls).toEqual([{ queue: 'image-description', batchSize: 4 }]);

      // t=100: three of the four jobs finish. t=150: the loop wakes from its
      // full-capacity backoff with 3 free slots and 1 still held by the long job.
      await jest.advanceTimersByTimeAsync(200);

      expect(harness.fetchCalls[1]).toEqual({ queue: 'image-description', batchSize: 3 });

      // Whatever the backlog depth, no fetch ever asks for more than the ceiling.
      for (const call of harness.fetchCalls) {
        expect(call.batchSize).toBeLessThanOrEqual(4);
        expect(call.batchSize).toBeGreaterThan(0);
      }
    });

    it('caps the batch at fetchBatchSize even when far more capacity is free', async () => {
      const harness = makeHarness({
        queues: ['search-index'],
        globalConcurrency: 32,
        perQueueConcurrency: 16,
        fetchBatchSize: 2,
      });

      harness.listen('search-index', 'note.created');
      harness.enqueue(
        'search-index',
        'note.created',
        Array.from({ length: 10 }, () => 100),
      );
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      // Ten jobs at two per fetch: five full batches and one empty poll. Every
      // request is pinned to fetchBatchSize, never to the 16 idle per-queue slots
      // — the batch bound is what keeps a single fetch from claiming (and holding
      // the lease on) more rows than this process will get to soon.
      expect(harness.fetchCalls.map((call) => call.batchSize)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(harness.fetchCalls.every((call) => call.queue === 'search-index')).toBe(true);
    });
  });

  describe('backoff', () => {
    it('waits the empty-queue backoff before polling again instead of spinning', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS - 2);

      // A loop that re-polled on every pass would have hammered the DB with
      // thousands of empty fetches by now.
      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(2);
    });

    it('picks up work that arrives while the queue was idle', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);
      harness.enqueue('search-index', 'note.created', [0]);
      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS);

      expect(harness.executed).toEqual(['search-index-job-1']);
      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
    });

    it('stops fetching entirely while every slot is occupied, then resumes', async () => {
      const harness = makeHarness({
        queues: ['image-description'],
        globalConcurrency: 32,
        perQueueConcurrency: 1,
        fetchBatchSize: 20,
      });

      harness.listen('image-description', 'file.uploaded');
      harness.enqueue('image-description', 'file.uploaded', [1000, 100]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);

      // Six full-capacity backoffs elapse with the single slot still held. A loop
      // that fetched while full would have pulled the second job and executed it
      // over the ceiling; a loop that spun without backoff would burn the CPU.
      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_FULL_MS * 6);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);
      expect(harness.peakFor('image-description')).toBe(1);

      // The long job ends at t=1000; the next backoff tick finds a free slot.
      await jest.advanceTimersByTimeAsync(1000 + BACKOFF_WHEN_FULL_MS);

      expect(harness.boss.fetch.mock.calls.length).toBeGreaterThan(1);
      expect(harness.executed).toContain('image-description-job-2');
      expect(harness.peakFor('image-description')).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('drains in-flight work before stopping pg-boss instead of abandoning it', async () => {
      const harness = makeHarness({
        queues: ['image-description'],
        globalConcurrency: 32,
        perQueueConcurrency: 4,
      });

      harness.listen('image-description', 'file.uploaded');
      harness.enqueue('image-description', 'file.uploaded', [500, 500, 500, 500]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      // Four jobs are mid-flight and none has acked yet.
      expect(harness.peakFor('image-description')).toBe(4);
      expect(harness.boss.complete).not.toHaveBeenCalled();

      await runUntilSettled(harness.service.onModuleDestroy());

      expect(harness.executed).toHaveLength(4);
      expect(harness.boss.complete).toHaveBeenCalledTimes(4);
      expect(harness.boss.stop).toHaveBeenCalledTimes(1);

      // Ordering is the actual guarantee: closing the pg-boss connection first
      // would strand jobs as `active` until they expired and were retried.
      const stoppedAt = harness.boss.stop.mock.invocationCallOrder[0];

      for (const completedAt of harness.boss.complete.mock.invocationCallOrder) {
        expect(completedAt).toBeLessThan(stoppedAt);
      }
    });

    it('stops fetching new work once shutdown has begun', async () => {
      const harness = makeHarness({
        queues: ['search-index'],
        globalConcurrency: 32,
        perQueueConcurrency: 2,
      });

      harness.listen('search-index', 'note.created');
      harness.enqueue('search-index', 'note.created', [500, 500, 500, 500, 500, 500]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      const fetchesBeforeShutdown = harness.boss.fetch.mock.calls.length;

      await runUntilSettled(harness.service.onModuleDestroy());

      expect(harness.boss.fetch).toHaveBeenCalledTimes(fetchesBeforeShutdown);
      // Only the two already-claimed jobs ran; the remaining four stay queued for
      // the next process rather than being pulled into a dying one.
      expect(harness.executed).toHaveLength(2);
      expect(harness.boss.complete).toHaveBeenCalledTimes(2);
    });

    it('still stops pg-boss when draining throws', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.boss.complete.mockRejectedValue(new Error('connection reset'));
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);
      await runUntilSettled(harness.service.onModuleDestroy());

      // complete() throwing routes the job into fail(), which is the loop's
      // catch — shutdown must survive it and still close the client.
      expect(harness.boss.fail).toHaveBeenCalledTimes(1);
      expect(harness.boss.stop).toHaveBeenCalledTimes(1);
    });
  });
});
