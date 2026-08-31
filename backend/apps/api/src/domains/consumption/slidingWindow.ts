/**
 * Pure sliding-window arithmetic, shared by every {@link ConsumptionStore}
 * backend. Keeping it pure makes the abuse control unit-testable without timers
 * or a container.
 *
 * ═══ WHY THIS LIVES IN `consumption` AND NOT IN `asks` ═══
 *
 * It began in `domains/asks/rateLimit.ts`, which was right while `asks` owned
 * the only limiter. Once the stores needed it too, that direction inverted:
 * `asks` depends on `consumption` for the store, so `consumption` importing
 * back into `asks` for the arithmetic was a genuine import CYCLE — and it did
 * not fail at build time. It failed at module-evaluation time, as
 * `ReferenceError: Cannot access 'InMemoryConsumptionStore' before
 * initialization`, from a spec that had nothing to do with either.
 *
 * The rule the move encodes: the low-level domain owns the primitive, and the
 * domains that consume it depend downward. Both backends now share ONE
 * definition of what a window means, which is also what lets the contract suite
 * hold them to the same behaviour.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the next attempt would be allowed (0 when allowed). */
  retryAfterMs: number;
  /** Remaining allowance in the current window after this attempt. */
  remaining: number;
}

/**
 * Given the timestamps (ms) of prior attempts in ascending order, decide whether
 * a new attempt at `now` is allowed under a `max`-per-`windowMs` sliding window.
 * Returns the timestamps to retain (expired ones dropped; the new one appended
 * only when allowed) alongside the decision.
 */
export function checkSlidingWindow(
  timestamps: readonly number[],
  now: number,
  windowMs: number,
  max: number,
): { kept: number[]; decision: RateLimitDecision } {
  const cutoff = now - windowMs;
  const kept = timestamps.filter((t) => t > cutoff);

  if (kept.length >= max) {
    const oldest = kept[0];
    const retryAfterMs = Math.max(0, oldest + windowMs - now);

    return { kept, decision: { allowed: false, retryAfterMs, remaining: 0 } };
  }

  kept.push(now);

  return { kept, decision: { allowed: true, retryAfterMs: 0, remaining: max - kept.length } };
}
