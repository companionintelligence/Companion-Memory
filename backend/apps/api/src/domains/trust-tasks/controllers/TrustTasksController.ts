import { Controller, NotFoundException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import type { RawBodyRequest } from '@ci/common/middleware/BodyParserMiddleware';

import { TrustTasksService } from '../TrustTasksService';

/** The ONE refusal an authentication failure ever produces; the same words `PeerAskController` uses. */
const REFUSED = 'Invalid token';

/**
 * `POST /agent/v1/trust-tasks` — the Trust Tasks HTTPS binding (registry binding `https/0.3`, §2),
 * served next to the peer-ask surface under the same `/agent/v1` base.
 *
 * Per that binding the Trust-Task base is the advertised endpoint and `/trust-tasks` is appended to it;
 * for this box the base is `peers.memoryEndpoint` (`…/agent/v1`).
 *
 * ═══ WHAT THIS BINDING DOES NOT PROVIDE, AND WHAT THAT MEANS ═══
 *
 * The HTTPS binding's security profile (§5) says plainly that it gives no producer-to-consumer
 * end-to-end guarantee: TLS ends at the first terminator, a bearer token authenticates whoever holds
 * it, and a re-originating intermediary is undetectable. So this route does not rely on the channel at
 * all. There is NO bearer token and no transport-derived identity here; the sender is established only
 * by the Data Integrity proof inside the document, and the Asks specifications declare that proof
 * REQUIRED. `Authorization` is ignored.
 *
 * ═══ DARK BY DEFAULT, AND ONE REFUSAL FOR EVERYTHING ELSE ═══
 *
 * Off unless the `trust.tasks` feature is on (and `ask`, which owns the pipeline behind it) and this
 * box holds a signing key: the route then answers `404` with the words Nest uses for a route that does
 * not exist, so a box that has the feature turned off cannot be told from one that does not have it.
 * (`PeerAskController` answers `503` when its feature is off; that route has existed for longer and is
 * a known, advertised endpoint of every box. This one is new, so it does not announce itself.)
 *
 * Once on, every failure to establish and admit the sender AFTER the body has parsed — a bad proof, an
 * AID the owner never linked, a key that differs from the link's, a stale or misaddressed document — is
 * the identical `401`. Which check failed is a fact about this box's configuration and its owner's
 * links; the reason goes to the log. A body that is not JSON, or is larger than the shared body parser
 * allows, is turned away by that parser with its usual `400`/`413` before this controller runs, on this
 * route exactly as on every other.
 */
@Controller('agent/v1')
export class TrustTasksController {
  constructor(
    private readonly service: TrustTasksService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TrustTasksController.name);
  }

  @Post('trust-tasks')
  async receive(
    @Req() request: RawBodyRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    if (
      !(await this.featureService.isFeatureEnabled('trust.tasks')) ||
      !(await this.featureService.isFeatureEnabled('ask')) ||
      !this.service.ready
    ) {
      // Nest's own not-found handler words it `Cannot <method> <originalUrl>`, query string included.
      throw new NotFoundException(
        `Cannot POST ${request.originalUrl ?? request.url ?? '/agent/v1/trust-tasks'}`,
      );
    }

    // The proof is verified over the object AS RECEIVED, so the exact bytes are parsed here and nothing
    // between this line and the verifier gets a chance to normalize them.
    const bytes = request.rawBody == null ? 0 : Buffer.byteLength(request.rawBody, 'utf8');
    const received = parseBody(request.rawBody, bytes, this.service.maxBodyBytes);
    if (received === undefined) {
      this.logger.warn('trust task refused: the body is absent, oversized or not JSON');
      throw new UnauthorizedException(REFUSED);
    }

    const reply = await this.service.handle(received, {}, { bytes });
    if (reply.kind === 'refused') {
      throw new UnauthorizedException(REFUSED);
    }

    // An identical document arriving again: accepted once already, so nothing is executed and nothing is
    // handed back (HTTPS binding §4, "duplicate of a completed execution… no response retained").
    if (reply.kind === 'absorbed') {
      response.status(204);

      return undefined;
    }

    response.status(reply.status);

    return reply.document;
  }
}

/** The parsed body, or undefined for anything that is not a bounded JSON text. */
function parseBody(raw: string | undefined, bytes: number, limit: number): unknown {
  if (raw == null || raw.length === 0 || bytes > limit) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
