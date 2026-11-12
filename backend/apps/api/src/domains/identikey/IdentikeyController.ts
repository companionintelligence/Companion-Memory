import { Body, Controller, NotFoundException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { FeatureService } from '@ci/common/feature';

import { fingerprintToBase58 } from './identity/keys';
import { ChallengeIssuer, InMemoryNonceStore } from './identity/nonceStore';
import { verifyResponse } from './identity/verify';

/**
 * Controller for IdentiKey challenge/response auth protocol (identikey-auth Phase 1).
 * Gated by `auth.identikey` feature flag (off by default; returns 404 when disabled).
 */
@Controller('auth/identikey')
export class IdentikeyController {
  private readonly nonceStore = new InMemoryNonceStore();

  constructor(private readonly features: FeatureService) {}

  @Post('challenge')
  async createChallenge(@Req() req: Request): Promise<{ challengeBase64: string; challenge: unknown }> {
    if (!(await this.features.isFeatureEnabled('auth.identikey'))) {
      throw new NotFoundException();
    }

    const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
    const issuer = new ChallengeIssuer({
      audience: host,
      ttlSeconds: 300,
    });

    const now = Math.floor(Date.now() / 1000);
    const issued = await issuer.issue(this.nonceStore, now);

    return {
      challengeBase64: Buffer.from(issued.bytes).toString('base64'),
      challenge: issued.challenge,
    };
  }

  @Post('verify')
  async verifyChallenge(
    @Req() req: Request,
    @Body() body: { responseBase64?: string },
  ): Promise<{ ok: boolean; fingerprint?: string; code?: string }> {
    if (!(await this.features.isFeatureEnabled('auth.identikey'))) {
      throw new NotFoundException();
    }

    if (!body?.responseBase64 || typeof body.responseBase64 !== 'string') {
      return { ok: false, code: 'malformed-cbor' };
    }

    const responseBytes = new Uint8Array(Buffer.from(body.responseBase64, 'base64'));
    const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
    const now = Math.floor(Date.now() / 1000);

    const result = await verifyResponse(responseBytes, {
      audience: host,
      now,
      skewSeconds: 60,
      policy: 'pq-optional',
      nonces: this.nonceStore,
    });

    if (!result.ok) {
      return { ok: false, code: result.code };
    }

    return {
      ok: true,
      fingerprint: fingerprintToBase58(result.verified.fingerprint),
    };
  }
}
