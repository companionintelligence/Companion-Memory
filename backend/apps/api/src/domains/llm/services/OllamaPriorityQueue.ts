export type OllamaPriority = 'interactive' | 'user_job' | 'background';

const PRIORITY_ORDER: readonly OllamaPriority[] = ['interactive', 'user_job', 'background'];

interface QueuedWaiter {
  priority: OllamaPriority;
  enqueuedAt: number;
  signal?: AbortSignal;
  grant: (waitMs: number) => void;
  abort: (reason: unknown) => void;
  cleanupAbort?: () => void;
}

export interface PriorityBucketTelemetry {
  inFlight: number;
  queued: number;
  completed: number;
  abortedWhileQueued: number;
  totalWaitMs: number;
  avgWaitMs: number;
}

export interface OllamaQueueSnapshot {
  maxConcurrent: number;
  totalInFlight: number;
  totalQueued: number;
  byPriority: Record<OllamaPriority, PriorityBucketTelemetry>;
}

export interface OllamaPriorityQueueOptions {
  /** Maximum concurrent LLM generations across all priorities (default: 2). */
  maxConcurrent?: number;
  /**
   * When true (default), `background` (P2) tasks will not start while any
   * `interactive` (P0) task is in flight or queued, preventing background
   * crons from starving or delaying live user chat turns on a single-GPU box.
   */
  pauseBackgroundDuringInteractive?: boolean;
  now?: () => number;
}

/**
 * 3-tier priority semaphore and backpressure scheduler for local LLM inference.
 *
 * Tiers:
 *   - `interactive` (P0): live user chat turns, recall synthesis, interactive asks
 *   - `user_job`    (P1): user-initiated imports or manual on-demand actions
 *   - `background`  (P2): periodic crons (compaction, concept extraction, enrichment)
 */
export class OllamaPriorityQueue {
  private readonly maxConcurrent: number;

  private readonly pauseBackgroundDuringInteractive: boolean;

  private readonly now: () => number;

  private readonly queues: Record<OllamaPriority, QueuedWaiter[]> = {
    interactive: [],
    user_job: [],
    background: [],
  };

  private readonly inFlight: Record<OllamaPriority, number> = {
    interactive: 0,
    user_job: 0,
    background: 0,
  };

  private readonly completed: Record<OllamaPriority, number> = {
    interactive: 0,
    user_job: 0,
    background: 0,
  };

  private readonly abortedWhileQueued: Record<OllamaPriority, number> = {
    interactive: 0,
    user_job: 0,
    background: 0,
  };

  private readonly totalWaitMs: Record<OllamaPriority, number> = {
    interactive: 0,
    user_job: 0,
    background: 0,
  };

  constructor(options: OllamaPriorityQueueOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.pauseBackgroundDuringInteractive = options.pauseBackgroundDuringInteractive ?? true;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `task` under the priority semaphore. If `signal` aborts while the caller
   * is waiting in the queue, the waiter is evicted immediately and rejects
   * without ever acquiring a slot on the inference backend.
   */
  async run<T>(priority: OllamaPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(priority, signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Acquire a slot for `priority`, returning an idempotent `release()` callback.
   * Useful for streaming generators whose lifetime spans `for await (...)`.
   */
  async acquire(priority: OllamaPriority, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();

    if (this.canDispatchImmediately(priority)) {
      this.inFlight[priority] += 1;

      return this.createReleaser(priority);
    }

    const enqueuedAt = this.now();

    await new Promise<number>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        priority,
        enqueuedAt,
        signal,
        grant: (waitMs: number) => {
          waiter.cleanupAbort?.();
          resolve(waitMs);
        },
        abort: (reason: unknown) => {
          waiter.cleanupAbort?.();
          reject(reason);
        },
      };

      if (signal) {
        const onAbort = () => {
          const bucket = this.queues[priority];
          const idx = bucket.indexOf(waiter);
          if (idx !== -1) {
            bucket.splice(idx, 1);
            this.abortedWhileQueued[priority] += 1;
          }

          waiter.abort(signal.reason ?? new Error('Aborted'));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.queues[priority].push(waiter);
    });

    return this.createReleaser(priority);
  }

  getSnapshot(): OllamaQueueSnapshot {
    const byPriority = {} as Record<OllamaPriority, PriorityBucketTelemetry>;

    for (const p of PRIORITY_ORDER) {
      const completedCount = this.completed[p];
      const waitSum = this.totalWaitMs[p];
      byPriority[p] = {
        inFlight: this.inFlight[p],
        queued: this.queues[p].length,
        completed: completedCount,
        abortedWhileQueued: this.abortedWhileQueued[p],
        totalWaitMs: waitSum,
        avgWaitMs: completedCount > 0 ? Math.round(waitSum / completedCount) : 0,
      };
    }

    return {
      maxConcurrent: this.maxConcurrent,
      totalInFlight: this.totalInFlightCount(),
      totalQueued:
        this.queues.interactive.length + this.queues.user_job.length + this.queues.background.length,
      byPriority,
    };
  }

  private totalInFlightCount(): number {
    return this.inFlight.interactive + this.inFlight.user_job + this.inFlight.background;
  }

  private canDispatchImmediately(priority: OllamaPriority): boolean {
    if (this.totalInFlightCount() >= this.maxConcurrent) {
      return false;
    }

    // Never jump ahead of higher-or-equal priority waiters already queued.
    for (const tier of PRIORITY_ORDER) {
      if (this.queues[tier].length > 0) {
        return false;
      }

      if (tier === priority) {
        break;
      }
    }

    if (
      priority === 'background' &&
      this.pauseBackgroundDuringInteractive &&
      (this.inFlight.interactive > 0 || this.queues.interactive.length > 0)
    ) {
      return false;
    }

    return true;
  }

  private createReleaser(priority: OllamaPriority): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.inFlight[priority] = Math.max(0, this.inFlight[priority] - 1);
      this.completed[priority] += 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.totalInFlightCount() < this.maxConcurrent) {
      const next = this.pickNextWaiter();
      if (!next) {
        break;
      }

      const waitMs = Math.max(0, this.now() - next.enqueuedAt);
      this.totalWaitMs[next.priority] += waitMs;
      this.inFlight[next.priority] += 1;
      next.grant(waitMs);
    }
  }

  private pickNextWaiter(): QueuedWaiter | undefined {
    for (const tier of PRIORITY_ORDER) {
      if (
        tier === 'background' &&
        this.pauseBackgroundDuringInteractive &&
        (this.inFlight.interactive > 0 || this.queues.interactive.length > 0)
      ) {
        continue;
      }

      const bucket = this.queues[tier];
      while (bucket.length > 0) {
        const candidate = bucket.shift()!;
        if (candidate.signal?.aborted) {
          this.abortedWhileQueued[tier] += 1;
          candidate.abort(candidate.signal.reason ?? new Error('Aborted'));
          continue;
        }

        return candidate;
      }
    }

    return undefined;
  }
}
