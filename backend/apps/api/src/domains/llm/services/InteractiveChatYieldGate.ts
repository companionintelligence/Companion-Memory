import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ThreadService } from '@ci/domains/conversations';
import { YieldGateRegistry } from '@ci/domains/events';

import { INTERACTIVE_CHAT_YIELD_GATE, LLM_QUEUE_OPTIONS } from '../constants';

/**
 * A pending `running`/`queued` status older than this is treated as stale and
 * ignored. Tied to the `llm` queue's own expiry: that is the longest a chat
 * job may legitimately stay active before pg-boss retries it — and a retry
 * rewrites the status, refreshing `updated_at`. A row nobody refreshed within
 * that window belongs to a turn that died with its process.
 */
export const PENDING_GENERATION_FRESHNESS_MS = (LLM_QUEUE_OPTIONS.expireInSeconds ?? 900) * 1000;

/**
 * How long one answer is reused before the table is asked again. The worker
 * loops re-ask every second while yielding, and every job start otherwise;
 * this keeps that to one indexed count per second across all yielding
 * queues, not one per queue per wake-up.
 */
export const YIELD_GATE_CACHE_MS = 1_000;

/**
 * Answers "is a person waiting on the chat model right now?" for the queue
 * worker loops — see `yieldGates.ts` in the events domain for the mechanism
 * and `IMAGE_DESCRIPTION_QUEUE_OPTIONS` for the first queue that asks.
 *
 * The signal is `ci.threads.generation_status`, which the chat path already
 * maintains (`queued` at enqueue, `running`/`idle` around the turn), read
 * through {@link ThreadService.countPendingGenerations}. The HBPE sidecar's
 * labeler reads the same column directly, so the two yield on one truth.
 *
 * Fails OPEN: a database error here means background work carries on as it
 * did before this gate existed, never that a queue freezes.
 */
@Injectable()
export class InteractiveChatYieldGate {
  private cached: { pending: boolean; expiresAt: number } | null = null;

  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly threadService: ThreadService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(InteractiveChatYieldGate.name);
    // Registered at CONSTRUCTION, not in onModuleInit: Nest instantiates every
    // provider before it runs any module's init hooks, and the queue worker
    // loops start from PGBossEventService.onModuleInit. Registering there too
    // lost the race on a real boot — the loops' first check found no gate and
    // logged the "no such gate is registered" warning for a gate that arrived
    // 300 ms later.
    YieldGateRegistry.register(INTERACTIVE_CHAT_YIELD_GATE, () => this.isChatPending());
  }

  async isChatPending(): Promise<boolean> {
    const now = Date.now();

    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.pending;
    }

    // Several worker loops wake within the same millisecond; one query serves
    // them all rather than one each.
    if (this.inFlight == null) {
      this.inFlight = this.lookup().finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  private async lookup(): Promise<boolean> {
    let pending = false;

    try {
      pending = (await this.threadService.countPendingGenerations(PENDING_GENERATION_FRESHNESS_MS)) > 0;
    } catch (error) {
      this.logger.warn('Could not read pending chat turns; background queues will not yield this tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.cached = { pending, expiresAt: Date.now() + YIELD_GATE_CACHE_MS };

    return pending;
  }
}
