/**
 * The global job budget, as a claim rather than a reading.
 *
 * The worker runs one un-awaited `work()` loop per queue — ~38 of them in a
 * single-process appliance — and each loop decides how many rows to fetch. When
 * that decision was a READ of the global limiter's counters, every loop could
 * read the same untouched budget before any of them had dispatched anything:
 * `onModuleInit` starts them in one synchronous pass, and each runs as far as
 * its first `await boss.fetch(...)` without yielding. Thirty-eight loops each
 * saw ten free slots and fetched against them.
 *
 * The rows that produced were not merely counted twice. `fetch` takes the
 * pg-boss LEASE: every one of them went to state `active` — on its expiration
 * clock, and counted by the Jobs console's "Running" tile — while it sat in a
 * semaphore waiting for a slot the appliance would not have for minutes. A
 * queue with a short `expireInSeconds` could have work expire and be retried
 * having never run.
 *
 * A reservation closes that window because it is taken SYNCHRONOUSLY, before
 * the fetch: there is no point at which two loops can both see the same slot as
 * free. The slot is held for the whole life of the row this process took — from
 * before the fetch until the job reaches a terminal outcome — so what the pool
 * bounds is exactly "rows we hold a lease on", which is the number that was
 * wrong.
 *
 * This does not replace the execution semaphore. The pool bounds what is
 * FETCHED; `p-limit` still bounds what RUNS, honours a concurrency change made
 * while jobs are in flight, and orders the waiting. The pool reads its ceiling
 * from that same limiter (see the `limit` callback) so an operator lowering the
 * cap from the Jobs page tightens both in the same breath.
 */
export class JobSlotPool {
  private reserved = 0;

  /**
   * Loops parked in {@link waitForSlot}. A `Set` rather than an array because a
   * waiter that times out has to remove itself: a listener that hangs forever
   * holds its reservation forever, and every loop would otherwise leave a dead
   * entry behind on each poll — an unbounded leak on the one path where nothing
   * is draining to flush it.
   */
  private readonly waiters = new Set<() => void>();

  /**
   * @param limit the current ceiling, read on every call rather than captured,
   *   so a runtime concurrency change applies to the next reservation instead of
   *   to the next process restart.
   */
  constructor(private readonly limit: () => number) {}

  /** Slots held by rows this process has fetched and not yet finished. */
  get reservedCount(): number {
    return this.reserved;
  }

  /** How many rows may be fetched right now. */
  available(): number {
    return Math.max(this.limit() - this.reserved, 0);
  }

  /**
   * Claim up to `count` slots, returning how many were actually granted — which
   * is what the caller may then fetch, and what it must release.
   *
   * Synchronous and total: the mutation happens in the same turn as the read, so
   * a second loop entering between them is not possible. Granting less than
   * asked (including zero) is the normal case under contention, not an error.
   */
  reserve(count: number): number {
    const granted = Math.min(Math.max(count, 0), this.available());

    this.reserved += granted;

    return granted;
  }

  /**
   * Hand slots back and wake whoever is waiting for one.
   *
   * Called for every reserved slot exactly once: for rows the fetch did not
   * return (or that it threw instead of returning) immediately, and for rows it
   * did return when the job reaches its terminal outcome.
   */
  release(count = 1): void {
    if (count <= 0) {
      return;
    }

    this.reserved = Math.max(this.reserved - count, 0);

    // Snapshot and clear first: each waiter removes itself as it resolves, and
    // mutating the set under its own iteration is how that turns into a missed
    // wake-up.
    const waiting = [...this.waiters];

    this.waiters.clear();

    for (const wake of waiting) {
      wake();
    }
  }

  /**
   * Park until a slot frees, or `timeoutMs` elapses.
   *
   * The timeout is the safety net, not the mechanism. Waking on the release
   * itself is what keeps the reservation from costing throughput: without it a
   * queue would sit out the rest of its backoff after every completion, which on
   * short jobs is most of the wall clock. The timeout still matters — a slot can
   * come free by a concurrency RAISE rather than a release, and shutdown has to
   * be able to reach the loop's `while (this.running)` check.
   */
  async waitForSlot(timeoutMs: number): Promise<void> {
    if (this.available() > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };

      // Referenced from `wake` above, which cannot run before this line: the
      // timer has not been armed and the waiter is not registered yet.
      const timer = setTimeout(wake, timeoutMs);

      this.waiters.add(wake);
    });
  }
}
