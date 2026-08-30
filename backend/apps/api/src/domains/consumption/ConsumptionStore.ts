import type { RateLimitDecision } from './slidingWindow';

/**
 * Durable, indivisible consumption counters — the store behind every abuse
 * control on the ask path (G8).
 *
 * ═══ WHY AN INTERFACE AND NOT JUST A TABLE ═══
 *
 * Three controls were in-process `Map`s: two rate limiters and the replay-nonce
 * cache. Replacing them with direct SQL would have made every one of them
 * untestable without a database, which is how they came to be `Map`s in the
 * first place — the pure arithmetic was easy to test and the storage was not,
 * so the storage was skipped.
 *
 * Two implementations behind one interface keeps both properties: the in-memory
 * backend runs in unit tests and single-process dev, the Postgres one runs
 * anywhere with more than one replica, and {@link CONSUMPTION_STORE_CONTRACT}
 * is a single suite that both must pass. That shared suite is the actual
 * deliverable here — an interface with one tested implementation would just be
 * the `Map` with more ceremony.
 *
 * ═══ INDIVISIBLE, NOT MERELY ONCE ═══
 *
 * Both operations are read-modify-write races when concurrent, and both MUST
 * behave as if serialized per key. UMA's finding #7 states the requirement for
 * single-use artifacts, and the nonce cache is the case where getting it wrong
 * is not a quantitative slip: a per-process cache lets a replay succeed once
 * per replica, so scaling out weakens the defence.
 *
 * Implementations are therefore required to make each method atomic PER KEY.
 * They are not required to be atomic ACROSS keys, and no caller needs that.
 */
export interface ConsumptionStore {
  /**
   * Take one slot from a sliding window, returning whether it was granted.
   *
   * The arithmetic is `checkSlidingWindow`, shared by both backends rather than
   * reimplemented — so the two cannot disagree about what a window means, only
   * about how the state is held. That is exactly the axis the contract suite
   * can check and the axis a reimplementation would quietly drift on.
   */
  takeWindow(params: { key: string; now: number; windowMs: number; max: number }): Promise<RateLimitDecision>;

  /**
   * Claim a single-use token, returning true for exactly ONE caller.
   *
   * Every subsequent claim of the same key returns false until `expiresAtMs`
   * passes, after which the key may be claimed again — which is correct for a
   * replay nonce, whose signature window has by then closed anyway.
   *
   * A store that cannot reach its backing state MUST return false. That is the
   * fail-closed direction for a replay defence: refusing an honest request is
   * recoverable, admitting a replayed one is not.
   */
  claimOnce(params: { key: string; now: number; expiresAtMs: number }): Promise<boolean>;
}

/** DI token. Nest cannot inject an interface. */
export const CONSUMPTION_STORE = Symbol('CONSUMPTION_STORE');
