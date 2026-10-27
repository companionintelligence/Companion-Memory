import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { PORTAL_TOKEN_VERIFIER, type PortalTokenVerifier } from '@ci/common/guards/PortalTokenVerifier';
import { LoggerService } from '@ci/common/logging';
import type { RawBodyRequest } from '@ci/common/middleware/BodyParserMiddleware';
import config from '@ci/configuration';
import type { AskChannelProvenance } from '@ci/domains/asks';

import { SignatureFormatError, parseSignatureHeaders } from '../httpSignature';
import { PEER_ASK_ID_PATTERN, peerAskBodySchema, type PeerAskResponse } from '../protocol';
import { PeerAskService } from '../services/PeerAskService';
import { PeerLinkService } from '../services/PeerLinkService';
import { PeerRateLimitService } from '../services/PeerRateLimitService';
import { PeerSignatureService } from '../services/PeerSignatureService';

/**
 * `/agent/v1` — the peer-facing surface, and the ONLY route another Companion
 * can reach.
 *
 * It is deliberately separate from the main API: it authenticates a *peer*
 * rather than a local user, so it does not use `JwtOrApiKeyAuthGuard` (whose
 * portal path JIT-provisions a local account — exactly what must not happen for
 * a peer). Instead it verifies the Portal token's claims only, then hands the
 * (issuer, subject) pair to the peer-link layer for attribution.
 *
 * ADR-0005 designates a dedicated `ci-mcp` adapter as the long-term external
 * boundary; until that lands this controller is the narrow, single-purpose
 * stand-in, gated by the `ask` feature flag (on by default since 2026-08-17).
 * The flag alone does not open this route: it also requires `peers.audience`,
 * and refuses every request until an operator binds one.
 */
@Controller('agent/v1')
export class PeerAskController {
  constructor(
    @Inject(PORTAL_TOKEN_VERIFIER)
    private readonly portalTokenVerifier: PortalTokenVerifier,
    private readonly peerAskService: PeerAskService,
    private readonly peerLinkService: PeerLinkService,
    private readonly signatureService: PeerSignatureService,
    private readonly rateLimitService: PeerRateLimitService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerAskController.name);
  }

  @Post('ask')
  async ask(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RawBodyRequest,
    @Body() body: unknown,
  ): Promise<PeerAskResponse> {
    const identity = await this.authenticate(authorization, request);
    const channel = await this.assertSignature(request, identity, request.rawBody);

    // Rate-limit on the verified peer identity, BEFORE the peer-link lookup, so
    // an unlinked caller cannot hammer the endpoint for free.
    await this.rateLimitService.consume(identity);

    const parsed = peerAskBodySchema.safeParse(body);
    if (!parsed.success) {
      // The body is attacker-controlled; reject anything off-contract outright.
      throw new BadRequestException('Malformed ask');
    }

    return this.peerAskService.handle(identity, parsed.data, channel);
  }

  /**
   * Collect the answer to an ask this peer already sent — the return path for
   * an ask a HUMAN approved, which had no channel at all before.
   *
   * It is a READ. It evaluates no grant, runs no executor, creates no ask and
   * writes no audit row; it can only hand back a disclosure that already
   * happened. See {@link PeerAskService.result} for why a poll rather than a
   * callback, and why an unknown id answers `pending` instead of 404.
   *
   * The path segment is the asker's own correlation id (the body's `askId`),
   * never a local row id, so this route leaks no identifier of this box. Its
   * own rate-limit bucket keeps collecting an answer from spending the budget
   * that protects the owner's review inbox — see
   * {@link PeerRateLimitService.consumePoll}.
   *
   * ═══ WHY THE PARAM IS NOT CALLED `askId` ═══
   *
   * `IdFormatGuard` is a GLOBAL guard that 404s any route parameter whose NAME
   * matches `/id$/i` and whose VALUE is not a uuid. Every local route it was
   * written for passes a local row id, so that is a sound assumption there — and
   * completely wrong here: a correlation id is minted by the PEER, is opaque to
   * this box by design, and is bounded by {@link PEER_ASK_ID_PATTERN} rather
   * than by uuid syntax.
   *
   * Naming it `askId` made every collect return `404 Not Found` — reproduced
   * against two real boxes, with the repeat-POST replay working perfectly
   * beside it, so it read as "the answer is not there" rather than "the route
   * is not reachable". Renaming the parameter is the fix: relaxing a global
   * guard so one route can accept non-uuid ids would weaken it for every route
   * that legitimately depends on it.
   */
  @Get('ask/:correlation')
  async result(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RawBodyRequest,
    @Param('correlation') askId: string,
  ): Promise<PeerAskResponse> {
    const identity = await this.authenticate(authorization, request);
    // The collect route creates nothing, so its channel facts have nowhere to
    // be recorded — but it is still verified, because a route with a weaker
    // gate is how the poll endpoint would have become the way in.
    await this.assertSignature(request, identity, undefined);

    await this.rateLimitService.consumePoll(identity);

    // The same bound `peerAskBodySchema` puts on `askId` — one definition, so
    // the two routes cannot disagree about which ids exist. This route has no
    // body, so nothing else would apply it.
    if (!PEER_ASK_ID_PATTERN.test(askId)) {
      throw new BadRequestException('Malformed ask');
    }

    return this.peerAskService.result(identity, askId);
  }

  /**
   * The gates every peer-facing route shares, in the order they have to run:
   * feature flag, bearer token, configured audience, verified claims. Factored
   * out rather than copied so a second route cannot quietly acquire a weaker
   * set — which is how a poll endpoint would have become the way in.
   */
  private async authenticate(
    authorization: string | undefined,
    request?: RawBodyRequest,
  ): Promise<{ issuer: string; subject: string }> {
    if (!(await this.featureService.isFeatureEnabled('ask'))) {
      // Dark by default: indistinguishable from a box that has no peer surface.
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    const token = extractBearer(authorization);
    if (!token || token.toLowerCase() === 'keri') {
      if (request?.headers['signature-input'] != null) {
        try {
          const { params } = parseSignatureHeaders(
            header(request, 'signature-input'),
            header(request, 'signature'),
          );
          if (params.keyid && params.keyid.startsWith('did:keri:')) {
            return { issuer: 'did:keri', subject: params.keyid };
          }
        } catch {
          // fall through to token check/rejection
        }
      }
      throw new UnauthorizedException('Missing bearer token');
    }

    // The token must be addressed to THIS box. Without a configured audience a
    // token minted for any first-party client — including one issued for a
    // different Companion — would verify here, so the surface refuses to accept
    // anything until an operator has bound it.
    const audience = config.peers?.audience?.trim();
    if (!audience) {
      this.logger.warn('peer ask refused: peers.audience is not configured');
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    // Claims only — never provision a local user for a peer.
    const identity = await this.portalTokenVerifier.verifyClaims(token, { audience: [audience] });
    if (!identity) {
      throw new UnauthorizedException('Invalid token');
    }

    return identity;
  }

  /**
   * Verify the request's RFC 9421 signature, and bind it to the bearer identity.
   *
   * ═══ WHY THE SIGNATURE IS NOT ENOUGH ON ITS OWN, YET ═══
   *
   * Downstream routing still resolves a peer link by `(issuer, subject)` — the
   * OIDC identity — so this step does not REPLACE that, it constrains it. What
   * it adds is the property the bearer token cannot have: a leaked token is no
   * longer sufficient, because the request must also be signed by the key the
   * owner recorded on that same link, over a digest of this exact body.
   *
   * Making the KEY the primary identity (and the Portal token an optional
   * attestation, per UMA's FLOW.md) is the follow-up; it needs the thumbprint
   * threaded through `PeerAskService`, which is a bigger change than this one.
   *
   * ═══ THE TARGET URI COMES FROM CONFIG, NEVER FROM `Host` ═══
   *
   * `@target-uri` is a SIGNED component, so whatever this box reconstructs is
   * what the signature is checked against. Building it from the `Host` header
   * would let a caller choose the authority half of the string and thereby make
   * a signature minted for `evil.example` verify here — the request would carry
   * its own idea of what it was addressed to. `peers.memoryEndpoint` is the
   * endpoint this box PUBLISHES to the directory, which is the authority a
   * peer would have signed over. Same rule as UMA's: authorization inputs never
   * come from transport headers.
   *
   * ═══ ONE REFUSAL FOR EVERY FAILURE ═══
   *
   * Every path below raises the identical 401. Which check failed — no
   * signature, unknown key, bad digest, replay, or a key that belongs to a
   * different peer than the token — is a fact about this box's configuration
   * and about the owner's links, and naming it would let a caller map both.
   * The specific reason is logged, where the operator can see it and the caller
   * cannot.
   */
  private async assertSignature(
    request: RawBodyRequest,
    identity: { issuer: string; subject: string },
    rawBody: string | undefined,
  ): Promise<AskChannelProvenance | null> {
    const hasSignatureHeaders = request.headers['signature-input'] != null;

    // Not required and not offered: nothing to check. A box that has not yet
    // turned the requirement on must keep talking to peers that do not sign.
    if (!this.signatureService.required && !hasSignatureHeaders) {
      return null;
    }

    if (!hasSignatureHeaders) {
      this.logger.warn(`peer ask refused: signature required but absent (${identity.issuer})`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    const authority = originOf(config.peers?.memoryEndpoint);
    if (!authority) {
      // Refusing is the only safe answer: with nothing to reconstruct
      // `@target-uri` from, the alternative is trusting a header for a signed
      // component. An operator who turns on signing must publish the endpoint
      // peers sign against.
      this.logger.warn('peer ask refused: peers.memoryEndpoint is not configured');
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    let keyid: string;
    let coveredComponents: string[];
    try {
      const { params } = parseSignatureHeaders(
        header(request, 'signature-input'),
        header(request, 'signature'),
      );
      keyid = params.keyid;
      coveredComponents = params.components;
    } catch (error) {
      if (!(error instanceof SignatureFormatError)) {
        throw error;
      }

      this.logger.warn(`peer ask refused: ${error.reason}`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    const links = await this.peerLinkService.findActiveByKeyThumbprint(keyid);

    // THE KEY AND THE TOKEN MUST AGREE ABOUT WHO THIS IS. Accepting any link
    // that merely holds the key would let peer A's signature authorize a
    // request carrying peer B's token — two halves of two different identities
    // combining into one that neither party holds.
    const link = links.find((candidate) => {
      if (candidate.peerIssuer === identity.issuer && candidate.peerSubject === identity.subject) {
        return true;
      }
      if (identity.issuer === 'did:keri') {
        const rawAid = identity.subject.replace(/^did:keri:/, '');
        if (
          candidate.peerIssuer === 'did:keri' &&
          (candidate.peerSubject === identity.subject || candidate.peerSubject === rawAid)
        ) {
          return true;
        }
        if (
          candidate.peerKeyThumbprint === keyid ||
          (candidate.peerKeyJwk as Record<string, unknown> | null)?.kid === keyid ||
          (candidate.peerKeyJwk as Record<string, unknown> | null)?.aid === keyid
        ) {
          return true;
        }
      }
      return false;
    });

    const peerKeyJwk =
      link?.peerKeyJwk ??
      (keyid.startsWith('did:keri:D')
        ? {
            kty: 'OKP',
            crv: 'Ed25519',
            x: keyid.slice('did:keri:D'.length),
            kid: keyid,
          }
        : null);

    if (link == null || peerKeyJwk == null) {
      this.logger.warn(`peer ask refused: no link binds key ${keyid} to ${identity.issuer}`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    const verification = await this.signatureService.verifyInbound({
      method: request.method,
      targetUri: `${authority}${request.originalUrl ?? request.url}`,
      signatureInput: header(request, 'signature-input'),
      signature: header(request, 'signature'),
      contentDigestHeader: header(request, 'content-digest'),
      rawBody,
      peerPublicJwk: peerKeyJwk,
    });

    if (!verification.ok) {
      this.logger.warn(`peer ask refused: signature ${verification.reason} (${link.peerHandle})`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    // Returned rather than merely logged: whether an ask was signed is the
    // difference between "someone holding a token that names this peer asked
    // me this" and "this peer's own key signed this exact question, once" —
    // and the owner is the person who has to tell those apart. `AskService`
    // stamps it on the row and the ask surfaces render it.
    return {
      keyThumbprint: verification.keyThumbprint,
      // The verifier's own clock reading, not `created` from the signature:
      // `created` is the SENDER's claim about when they signed, and the audit
      // records when THIS box accepted it.
      verifiedAt: new Date(),
      covered: coveredComponents,
    };
  }
}

/** The ONE refusal a signature failure ever produces. See {@link PeerAskController.assertSignature}. */
const SIGNATURE_REFUSED = 'Invalid token';

/**
 * The ORIGIN of this box's published endpoint — scheme, host, port, and nothing
 * else.
 *
 * `peers.memoryEndpoint` is the full `/agent/v1` base URL, while
 * `request.originalUrl` already carries `/agent/v1/...`; concatenating the two
 * whole strings doubles the prefix and every honest signature fails. The
 * authority half comes from config (never from `Host`) and the path half comes
 * from the route, which is exactly the split that keeps a caller from choosing
 * either one.
 *
 * Returns null for anything unparseable, which the caller turns into a refusal
 * rather than a guess.
 */
function originOf(endpoint: string | undefined): string | null {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/** Read a single-valued header, dropping the array form express allows. */
function header(request: RawBodyRequest, name: string): string | undefined {
  const value = request.headers[name];

  return typeof value === 'string' ? value : undefined;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}
