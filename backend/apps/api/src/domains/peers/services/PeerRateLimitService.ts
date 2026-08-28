import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { checkSlidingWindow } from '@ci/domains/asks';

/**
 * Inbound peer asks are limited more tightly than local ones: a remote box is
 * a lower-trust caller, and the review inbox it can fill belongs to a human.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

/**
 * Polls get their own, larger budget.
 *
 * Sharing the ask budget would make the return path unusable: a peer that asked
 * seven questions would have three collections left before its own answers
 * became unreachable, and an asker cannot know when to stop polling because the
 * whole point of {@link PEER_ASK_PENDING} is that it cannot tell "queued" from
 * "refused". Sharing it would also let a poll — which decides nothing — consume
 * the budget that exists to protect a HUMAN's review inbox.
 *
 * Separate does not mean free. A poll is a read of an already-made disclosure:
 * it evaluates no grant, runs no executor, creates no ask and writes no audit
 * row, so its cost is one indexed lookup and its only reward is a row the peer
 * has already been sent. Thirty a minute is generous for collecting and useless
 * for probing.
 */
const MAX_POLLS_PER_WINDOW = 30;

/**
 * Sliding-window rate limit for INBOUND peer asks, keyed on the peer's OIDC
 * identity rather than a local user id.
 *
 * Keying on `(issuer, subject)` is deliberate: it is the only identifier that is
 * verified before any peer-link lookup happens, so the limit applies even to
 * callers that turn out to be unlinked. Keying on the peer link instead would
 * leave the cheapest attack — hammering the endpoint as an unknown peer —
 * completely unlimited.
 *
 * In-memory per process, matching the local limiter; a shared store can back
 * both when the ask path goes multi-instance.
 */
@Injectable()
export class PeerRateLimitService {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(PeerRateLimitService.name);
  }

  /** Throws HTTP 429 when the peer identity exceeds its window. */
  consume(identity: { issuer: string; subject: string }, now: number = Date.now()): void {
    this.take('ask', identity, MAX_PER_WINDOW, now);
  }

  /**
   * The budget for COLLECTING an answer, kept apart from the budget for asking
   * for one. See {@link MAX_POLLS_PER_WINDOW}.
   */
  consumePoll(identity: { issuer: string; subject: string }, now: number = Date.now()): void {
    this.take('poll', identity, MAX_POLLS_PER_WINDOW, now);
  }

  private take(
    bucket: 'ask' | 'poll',
    identity: { issuer: string; subject: string },
    max: number,
    now: number,
  ): void {
    const key = `${bucket}\u0000${identity.issuer}\u0000${identity.subject}`;
    const previous = this.windows.get(key) ?? [];
    const { kept, decision } = checkSlidingWindow(previous, now, WINDOW_MS, max);
    this.windows.set(key, kept);

    if (!decision.allowed) {
      this.logger.warn(`peer ask rate limit hit for ${identity.issuer}`);

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          // One message for both buckets: which limit was hit is a fact about
          // this box's configuration, and naming it would tell a caller how to
          // pace a probe.
          message: 'Too many asks',
          retryAfterMs: decision.retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
