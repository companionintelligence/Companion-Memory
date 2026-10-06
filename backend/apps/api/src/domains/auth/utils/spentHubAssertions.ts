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
 */
export class SpentHubAssertions {
  private readonly spent = new Map<string, number>();

  /**
   * @param maxEntries how many live keys are remembered. Only verified header sets reach here,
   *   one per session minted, so a full ledger is not a state honest traffic gets near.
   */
  constructor(private readonly maxEntries = 10_000) {}

  /**
   * Record `key` as spent until `expiresAt`. False when it already was, or when there is no room
   * left to remember it: a key that cannot be remembered cannot be refused next time either.
   */
  spend(key: string, expiresAt: number, now = Date.now()): boolean {
    this.forgetExpired(now);

    if (this.spent.has(key) || this.spent.size >= this.maxEntries) {
      return false;
    }

    this.spent.set(key, expiresAt);

    return true;
  }

  /** Drop keys whose header sets no longer verify. Strictly before: at `expiresAt` itself one still does. */
  private forgetExpired(now: number): void {
    for (const [key, expiresAt] of this.spent) {
      if (expiresAt < now) {
        this.spent.delete(key);
      }
    }
  }
}
