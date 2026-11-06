/**
 * Replay protection for authenticated messages.
 *
 * DIDComm authenticates a message to its recipient but does not make it single-use. An authcrypt
 * envelope captured on the wire, or a message a mediator delivers twice, unpacks again to the same
 * valid plaintext. `expires_time` bounds how long that can go on only if the sender set one.
 *
 * {@link InMemoryReplayGuard} remembers (sender, message id) pairs for a bounded time. It is
 * process-local: a restart forgets, and two replicas each keep their own memory, so a deployment
 * with more than one process, or one that must survive a restart, supplies a shared store behind
 * the same interface. It protects the message layer. It is not a substitute for a protocol's own
 * idempotency, which must key on the application's identifier, not on the DIDComm message id (a
 * mediator redelivery of one document can arrive under a fresh id).
 */
export interface ReplayGuard {
  /**
   * Records `key` and returns `true` the first time it is seen, `false` for a repeat.
   * `notAfter` (epoch seconds) is when the entry may be forgotten.
   */
  firstSighting(key: string, notAfter: number, now: number): boolean;
}

export class InMemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
  }

  firstSighting(key: string, notAfter: number, now: number): boolean {
    this.prune(now);

    if (this.seen.has(key)) {
      return false;
    }

    this.seen.set(key, notAfter);

    // Past the cap the oldest entries go first. That shortens the window under flood rather than
    // letting memory grow without bound; the alternative, refusing new messages, would hand an
    // attacker a way to lock a recipient out.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();

      if (oldest.done) {
        break;
      }

      this.seen.delete(oldest.value);
    }

    return true;
  }

  size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [key, notAfter] of this.seen) {
      // Entries are inserted in time order only roughly (notAfter varies), so scan until the first
      // one that is still live and stop; stragglers are caught on a later call or by the cap.
      if (notAfter >= now) {
        break;
      }

      this.seen.delete(key);
    }
  }
}
