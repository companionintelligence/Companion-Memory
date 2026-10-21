import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { CONSUMPTION_STORE, type ConsumptionStore } from '@ci/domains/consumption';

/** Default: at most 20 asks per asker per rolling minute. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

/**
 * Cumulative per-(owner, asker) rolling 24h disclosure ceiling so a slow-rate
 * automated caller cannot extract an owner's corpus by staying just under the
 * 20/min burst window all day.
 */
export const DISCLOSURE_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAX_DISCLOSURES_PER_DAY = 100;

/**
 * Per-asker sliding-window rate limit on the ask path — a first abuse control so
 * a single asker cannot flood a responder's review inbox.
 *
 * The window now lives in {@link ConsumptionStore} rather than in a process-local
 * `Map`. That was G8: N api processes meant N times the effective limit, and a
 * restart reset every window. The arithmetic is unchanged — `checkSlidingWindow`
 * still decides — only where the state is kept.
 */
@Injectable()
export class AskRateLimitService {
  constructor(
    @Inject(CONSUMPTION_STORE)
    private readonly store: ConsumptionStore,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskRateLimitService.name);
  }

  /**
   * Records an attempt for `userId` and throws HTTP 429 if the sliding-window
   * limit is exceeded. `now` is injectable for testing.
   *
   * ASYNC now that the window is durable. Every caller must await it — a
   * floating promise here would let the request proceed while the limit was
   * still being decided, which is the limiter not existing.
   */
  async consume(userId: string, now: number = Date.now()): Promise<void> {
    const decision = await this.store.takeWindow({
      key: `ask:${userId}`,
      now,
      windowMs: WINDOW_MS,
      max: MAX_PER_WINDOW,
    });

    if (!decision.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many asks — please wait before sending another.',
          retryAfterMs: decision.retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Enforces a cumulative rolling 24-hour disclosure ceiling per `(ownerUserId, askerUserId)`
   * pair in the durable {@link ConsumptionStore}.
   */
  async consumeDisclosureBudget(
    ownerUserId: string,
    askerUserId: string,
    options: { now?: number; maxPerDay?: number; windowMs?: number } = {},
  ): Promise<void> {
    const now = options.now ?? Date.now();
    const windowMs = options.windowMs ?? DISCLOSURE_WINDOW_MS;
    const max = options.maxPerDay ?? MAX_DISCLOSURES_PER_DAY;

    const decision = await this.store.takeWindow({
      key: `ask-disclosure:${ownerUserId}:${askerUserId}`,
      now,
      windowMs,
      max,
    });

    if (!decision.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'DISCLOSURE_BUDGET_EXCEEDED',
          message: 'Daily disclosure budget exceeded for this recipient.',
          retryAfterMs: decision.retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
