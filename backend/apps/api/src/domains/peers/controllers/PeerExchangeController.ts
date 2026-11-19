import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { isDidKeyId } from '../didKeyId';
import { IDENTITY_CHALLENGE_PATTERN, type IdentityProofDocument, signIdentityProof } from '../identityProof';
import { publishedBase } from '../peerRequest';
import { PeerIdentityService } from '../services/PeerIdentityService';
import { PeerRateLimitService } from '../services/PeerRateLimitService';

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
