/**
 * The bound Hub assertions that have already minted a Memory session.
 *
 * Forward-auth headers ride on every request Traefik passes to Memory, and the same set is fine
 * to read any number of times. Turning one into a session is different: that is the step a copy
 * taken from elsewhere is for. So only `POST /authenticate/hub-bridge`, and only when it is about
 * to mint, spends the assertion here, and one that minted once cannot mint again. Nothing else
 * consults this, so ordinary traffic is never refused by it.
 *
 * A key is the assertion's nonce, fresh per forward-auth call, so two genuine requests never
 * share one, not even two in the same millisecond. The unbound format an older Hub sends has no
 * such key and is not spent; see `VerifiedHubForwardAuth.replayKey` for why.
 *
 * Kept until the assertion stops verifying anyway (`expiresAt`). In-memory and per-process, which
 * is right for the single-instance appliance (same reasoning as the connect nonce cache in
 * `ConnectRequestAuthGuard`); a restart forgets what was spent, bounded by the skew window.
 *
 * An expired key is treated as absent wherever it is read, so expired keys are only swept out when
 * the ledger is full, and only once one of them has expired: spending stays O(1) even while a
 * flood holds the ledger at its limit.
 */
export class SpentHubAssertions {
  private readonly spent = new Map<string, number>();

  /** No key in the ledger expires before this, so a sweep earlier than it would find nothing. */
  private earliestExpiry = Number.POSITIVE_INFINITY;

  /**
   * @param maxEntries how many live keys are remembered. Only verified header sets reach here,
   *   one per session minted, so a full ledger is not a state honest traffic gets near.
   */
  constructor(private readonly maxEntries = 10_000) {}

  /**
   * Record `key` as spent until `expiresAt`.
   *
   * - `spent`: it was not, and now is.
   * - `replayed`: it already was, and its header set still verifies.
   * - `full`: there is no room left to remember it. A key that cannot be remembered cannot be
   *   refused next time either, so it is not spent, and the caller must not mint from it.
   *
   * @param now when the header set was verified. Pass that instant rather than the time of the
   *   call: a replay that verified just before `expiresAt` and reaches here just after it would
   *   otherwise find its key already forgotten.
   */
  spend(key: string, expiresAt: number, now = Date.now()): 'spent' | 'replayed' | 'full' {
    const held = this.spent.get(key);
    // At `expiresAt` itself the header set still verifies (the skew check is inclusive).
    if (held !== undefined && held >= now) {
      return 'replayed';
    }

    if (held === undefined && this.spent.size >= this.maxEntries) {
      this.forgetExpired(now);
      if (this.spent.size >= this.maxEntries) {
        return 'full';
      }
    }

    this.spent.set(key, expiresAt);
    this.earliestExpiry = Math.min(this.earliestExpiry, expiresAt);

    return 'spent';
  }

  /** Drop keys whose header sets no longer verify. Strictly before: at `expiresAt` itself one still does. */
  private forgetExpired(now: number): void {
    if (this.earliestExpiry >= now) {
      return;
    }

    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, expiresAt] of this.spent) {
      if (expiresAt < now) {
        this.spent.delete(key);
      } else if (expiresAt < earliest) {
        earliest = expiresAt;
      }
    }

    this.earliestExpiry = earliest;
  }
}
