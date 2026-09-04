import { Injectable } from '@nestjs/common';

import type { ConsumptionStore } from './ConsumptionStore';
import { checkSlidingWindow, type RateLimitDecision } from './slidingWindow';

/**
 * Hard cap on remembered keys, per map.
 *
 * An unbounded cache is a memory-exhaustion vector reachable by anyone who can
 * reach the endpoint — which for the peer surface is anyone on the internet
 * holding a valid token. When the cap is hit the OLDEST entries go.
 *
 * For windows that is merely generous (an evicted window resets to empty, which
 * grants the evicted caller a fresh allowance). For nonces it DEGRADES REPLAY
 * PROTECTION for the oldest requests, which is the honest trade a bounded cache
 * makes and the reason the Postgres backend is the default: it has no such cap.
 */
const MAX_KEYS = 10_000;

/**
 * In-memory {@link ConsumptionStore} — single-process dev and unit tests.
 *
 * ═══ WHAT THIS BACKEND CANNOT DO, STATED PLAINLY ═══
 *
 * It is per-process. Two replicas have two of these, so a limit of 10/min is
 * really 10/min PER REPLICA and a nonce claimed on one replica is unknown to
 * the other. That is precisely the defect G8 names, and this class does not fix
 * it — {@link PostgresConsumptionStore} does. This exists so the arithmetic can
 * be exercised without a database and so a single-process box does not pay for
 * a round trip it gains nothing from.
 *
 * ═══ ATOMICITY HERE IS THE EVENT LOOP, DELIBERATELY ═══
 *
 * Both methods are `async` to satisfy the interface but perform NO awaits
 * internally: they run to completion within one macrotask, so concurrent
 * callers cannot interleave mid-update. That is what lets this backend pass the
 * same concurrency suite as the Postgres one. Introducing an await between the
 * read and the write here would silently reintroduce the race — the contract
 * suite is what would catch it.
 */
@Injectable()
export class InMemoryConsumptionStore implements ConsumptionStore {
  private readonly windows = new Map<string, number[]>();

  /** key -> expiry epoch ms. Insertion-ordered, which makes eviction oldest-first. */
  private readonly nonces = new Map<string, number>();

  async takeWindow(params: {
    key: string;
    now: number;
    windowMs: number;
    max: number;
  }): Promise<RateLimitDecision> {
    const previous = this.windows.get(params.key) ?? [];
    const { kept, decision } = checkSlidingWindow(previous, params.now, params.windowMs, params.max);

    this.evictIfFull(this.windows);
    this.windows.set(params.key, kept);

    return decision;
  }

  async claimOnce(params: { key: string; now: number; expiresAtMs: number }): Promise<boolean> {
    this.pruneNonces(params.now);

    if (this.nonces.has(params.key)) {
      return false;
    }

    this.evictIfFull(this.nonces);
    this.nonces.set(params.key, params.expiresAtMs);

    return true;
  }

  private evictIfFull(map: Map<string, unknown>): void {
    if (map.size < MAX_KEYS) {
      return;
    }

    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }

  private pruneNonces(now: number): void {
    for (const [key, expiry] of this.nonces) {
      // Insertion order is not expiry order in general, but every nonce window
      // is bounded by the same constant, so stopping at the first live entry
      // keeps this amortized without a heap.
      if (expiry > now) {
        break;
      }

      this.nonces.delete(key);
    }
  }
}
