import {
  BadRequestException,
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
import { type RawBodyRequest, transportHasBody } from '@ci/common/middleware/BodyParserMiddleware';
import config from '@ci/configuration';
import type { AskChannelProvenance } from '@ci/domains/asks';

import { SignatureFormatError, parseSignatureHeaders } from '../httpSignature';
import {
  claimedKeyId,
  extractBearer,
  header,
  parseRawJson,
  publishedBase,
  signedTargetUri,
} from '../peerRequest';
import { PEER_ASK_ID_PATTERN, peerAskBodySchema, type PeerAskResponse } from '../protocol';
import {
  isSelfCertifyingIssuer,
  selfCertifyingIssuerOf,
  selfCertifyingPublicJwk,
} from '../selfCertifyingKeyId';
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
 * The flag alone does not open the Portal-token path: it also requires
 * `peers.audience`, and refuses every request until an operator binds one. A
 * request signed under a self-certifying key (`did:keri:D<x>` or `did:key`) has
 * no token and needs no audience; it needs `peers.memoryEndpoint` (what the
 * signed `@target-uri` is rebuilt from) and a link the owner made for exactly
 * that identifier, and is refused with a 401 without one.
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
  ): Promise<PeerAskResponse> {
    const identity = await this.authenticate(authorization, request);
    const channel = await this.assertSignature(request, identity);

    // Rate-limit on the verified peer identity, BEFORE the peer-link lookup, so
    // an unlinked caller cannot hammer the endpoint for free.
    await this.rateLimitService.consume(identity);

    // As TrustTasksController does, the ask is read from the exact bytes a
    // signature's digest is checked against (BodyParserMiddleware keeps them for
    // /agent/v1), never from a separately parsed body.
    const parsed = peerAskBodySchema.safeParse(parseRawJson(request.rawBody));
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
    // gate is how the poll endpoint would have become the way in. A body sent
    // on it anyway is held to the same binding as one sent to `ask`.
    await this.assertSignature(request, identity);

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
      // A SOVEREIGN peer: no Portal token, only a signature whose keyid is a
      // self-certifying `did:keri:D<x>` (see `sovereignKeyId.ts`) or `did:key:z6Mk…`
      // (see `didKeyId.ts`). This returns the CLAIMED identity and proves nothing
      // yet: `assertSignature` must then find a link the owner made for exactly
      // that identifier, under its own issuer, and verify the signature, and every
      // caller runs it before using the identity.
      const keyid = request ? claimedKeyId(request) : null;
      const selfCertifying = keyid != null ? selfCertifyingIssuerOf(keyid) : null;
      if (keyid != null && selfCertifying != null) {
        return { issuer: selfCertifying, subject: keyid };
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
   * it adds, for a request that is signed, is the property the bearer token
   * cannot have: the request is bound to the key the owner recorded on that
   * same link, over a digest of this exact body, with a nonce that makes a
   * replay detectable.
   *
   * On the shipped defaults that is optional. `peers.requireHttpSignature` is
   * off, so a request with no signature headers returns early below and the
   * Portal token alone authenticates it: a leaked token is enough to ask as
   * that peer, and a replay is not detected. Only with the flag on does every
   * request have to carry a valid signature, and an unsigned one is refused.
   * The boot-time warning in `configuration.ts` reports the default state.
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
   * `/agent/v1` base the owner gave peers, which they store on their link to
   * this box and sign `<base>/ask` against. Nothing publishes it to a
   * directory. Same rule as UMA's: authorization inputs never come from
   * transport headers.
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

    const base = publishedBase(config.peers?.memoryEndpoint);
    if (!base) {
      // Refusing is the only safe answer: with nothing to reconstruct
      // `@target-uri` from, the alternative is trusting a header for a signed
      // component. An operator who turns on signing must publish the endpoint
      // peers sign against.
      this.logger.warn('peer ask refused: peers.memoryEndpoint is not configured');
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    // A path outside `/agent/v1` has no signed target to rebuild, so it gets the
    // same refusal as every other signature failure.
    const targetUri = signedTargetUri(base, request.originalUrl ?? request.url);
    if (targetUri == null) {
      this.logger.warn('peer ask refused: request path is outside /agent/v1');
      throw new UnauthorizedException(SIGNATURE_REFUSED);
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
    // combining into one that neither party holds. A sovereign peer has no
    // token, so its identity is `did:keri` or `did:key` + the identifier it signed
    // with, and the same exact match applies: only a link under that issuer naming
    // that very identifier (the full `did:…:` form `PeerAskService` resolves it
    // by) answers. A link the owner made for a Portal identity never answers a
    // bare signature, and a `did:key` link never answers a `did:keri` one.
    const sovereign = isSelfCertifyingIssuer(identity.issuer);
    const link = links.find(
      (candidate) => candidate.peerIssuer === identity.issuer && candidate.peerSubject === identity.subject,
    );

    // The key the link records always wins: an AID whose link holds a different
    // key is refused, never verified against the key the AID spells out. Only a
    // sovereign link with no key recorded falls back to that spelled-out key,
    // which is the whole point of a self-certifying identifier — and only for
    // the documented `did:keri:D<x>` and `did:key:z6Mk…` forms, never a CESR
    // prefix, an `E` AID, or a DID whose key can rotate.
    const peerKeyJwk = link?.peerKeyJwk ?? (sovereign && link ? selfCertifyingPublicJwk(keyid) : null);

    if (link == null || peerKeyJwk == null) {
      this.logger.warn(`peer ask refused: no link binds key ${keyid} to ${identity.issuer}`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    const verification = await this.signatureService.verifyInbound({
      method: request.method,
      targetUri,
      signatureInput: header(request, 'signature-input'),
      signature: header(request, 'signature'),
      contentDigestHeader: header(request, 'content-digest'),
      // Whether there IS a body comes from the transport, never from whether a
      // parser happened to keep its bytes; see `transportHasBody`.
      transportHasBody: transportHasBody(request.headers),
      rawBody: request.rawBody,
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
export const SIGNATURE_REFUSED = 'Invalid token';

