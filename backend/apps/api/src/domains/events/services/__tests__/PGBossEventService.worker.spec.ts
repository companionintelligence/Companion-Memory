import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit, { type LimitFunction } from 'p-limit';

import type { LoggerService } from '@ci/common/logging';

// Sibling import, not the `@ci/domains/events` barrel: a file inside a domain
// reaching back through its own index is `no-intra-domain-via-barrel`, and it
// would make this spec depend on the module's whole boot graph to read one type.
import { EventListenerRegistry } from '../../event-registration';
import type { JobSlotPool } from '../../jobSlotPool';
import type { Acknowledgement } from '../../types';
import { YIELD_GATE_TIMEOUT_MS, YieldGateRegistry } from '../../yieldGates';
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

/**
 * The hard floor `PGBossEventService` puts under every per-job deadline, mirrored
 * here for the same reason as the backoffs. A deadline below the time healthy
 * work takes stops being a backstop and becomes a dead-letter generator, so the
 * floor is asserted rather than trusted.
 */
const MIN_JOB_DEADLINE_MS = 60_000;

/**
 * The fallback deadline these tests give the harness. Comfortably above the
 * floor so a test that means to exercise the configured value is not silently
 * testing the floor instead.
 */
const HARNESS_JOB_TIMEOUT_MS = 120_000;

/**
 * The bound on one complete()/fail() round trip, mirrored for the same reason
 * as the backoffs: asserted, not read back.
 */
const BOOKKEEPING_TIMEOUT_MS = 30_000;

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
  // The fetch-side budget. Read back only to assert it is EMPTY once the work
  // is done: a slot that is never returned is invisible from the outside until
  // enough of them have leaked that the queue quietly stops fetching at all.
  globalSlots: JobSlotPool;
  perQueueSemaphores: Map<string, LimitFunction>;
  queueLanes: Map<string, string>;
  declaredQueueCeilings: Map<string, number>;
  provisionSemaphore(queue: string): LimitFunction;
  // The shipped ceilings the loop re-derives its semaphore sizes from on every
  // settings change. Sizing the semaphores alone is not enough any more: the
  // first loop iteration re-applies these, so a harness that only replaced the
  // `plimit` instances would watch them snap back to the config values.
  shippedConcurrency: number;
  shippedPerQueueConcurrency: number;
  fetchBatchSize: number;
  // The fallback per-job execution deadline, for queues declaring no
  // `expireInSeconds`. Overridden per instance for the same reason the ceilings
  // are: the shipped value is two hours, and no test should advance fake time
  // that far to watch a stuck job get cut loose.
  jobTimeoutMs: number;
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
  /**
   * Attach a listener that holds its slot for the job's durationMs, then acks.
   *
   * `never` is the wedged listener: it enters and never acknowledges at all —
   * an HTTP call with no timeout, an Ollama generation that hangs. Before the
   * execution deadline existed, that job held its per-queue slot, its global
   * semaphore slot and its JobSlotPool slot for the life of the process.
   */
  listen(queue: string, eventName: string, outcome?: 'done' | 'fail' | 'defer' | 'throw' | 'never'): void;
  /** Start the worker loop for a queue (as onModuleInit would). */
  start(queue: string): void;
  /** Peak number of listeners executing simultaneously on one queue. */
  peakFor(queue: string): number;
  /** Peak number of listeners executing simultaneously across all queues. */
  peakTotal(): number;
  /** Peak number of rows leased from pg-boss (fetched, not yet acked) at once. */
  peakLeased(): number;
  /** Global slots currently claimed — zero whenever nothing is in flight. */
  reservedSlots(): number;
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
  jobTimeoutMs?: number;
  /** Queue → lane, provisioned the way onModuleInit would (shared semaphore). */
  lanes?: Record<string, string>;
}): Harness {
  const {
    queues,
    globalConcurrency = 32,
    perQueueConcurrency = 6,
    fetchBatchSize = 20,
    jobTimeoutMs = HARNESS_JOB_TIMEOUT_MS,
    lanes = {},
  } = options;

  const logger: StubLogger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  const emitter = new EventEmitter2();
  const service = new PGBossEventService(emitter, logger as unknown as LoggerService, {} as never);

  const backlogs = new Map<string, QueuedJob[]>();
  const fetchCalls: FetchCall[] = [];

  // Rows handed out by fetch() and not yet acked — i.e. what pg-boss would be
  // holding in state `active`, and what the Jobs console's "Running" tile counts.
  // Distinct from the peak listener overlap below: a leased row is one this
  // process has taken the lease on, whether or not it is being worked.
  let leased = 0;
  let peakLeased = 0;

  const release = () => {
    leased = Math.max(leased - 1, 0);
  };

  const boss: StubBoss = {
    fetch: jest.fn(async (queue: string, fetchOptions: { batchSize: number }) => {
      fetchCalls.push({ queue, batchSize: fetchOptions.batchSize });

      const backlog = backlogs.get(queue) ?? [];
      const batch = backlog.splice(0, fetchOptions.batchSize);

      leased += batch.length;
      peakLeased = Math.max(peakLeased, leased);

      return batch;
    }),
    complete: jest.fn(async () => {
      release();
    }),
    fail: jest.fn(async () => {
      release();
    }),
    stop: jest.fn(async () => undefined),
  };

  const worker = internals(service);

  worker.boss = boss;
  worker.globalSemaphore = plimit(globalConcurrency);
  worker.shippedConcurrency = globalConcurrency;
  worker.shippedPerQueueConcurrency = perQueueConcurrency;
  worker.fetchBatchSize = fetchBatchSize;
  worker.jobTimeoutMs = jobTimeoutMs;

  for (const queue of queues) {
    const lane = lanes[queue];

    if (lane == null) {
      worker.perQueueSemaphores.set(queue, plimit(perQueueConcurrency));
      continue;
    }

    // Through the real provisioning path, so the sharing under test is the
    // service's own and not a semaphore the harness happened to hand out twice.
    worker.queueLanes.set(queue, lane);
    worker.perQueueSemaphores.set(queue, worker.provisionSemaphore(queue));
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
        // The job id comes from the ACK, not the payload — the bus no longer
        // writes into the payload. Every identity assertion below still
        // compares the same job-id strings.
        (payload: { durationMs: number }, ack: Acknowledgement) => {
          enter(queue);

          if (outcome === 'never') {
            // No ack, no throw, no timer. The promise inside executeJob is
            // simply never settled — which is the whole failure mode.
            return;
          }

          const settle = () => {
            exit(queue, ack.jobId);

            if (outcome === 'fail') {
              ack.fail(new Error(`listener exploded on ${ack.jobId}`));

              return;
            }

            if (outcome === 'throw') {
              // A listener that never acks at all — the same failure path, but
              // reached by an exception escaping the emit() rather than by ack.
              throw new Error(`listener threw on ${ack.jobId}`);
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

    peakLeased() {
      return peakLeased;
    },

    reservedSlots() {
      return worker.globalSlots.reservedCount;
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

    it('hands the listener the domain payload verbatim, with the routing key stripped', async () => {
      const harness = makeHarness({ queues: ['search-index'] });
      const received: unknown[] = [];
      const acks: Acknowledgement[] = [];

      harness.emitter.on('note.created:search-index', (payload: unknown, ack: Acknowledgement) => {
        received.push(payload);
        acks.push(ack);
        ack.done();
      });
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      // `name` is the routing key, not payload — a listener that saw it would be
      // reading the queue's dispatch metadata as domain data. And the bus adds
      // NOTHING: it used to merge `jobId` in, silently overwriting any field a
      // domain had given that name.
      expect(received).toEqual([{ durationMs: 0 }]);
      // Asserted positively, so removing the payload key is not mistaken for
      // removing the id — it moved to the acknowledgement, it did not vanish.
      expect(acks[0]?.jobId).toBe('search-index-job-1');
    });

    it("hands the listener the row's created_on as the ack's enqueuedAt", async () => {
      // How a listener tells how long its job waited. AnswerInferenceListener
      // drops inference older than its retention by it, which is what stops a
      // backlog queued hours ago from replaying in full.
      const harness = makeHarness({ queues: ['llm-background'] });
      const createdOn = new Date('2026-10-17T23:01:00Z');
      const acks: Acknowledgement[] = [];

      harness.emitter.on('infer.question.answer:llm-background', (_payload: unknown, ack: Acknowledgement) => {
        acks.push(ack);
        ack.done();
      });
      harness.boss.fetch.mockResolvedValueOnce([
        { id: 'llm-background-job-1', data: { name: 'infer.question.answer' }, createdOn },
      ]);
      harness.start('llm-background');

      await jest.advanceTimersByTimeAsync(1);

      expect(acks[0]?.enqueuedAt).toBe(createdOn);
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

    it('names the queue the job failed on, because the dead-letter copy keeps only data and output', async () => {
      // pg-boss copies `data` and `output` onto `dead-letter` and drops the queue.
      // DeadLetterReaperListener reads this back, so replay can send the letter
      // to this queue alone instead of every queue listening for the event.
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created', 'fail');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      const output = harness.boss.fail.mock.calls[0][2] as { queue?: string };

      expect(output.queue).toBe('search-index');
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

    it('does not let concurrent queues collectively lease more jobs than the global ceiling', async () => {
      // The capacity arithmetic is a READ of the global limiter, and every queue
      // reads it before any of them dispatches: `onModuleInit` starts one
      // un-awaited `work()` per queue, each runs synchronously as far as its
      // first `fetch`, so all of them see the same untouched budget and fetch
      // against it. On the appliance that is ~38 loops each claiming
      // `min(perQueue, global, batch)` rows against a ceiling of 10.
      //
      // The rows are not merely counted wrong. Every one of them is `active` in
      // pg-boss — on its lease clock, and counted by the Jobs console's
      // "Running" tile — while it sits in a semaphore waiting for a slot the box
      // will not have for minutes.
      const queues = Array.from({ length: 12 }, (_, index) => `queue-${index}`);
      const harness = makeHarness({
        queues,
        globalConcurrency: 3,
        perQueueConcurrency: 2,
        fetchBatchSize: 10,
      });

      for (const queue of queues) {
        harness.listen(queue, 'file.uploaded');
        harness.enqueue(
          queue,
          'file.uploaded',
          Array.from({ length: 3 }, () => 100),
        );
      }

      // Started in one synchronous pass, exactly as onModuleInit starts them.
      for (const queue of queues) {
        harness.start(queue);
      }

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.peakLeased()).toBeLessThanOrEqual(3);

      await runUntilSettled(
        (async () => {
          while (harness.executed.length < 36) {
            await jest.advanceTimersByTimeAsync(50);
          }
        })(),
      );

      // Bounding the lease must not cost throughput: every job still runs, and
      // the pool still runs at its ceiling rather than one job at a time.
      expect(harness.executed).toHaveLength(36);
      expect(harness.peakLeased()).toBeLessThanOrEqual(3);
      expect(harness.peakTotal()).toBe(3);
    });

    it('gives back the slots a short fetch did not fill, instead of leaking the budget', async () => {
      // Every empty poll claims capacity it then does not use. Unreturned, those
      // claims are permanent: the budget shrinks poll by poll until the appliance
      // fetches nothing at all — with no error anywhere, just idle queues. A
      // one-slot ceiling makes a single leak fatal rather than statistical.
      const harness = makeHarness({ queues: ['search-index'], globalConcurrency: 1 });

      harness.listen('search-index', 'note.created');
      harness.start('search-index');

      // Ten polls against an empty queue: ten reservations, ten short fetches.
      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS * 10);

      expect(harness.reservedSlots()).toBe(0);

      harness.enqueue('search-index', 'note.created', [0]);
      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS);

      expect(harness.executed).toEqual(['search-index-job-1']);
      expect(harness.reservedSlots()).toBe(0);
    });

    it('gives back the slots when the fetch itself throws', async () => {
      const harness = makeHarness({ queues: ['search-index'], globalConcurrency: 1 });

      harness.listen('search-index', 'note.created');
      harness.boss.fetch.mockRejectedValueOnce(new Error('connection terminated'));
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS * 2);

      // A failed fetch leased nothing, so nothing will come back to release its
      // reservation — the loop has to hand it back itself, or a transient
      // database blip permanently costs the appliance a slot.
      expect(harness.executed).toEqual(['search-index-job-1']);
      expect(harness.reservedSlots()).toBe(0);
    });

    it('gives back the slot of a job that failed, not only of one that completed', async () => {
      const harness = makeHarness({ queues: ['search-index'], globalConcurrency: 1 });

      harness.listen('search-index', 'bad.event', 'fail');
      harness.listen('search-index', 'good.event');
      harness.enqueue('search-index', 'bad.event', [0]);
      harness.enqueue('search-index', 'good.event', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS);

      expect(harness.boss.fail).toHaveBeenCalledTimes(1);
      // On a one-slot appliance, a failure that kept its slot would mean the next
      // job never runs — the queue stops dead on its first bad row.
      expect(harness.executed).toEqual(['search-index-job-1', 'search-index-job-2']);
      expect(harness.reservedSlots()).toBe(0);
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

  /**
   * The loop's two un-awaited edges. A rejection escaping either one is not a
   * logged error — it is an unhandled rejection, which under Node's default (and
   * NestJS's) takes the whole appliance down. Both paths are reached by ordinary
   * transient database trouble, so "the DB hiccupped" must not mean "the server
   * restarted", nor "this queue silently stopped working until the next deploy".
   */
  describe('database faults', () => {
    it('keeps polling after a fetch throws instead of killing the worker', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.boss.fetch.mockRejectedValueOnce(new Error('connection terminated'));
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);
      expect(harness.logger.error).toHaveBeenCalled();

      // The pre-fix loop propagated this out of `while`, rejecting the promise
      // parked in stopTasks: the process died, and had it survived, this queue
      // would have had no worker for the rest of its life while every other
      // queue kept running. It must simply back off and poll again.
      harness.enqueue('search-index', 'note.created', [0]);
      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS);

      expect(harness.boss.fetch.mock.calls.length).toBeGreaterThan(1);
      expect(harness.executed).toEqual(['search-index-job-1']);

      await runUntilSettled(harness.service.onModuleDestroy());
    });

    it('survives a fail() that itself throws', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created', 'fail');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.boss.fail.mockRejectedValue(new Error('connection terminated'));
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      // A failing job whose failure cannot be recorded used to reject inside the
      // un-awaited semaphore callback — a job error escalating into a process
      // exit. It is logged and left for pg-boss's expiration instead.
      expect(harness.boss.fail).toHaveBeenCalledTimes(1);
      expect(harness.logger.error).toHaveBeenCalled();

      await runUntilSettled(harness.service.onModuleDestroy());

      expect(harness.boss.stop).toHaveBeenCalledTimes(1);
    });

    // ═══ ACKNOWLEDGEMENTS THAT NEVER COME BACK ═══
    //
    // complete() and fail() run inside the job's slots, AFTER the listener's own
    // deadline. A round trip that neither resolves nor rejects — pg-boss sets no
    // statement timeout and its pool waits for a connection without limit — held
    // the slot exactly as a hung listener did: the row stayed `active` and
    // nothing behind it on that queue (or its lane) was ever fetched.
    it('releases the slot when complete() never returns, and works the next job', async () => {
      const harness = makeHarness({ queues: ['llm-background'], perQueueConcurrency: 1 });

      harness.listen('llm-background', 'infer.question.answer');
      harness.enqueue('llm-background', 'infer.question.answer', [0, 0]);
      harness.boss.complete.mockImplementationOnce(() => new Promise(() => undefined));
      harness.start('llm-background');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual(['llm-background-job-1']);

      await jest.advanceTimersByTimeAsync(BOOKKEEPING_TIMEOUT_MS + BACKOFF_WHEN_FULL_MS);

      expect(harness.executed).toEqual(['llm-background-job-1', 'llm-background-job-2']);
      // Logged and left to pg-boss's lease expiry — never escalated to fail(),
      // because the listener succeeded.
      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(
        harness.logger.error.mock.calls.some(([line]) => String(line).includes('could not be marked complete')),
      ).toBe(true);
      expect(harness.reservedSlots()).toBe(0);
    });

    it('releases the slot when fail() never returns, and works the next job', async () => {
      const harness = makeHarness({ queues: ['llm-background'], perQueueConcurrency: 1 });

      harness.listen('llm-background', 'infer.question.answer', 'fail');
      harness.enqueue('llm-background', 'infer.question.answer', [0, 0]);
      harness.boss.fail.mockImplementationOnce(() => new Promise(() => undefined));
      harness.start('llm-background');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual(['llm-background-job-1']);

      await jest.advanceTimersByTimeAsync(BOOKKEEPING_TIMEOUT_MS + BACKOFF_WHEN_FULL_MS);

      expect(harness.executed).toEqual(['llm-background-job-1', 'llm-background-job-2']);
      expect(harness.boss.fail).toHaveBeenCalledTimes(2);
      expect(
        harness.logger.error.mock.calls.some(([line]) => String(line).includes('Could not record the failure')),
      ).toBe(true);
      expect(harness.reservedSlots()).toBe(0);
    });
  });

  /**
   * The per-job execution deadline.
   *
   * `executeJob` resolves only when the listener acknowledges, and nothing else
   * ever forced that to happen. A listener that neither resolved nor rejected —
   * an HTTP call with no timeout, an Ollama generation that hung — kept its
   * per-queue slot, its global semaphore slot and its JobSlotPool slot until the
   * process restarted, and pg-boss's own `expireInSeconds` is no help: it
   * re-queues the row in Postgres, it cannot reach into this process and release
   * a semaphore. The clearest statement of the failure is that it is INVISIBLE —
   * nothing throws, nothing logs, the queue just quietly stops fetching once
   * enough slots have leaked.
   *
   * So the assertions are on the three observable consequences: the job is
   * failed (pg-boss's retry and dead-letter policy takes it from there), the
   * slots come back, and the loop is still fetching afterwards.
   */
  describe('execution deadline', () => {
    afterEach(() => {
      // The registry is process-global. This file registers into it only here.
      EventListenerRegistry.clear();
    });

    it('fails a job whose listener never acknowledges, releases its slots, and keeps fetching', async () => {
      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'file.uploaded', 'never');
      harness.enqueue('image-description', 'file.uploaded', [0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      // A backstop, not a short leash: nothing has happened to the job yet, and
      // its global slot is still held.
      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(harness.reservedSlots()).toBe(1);

      await jest.advanceTimersByTimeAsync(HARNESS_JOB_TIMEOUT_MS);

      // (a) The job is failed, through the SAME path an exploding listener takes
      // — so it inherits retryLimit/retryDelay and ends up in `dead-letter`
      // rather than needing a second disposal route.
      expect(harness.boss.complete).not.toHaveBeenCalled();
      expect(harness.boss.fail).toHaveBeenCalledTimes(1);

      const [queue, jobId, output] = harness.boss.fail.mock.calls[0] as [
        string,
        string,
        { message: string; stack?: string; failedAt: string },
      ];

      expect(queue).toBe('image-description');
      expect(jobId).toBe('image-description-job-1');
      // The reason is persisted in pgboss.job.output, naming the deadline —
      // otherwise a timed-out job is indistinguishable from a thrown one.
      expect(output.message).toContain('execution deadline');
      expect(output.message).toContain('file.uploaded');

      // The signal that did not exist before: an error-level line for the
      // timeout itself.
      expect(harness.logger.error).toHaveBeenCalled();

      // (b) The fetch-side budget is whole again. This is the slot whose leak is
      // invisible from the outside until enough have gone that the queue stops.
      expect(harness.reservedSlots()).toBe(0);

      // (c) The loop survived it and is still asking pg-boss for work.
      const fetchesAtTimeout = harness.boss.fetch.mock.calls.length;

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS * 2);

      expect(harness.boss.fetch.mock.calls.length).toBeGreaterThan(fetchesAtTimeout);
    });

    it("does not kill work that outlasts the global default but fits its queue's declared expiry", async () => {
      // What `py-fn-hbpe` does for real: it declares ~8 h because a GGUF
      // labelling pass legitimately takes hours. A deadline derived from the
      // appliance-wide default alone would dead-letter every one of them.
      EventListenerRegistry.register('python.function.run', 'PyFnListener', 'handle', 'py-fn-hbpe', {
        expireInSeconds: 600,
      });

      const harness = makeHarness({ queues: ['py-fn-hbpe'] });

      harness.listen('py-fn-hbpe', 'python.function.run');
      // Five minutes: past the two-minute fallback, well inside the queue's ten.
      harness.enqueue('py-fn-hbpe', 'python.function.run', [300_000]);
      harness.start('py-fn-hbpe');

      await jest.advanceTimersByTimeAsync(400_000);

      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
      expect(harness.executed).toEqual(['py-fn-hbpe-job-1']);
    });

    it('floors an implausibly short declared expiry instead of dead-lettering healthy work', async () => {
      // A misconfigured `expireInSeconds: 1` must not become a machine for
      // failing every job on that queue. The floor only ever RAISES a deadline.
      EventListenerRegistry.register('tiny.expiry', 'TinyListener', 'handle', 'tiny', {
        expireInSeconds: 1,
      });

      const harness = makeHarness({ queues: ['tiny'] });

      harness.listen('tiny', 'tiny.expiry');
      harness.enqueue('tiny', 'tiny.expiry', [MIN_JOB_DEADLINE_MS - 5_000]);
      harness.start('tiny');

      await jest.advanceTimersByTimeAsync(MIN_JOB_DEADLINE_MS);

      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
    });

    it('leaves a deferred job alone — the deadline is on EXECUTION, not on completion', async () => {
      // `ack.defer()` settles the promise promptly with outcome `deferred`; the
      // external executor's callback arrives minutes or hours later, out of
      // band. Racing that would break every python-function job.
      const harness = makeHarness({ queues: ['py-fn-summary'] });

      harness.listen('py-fn-summary', 'python.function.run', 'defer');
      harness.enqueue('py-fn-summary', 'python.function.run', [0]);
      harness.start('py-fn-summary');

      await jest.advanceTimersByTimeAsync(HARNESS_JOB_TIMEOUT_MS * 2);

      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(harness.boss.complete).not.toHaveBeenCalled();
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

      // A complete() that throws must NOT be escalated into fail(): the listener
      // already succeeded, and failing it burns a retry on work that is done —
      // repeatedly, until the job dead-letters. The job is left `active` for
      // pg-boss's expiration to re-queue, and shutdown still closes the client.
      expect(harness.boss.fail).not.toHaveBeenCalled();
      expect(harness.boss.stop).toHaveBeenCalledTimes(1);
    });

    it('does not fail a job whose listener succeeded but whose completion errored', async () => {
      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.boss.complete.mockRejectedValue(new Error('connection reset'));
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      // The work ran exactly once and was never marked failed. Before this, the
      // shared try/catch around executeJob + complete() turned a transient
      // acknowledgement error into a false failure — and, once the retries ran
      // out, dead-lettered a job that had actually done its work.
      expect(harness.executed).toHaveLength(1);
      expect(harness.boss.fail).not.toHaveBeenCalled();

      await runUntilSettled(harness.service.onModuleDestroy());
    });
  });

  /**
   * `queueOptions.lane`: several queues drawing from ONE slot. Four
   * Ollama-bound background queues each declared `localConcurrency: 1`, which
   * is four generations in front of a single-slot runner at once — nothing
   * breaks at Ollama, but every request's wait in that line is what the
   * first-response deadline measures. On a lane they are one slot between
   * them, while keeping their own backlogs and policies.
   */
  describe('lane', () => {
    afterEach(() => {
      EventListenerRegistry.clear();
    });

    it('never runs jobs from two queues on one lane at the same time', async () => {
      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        localConcurrency: 1,
      });
      EventListenerRegistry.register('file.uploaded', 'ThingListener', 'handle', 'thing-vision', {
        localConcurrency: 1,
      });

      const harness = makeHarness({
        queues: ['image-description', 'thing-vision'],
        perQueueConcurrency: 1,
        lanes: { 'image-description': 'ollama-background', 'thing-vision': 'ollama-background' },
      });

      harness.listen('image-description', 'preview.generated');
      harness.listen('thing-vision', 'file.uploaded');
      harness.enqueue('image-description', 'preview.generated', [1_000, 1_000]);
      harness.enqueue('thing-vision', 'file.uploaded', [1_000, 1_000]);
      harness.start('image-description');
      harness.start('thing-vision');

      await runUntilSettled(
        (async () => {
          while (harness.executed.length < 4) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })(),
      );

      expect(harness.executed).toHaveLength(4);
      // The number that matters: one generation at the runner at a time,
      // across BOTH queues — not one per queue.
      expect(harness.peakTotal()).toBe(1);
      expect(harness.peakLeased()).toBe(1);
    });

    it('sizes the lane to its smallest member, whatever the others declare', async () => {
      EventListenerRegistry.register('a.event', 'AListener', 'handle', 'lane-a', { localConcurrency: 3 });
      EventListenerRegistry.register('b.event', 'BListener', 'handle', 'lane-b', { localConcurrency: 1 });

      const harness = makeHarness({
        queues: ['lane-a', 'lane-b'],
        perQueueConcurrency: 6,
        lanes: { 'lane-a': 'shared', 'lane-b': 'shared' },
      });
      const worker = internals(harness.service);

      worker.declaredQueueCeilings.set('lane-a', 3);
      worker.declaredQueueCeilings.set('lane-b', 1);

      // Re-provision after the ceilings are known, as onModuleInit does in
      // declaration order: the second member lowers the pool to its own 1.
      worker.perQueueSemaphores.set('lane-a', worker.provisionSemaphore('lane-a'));
      worker.perQueueSemaphores.set('lane-b', worker.provisionSemaphore('lane-b'));

      expect(worker.perQueueSemaphores.get('lane-a')).toBe(worker.perQueueSemaphores.get('lane-b'));
      expect(worker.perQueueSemaphores.get('lane-a')?.concurrency).toBe(1);
    });

    it('leaves queues on different lanes, and lane-less queues, independent', async () => {
      const harness = makeHarness({
        queues: ['lane-x', 'solo'],
        perQueueConcurrency: 1,
        lanes: { 'lane-x': 'x' },
      });

      harness.listen('lane-x', 'x.event');
      harness.listen('solo', 'solo.event');
      harness.enqueue('lane-x', 'x.event', [1_000]);
      harness.enqueue('solo', 'solo.event', [1_000]);
      harness.start('lane-x');
      harness.start('solo');

      await jest.advanceTimersByTimeAsync(500);

      expect(harness.peakTotal()).toBe(2);
    });
  });

  /**
   * `queueOptions.yieldsTo`: a queue standing aside for something more urgent
   * — the image-description queue for an interactive chat turn, so the GPU
   * can go idle long enough for Ollama to swap the chat model in. The
   * mechanics under test: no lease is taken while the gate is closed, the job
   * already running is never cut, work resumes the moment the gate opens, and
   * a mis-wired or exploding gate leaves the queue RUNNING rather than frozen.
   */
  describe('yield gate', () => {
    const BACKOFF_WHEN_YIELDING_MS = 1000;

    afterEach(() => {
      EventListenerRegistry.clear();
      YieldGateRegistry.clear();
    });

    it('takes no lease while the gate is closed, then resumes the backlog when it opens', async () => {
      let chatPending = true;

      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'interactive-chat',
      });
      YieldGateRegistry.register('interactive-chat', () => chatPending);

      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [0, 0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_YIELDING_MS * 5);

      // Standing aside is between jobs and costs a backlog, not work: nothing
      // fetched, nothing leased, nothing run — and it is logged, once.
      expect(harness.boss.fetch).not.toHaveBeenCalled();
      expect(harness.executed).toEqual([]);
      expect(harness.reservedSlots()).toBe(0);
      expect(
        harness.logger.log.mock.calls.filter(([line]) => String(line).includes('standing aside')),
      ).toHaveLength(1);

      chatPending = false;

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_YIELDING_MS + 1);

      expect(harness.executed).toEqual(['image-description-job-1', 'image-description-job-2']);
      expect(harness.logger.log.mock.calls.filter(([line]) => String(line).includes('resumed'))).toHaveLength(
        1,
      );
    });

    it('lets the job that was already running finish; only the next fetch waits', async () => {
      let chatPending = false;

      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'interactive-chat',
      });
      YieldGateRegistry.register('interactive-chat', () => chatPending);

      const harness = makeHarness({
        queues: ['image-description'],
        perQueueConcurrency: 1,
        fetchBatchSize: 1,
      });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [10_000, 0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);

      // A chat turn arrives mid-description.
      chatPending = true;

      await jest.advanceTimersByTimeAsync(10_000);

      expect(harness.boss.complete).toHaveBeenCalledTimes(1);
      expect(harness.executed).toEqual(['image-description-job-1']);

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_YIELDING_MS * 3);

      expect(harness.boss.fetch).toHaveBeenCalledTimes(1);
      expect(harness.executed).toEqual(['image-description-job-1']);
    });

    it('does not yield for a gate nobody registered, and warns once', async () => {
      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'nobody-registered-this',
      });

      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS * 2);

      expect(harness.executed).toEqual(['image-description-job-1']);
      expect(
        harness.logger.warn.mock.calls.filter(([line]) =>
          String(line).includes('no such gate is registered'),
        ),
      ).toHaveLength(1);
    });

    it('does not yield for a gate that throws', async () => {
      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'interactive-chat',
      });
      YieldGateRegistry.register('interactive-chat', () => {
        throw new Error('database gone');
      });

      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual(['image-description-job-1']);
    });

    it('does not wait forever on a gate that never answers', async () => {
      // A lookup that neither resolves nor rejects — a database that has stopped
      // answering. Every yielding queue awaits the gate before it fetches, so
      // unbounded this froze all four Ollama background queues at once, with
      // nothing logged, while their senders kept enqueueing.
      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'interactive-chat',
      });
      YieldGateRegistry.register('interactive-chat', () => new Promise<boolean>(() => undefined));

      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.boss.fetch).not.toHaveBeenCalled();

      // Read as open once the bound passes — the rule already applied to a gate
      // that throws or was never registered.
      await jest.advanceTimersByTimeAsync(YIELD_GATE_TIMEOUT_MS);

      expect(harness.executed).toEqual(['image-description-job-1']);
    });

    it('says nothing when the gate is open from the start — no "resumed" for a queue that never stood aside', async () => {
      EventListenerRegistry.register('preview.generated', 'DescribeListener', 'handle', 'image-description', {
        yieldsTo: 'interactive-chat',
      });
      YieldGateRegistry.register('interactive-chat', () => false);

      const harness = makeHarness({ queues: ['image-description'] });

      harness.listen('image-description', 'preview.generated');
      harness.enqueue('image-description', 'preview.generated', [0]);
      harness.start('image-description');

      await jest.advanceTimersByTimeAsync(BACKOFF_WHEN_EMPTY_MS);

      expect(harness.executed).toEqual(['image-description-job-1']);
      expect(
        harness.logger.log.mock.calls.filter(([line]) => /standing aside|resumed/.test(String(line))),
      ).toEqual([]);
    });

    it('leaves a queue that names no gate exactly as it was — lane or not', async () => {
      YieldGateRegistry.register('interactive-chat', () => true);

      const harness = makeHarness({ queues: ['search-index'] });

      harness.listen('search-index', 'note.created');
      harness.enqueue('search-index', 'note.created', [0]);
      harness.start('search-index');

      await jest.advanceTimersByTimeAsync(1);

      expect(harness.executed).toEqual(['search-index-job-1']);
    });
  });
});
