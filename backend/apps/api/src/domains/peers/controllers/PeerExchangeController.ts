import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { type RawBodyRequest, transportHasBody } from '@ci/common/middleware/BodyParserMiddleware';
import config from '@ci/configuration';

import { didKeyPublicJwk, isDidKeyId } from '../didKeyId';
import { IDENTITY_CHALLENGE_PATTERN, type IdentityProofDocument, signIdentityProof } from '../identityProof';
import { readRotationNotice, readUnlinkNotice } from '../keyNotices';
import { claimedKeyId, header, parseRawJson, publishedBase, signedTargetUri } from '../peerRequest';
import { PeerIdentityService } from '../services/PeerIdentityService';
import { type InviteAcceptance, PeerInviteService } from '../services/PeerInviteService';
import { PeerNoticeService } from '../services/PeerNoticeService';
import { PeerRateLimitService } from '../services/PeerRateLimitService';
import { PeerSignatureService } from '../services/PeerSignatureService';

/** The one refusal any signature failure on these routes produces; the reason is logged, not returned. */
const SIGNATURE_REFUSED = 'Invalid signature';

/**
 * `/agent/v1` routes for LINKING people, beside the ask routes in
 * `PeerAskController`: the identity proof another box checks before it links
 * someone here.
 *
 * Same gates as the ask surface: dark unless the `ask` feature is on, and
 * refused unless this box publishes the address peers reach it at
 * (`peers.memoryEndpoint`), because every proof names that address.
 */
@Controller('agent/v1')
export class PeerExchangeController {
  constructor(
    private readonly identityService: PeerIdentityService,
    private readonly inviteService: PeerInviteService,
    private readonly noticeService: PeerNoticeService,
    private readonly signatureService: PeerSignatureService,
    private readonly rateLimitService: PeerRateLimitService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerExchangeController.name);
  }

  /**
   * Prove that this box holds the key `didKey` names, at the address it
   * publishes, in answer to the caller's `challenge`. See `identityProof.ts`.
   *
   * A `did:key` nobody here holds (or one retired by a rotation) is a 404. That
   * tells the caller only whether a key THEY ALREADY KNOW lives here, and a
   * did:key is 256 bits of public key nobody can guess, so it lists no one.
   */
  @Get('identity/:didKey')
  async identity(
    @Param('didKey') didKey: string,
    @Query('challenge') challenge: string | undefined,
  ): Promise<IdentityProofDocument> {
    const endpoint = await this.openEndpoint();

    if (!isDidKeyId(didKey) || typeof challenge !== 'string' || !IDENTITY_CHALLENGE_PATTERN.test(challenge)) {
      throw new BadRequestException('Malformed identity request');
    }

    await this.rateLimitService.consumeExchange({ issuer: 'identity', subject: didKey });

    const identity = await this.identityService.findActiveByDidKey(didKey);
    if (identity == null) {
      throw new NotFoundException('Not found');
    }

    return signIdentityProof(identity.signer.key, { didKey, endpoint, challenge });
  }

  /**
   * Another person's box accepting one of this box's invites. The request is
   * signed by the accepting person's own key, and its body names that same key;
   * see {@link PeerInviteService.receive} for what is checked after that.
   */
  @Post('invites/accept')
  @HttpCode(200)
  async acceptInvite(@Req() request: RawBodyRequest): Promise<InviteAcceptance> {
    const endpoint = await this.openEndpoint();
    const sender = await this.signedBy(request, endpoint, 'invite');

    return this.inviteService.receive(sender, parseRawJson(request.rawBody));
  }

  /**
   * "I have a new key": signed by the key the recipient's link names, carrying
   * a proof made with the new one. The answer is the same whether or not a
   * link matched, so it tells the caller nothing about who is linked here.
   */
  @Post('key-rotation')
  @HttpCode(200)
  async keyRotation(@Req() request: RawBodyRequest): Promise<{ ok: true }> {
    const endpoint = await this.openEndpoint();
    const sender = await this.signedBy(request, endpoint, 'rotation');
    const notice = readRotationNotice(parseRawJson(request.rawBody));

    if (notice == null || notice.oldDidKey !== sender) {
      throw new BadRequestException('Malformed key rotation');
    }

    await this.noticeService.applyRotation(notice.oldDidKey, notice.newDidKey, notice.recipient);

    return { ok: true };
  }

  /** "I ended our link": signed by the sender's key; ends the recipient's link to them. Same answer either way. */
  @Post('unlink')
  @HttpCode(200)
  async unlink(@Req() request: RawBodyRequest): Promise<{ ok: true }> {
    const endpoint = await this.openEndpoint();
    const sender = await this.signedBy(request, endpoint, 'unlink');
    const notice = readUnlinkNotice(parseRawJson(request.rawBody));

    if (notice == null) {
      throw new BadRequestException('Malformed unlink');
    }

    await this.noticeService.applyUnlink(sender, notice.recipient);

    return { ok: true };
  }

  /**
   * The `did:key` that signed `request`, once the signature has been verified
   * against the key that identifier spells out. These routes are reached before
   * any link exists (an invite) or about a link the sender names, so the key is
   * the identifier itself, never a key looked up on a link.
   */
  private async signedBy(request: RawBodyRequest, endpoint: string, bucket: string): Promise<string> {
    const keyid = claimedKeyId(request);
    if (keyid == null || !isDidKeyId(keyid)) {
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    await this.rateLimitService.consumeExchange({ issuer: bucket, subject: keyid });

    const targetUri = signedTargetUri(endpoint, request.originalUrl ?? request.url);
    const publicJwk = didKeyPublicJwk(keyid);
    if (targetUri == null || publicJwk == null) {
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    const verification = await this.signatureService.verifyInbound({
      method: request.method,
      targetUri,
      signatureInput: header(request, 'signature-input'),
      signature: header(request, 'signature'),
      contentDigestHeader: header(request, 'content-digest'),
      transportHasBody: transportHasBody(request.headers),
      rawBody: request.rawBody,
      peerPublicJwk: publicJwk,
    });

    if (!verification.ok) {
      this.logger.warn(`peer ${bucket} refused: signature ${verification.reason}`);
      throw new UnauthorizedException(SIGNATURE_REFUSED);
    }

    return keyid;
  }

  /** This box's published `/agent/v1` base, or the same 503 the ask surface gives when it is closed. */
  private async openEndpoint(): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('ask'))) {
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    const endpoint = publishedBase(config.peers?.memoryEndpoint);
    if (endpoint == null) {
      throw new ServiceUnavailableException('Peer asks are not enabled');
    }

    return endpoint;
  }
}
