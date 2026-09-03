import { JobSlotPool } from '../jobSlotPool';

/**
 * The global budget, held as a claim.
 *
 * Two properties have to hold or this is worse than the counter-read it
 * replaced:
 *
 *  1. **No two callers can be granted the same slot.** That is the whole point:
 *     ~38 worker loops reach the same line in one synchronous pass, and reading
 *     a limiter's counters let every one of them fetch against the same free
 *     budget. `reserve` therefore has to mutate in the turn it reads.
 *  2. **Every granted slot comes back.** A leaked reservation is permanent: the
 *     pool shrinks by one for the life of the process, and enough of them stop
 *     the appliance fetching any work at all — silently, because nothing throws
 *     and the queues simply look idle.
 */
describe('JobSlotPool', () => {
  it('grants slots up to the ceiling and nothing beyond it', () => {
    const pool = new JobSlotPool(() => 10);

    expect(pool.reserve(4)).toBe(4);
    expect(pool.reserve(4)).toBe(4);
    // Asked for four with two left: a partial grant, not a refusal and not an
    // over-grant. The caller fetches what it was given.
    expect(pool.reserve(4)).toBe(2);
    expect(pool.reserve(4)).toBe(0);
    expect(pool.reservedCount).toBe(10);
  });

  it('takes the slots synchronously, so a second caller cannot see them as free', () => {
    const pool = new JobSlotPool(() => 6);
    const grants: number[] = [];

    // Five callers in one turn, exactly as the worker loops arrive: no await
    // between them, which is the case a counter-read could not survive.
    for (let caller = 0; caller < 5; caller += 1) {
      grants.push(pool.reserve(2));
    }

    expect(grants).toEqual([2, 2, 2, 0, 0]);
    expect(grants.reduce((total, grant) => total + grant, 0)).toBe(6);
  });

  it('hands released slots back to the next caller', () => {
    const pool = new JobSlotPool(() => 3);

    expect(pool.reserve(3)).toBe(3);
    expect(pool.available()).toBe(0);

    pool.release();
    pool.release(2);

    expect(pool.reservedCount).toBe(0);
    expect(pool.reserve(3)).toBe(3);
  });

  it('ignores a release of nothing rather than inventing a slot', () => {
    const pool = new JobSlotPool(() => 2);

    pool.reserve(1);
    pool.release(0);
    pool.release(-5);

    expect(pool.reservedCount).toBe(1);
  });

  it('never reports more capacity than the ceiling, however often slots are returned', () => {
    // Defence against a double release — a second `finally` on the same job, say.
    // The floor at zero is what keeps that from minting slots the semaphore will
    // not honour, which would put the fetch back above the run ceiling.
    const pool = new JobSlotPool(() => 4);

    pool.reserve(1);
    pool.release(9);

    expect(pool.reservedCount).toBe(0);
    expect(pool.available()).toBe(4);
  });

  it('follows the ceiling when it moves at runtime', () => {
    // The pool reads the live semaphore, so an operator lowering the cap from the
    // Jobs page must stop new fetches immediately while leaving the jobs already
    // leased to finish — not be applied at the next restart.
    let ceiling = 8;
    const pool = new JobSlotPool(() => ceiling);

    expect(pool.reserve(6)).toBe(6);

    ceiling = 4;

    expect(pool.available()).toBe(0);
    expect(pool.reserve(1)).toBe(0);

    pool.release(3);

    expect(pool.reserve(1)).toBe(1);
  });

  describe('waitForSlot', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns immediately when a slot is already free', async () => {
      const pool = new JobSlotPool(() => 1);
      let resolved = false;

      const waiting = pool.waitForSlot(5000).then(() => {
        resolved = true;
      });

      await Promise.resolve();

      // No timer involved: a loop that slept its backoff out while capacity was
      // sitting free would give up a poll interval for nothing.
      expect(resolved).toBe(true);
      await waiting;
    });

    it('wakes on a release rather than waiting out the backoff', async () => {
      const pool = new JobSlotPool(() => 1);

      pool.reserve(1);

      let resolved = false;
      const waiting = pool.waitForSlot(5000).then(() => {
        resolved = true;
      });

      await jest.advanceTimersByTimeAsync(10);
      expect(resolved).toBe(false);

      pool.release();
      await jest.advanceTimersByTimeAsync(0);

      // The release, not the 5000ms timeout, is what woke it. Waiting out the
      // backoff after every completed job is most of the wall clock on short
      // jobs, which is how a fetch bound turns into a throughput regression.
      expect(resolved).toBe(true);
      await waiting;
    });

    it('gives up after the timeout, so a caller can re-check what a release cannot signal', async () => {
      // A slot can also come free by the ceiling being RAISED, and a worker
      // stopping has to reach its own `while (running)` check. Neither emits a
      // release, so the wait cannot be indefinite.
      const pool = new JobSlotPool(() => 1);

      pool.reserve(1);

      let resolved = false;
      const waiting = pool.waitForSlot(150).then(() => {
        resolved = true;
      });

      await jest.advanceTimersByTimeAsync(149);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await waiting;
    });

    it('wakes every waiter, so one release does not pick a favourite queue', async () => {
      const pool = new JobSlotPool(() => 2);

      pool.reserve(2);

      const woken: number[] = [];
      const waits = [0, 1, 2].map((id) => pool.waitForSlot(5000).then(() => woken.push(id)));

      await jest.advanceTimersByTimeAsync(10);
      expect(woken).toEqual([]);

      pool.release();
      await jest.advanceTimersByTimeAsync(0);

      // All three re-check and race for the one slot; the losers simply wait
      // again. Waking only one would make the slot the property of whichever
      // loop happened to be queued first.
      expect(woken).toEqual([0, 1, 2]);
      await Promise.all(waits);
    });

    it('drops timed-out waiters instead of accumulating them forever', async () => {
      // The leak case is a listener that hangs: its reservation is never
      // released, so nothing ever flushes the waiter list, while ~38 loops keep
      // parking on it every backoff. Each timed-out wait has to remove itself.
      const pool = new JobSlotPool(() => 1);

      pool.reserve(1);

      for (let poll = 0; poll < 50; poll += 1) {
        const parked = pool.waitForSlot(150);

        await jest.advanceTimersByTimeAsync(150);
        await parked;
      }

      const waiters = (pool as unknown as { waiters: Set<() => void> }).waiters;

      expect(waiters.size).toBe(0);
    });
  });
});
