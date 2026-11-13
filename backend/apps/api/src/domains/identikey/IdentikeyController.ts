import { Body, Controller, NotFoundException, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';

import { FeatureService } from '@ci/common/feature';

import { IdentiKeyError } from './errors';
import { fingerprintToBase58 } from './identity/keys';
import { ChallengeIssuer, InMemoryNonceStore, type IssuedChallenge } from './identity/nonceStore';
import { verifyResponse } from './identity/verify';

const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;
const MAX_RESPONSE_BASE64_CHARS = 65_536;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Controller for IdentiKey challenge/response auth protocol (identikey-auth Phase 1).
 * Gated by `auth.identikey` feature flag (off by default; returns 404 when disabled).
 */
@Controller('auth/identikey')
export class IdentikeyController {
  private readonly nonceStore = new InMemoryNonceStore();

  constructor(private readonly features: FeatureService) {}

  private resolveAudience(req: Request): string {
    const rawHost = req.get('host')?.trim() ?? '';

    return SAFE_HOST_PATTERN.test(rawHost) ? rawHost : 'localhost';
  }

  private async issueChallengeSafe(audience: string): Promise<IssuedChallenge> {
    const issuer = new ChallengeIssuer({
      audience,
      ttlSeconds: 300,
    });
    const now = Math.floor(Date.now() / 1000);

    try {
      return await issuer.issue(this.nonceStore, now);
    } catch (error) {
      if (error instanceof IdentiKeyError && error.code === 'store-full') {
        throw new ServiceUnavailableException('IdentiKey challenge store is temporarily full');
      }

      throw error;
    }
  }

  @Post('challenge')
  async createChallenge(@Req() req: Request): Promise<{ challengeBase64: string; challenge: unknown }> {
    if (!(await this.features.isFeatureEnabled('auth.identikey'))) {
      throw new NotFoundException();
    }

    const host = this.resolveAudience(req);
    const issued = await this.issueChallengeSafe(host);

    return {
      challengeBase64: Buffer.from(issued.bytes).toString('base64'),
      challenge: {
        version: issued.challenge.version,
        audience: issued.challenge.audience,
        issuedAt: issued.challenge.issuedAt,
        expiresAt: issued.challenge.expiresAt,
        nonceBase64: Buffer.from(issued.challenge.nonce).toString('base64'),
      },
    };
  }

  @Post('verify')
  async verifyChallenge(
    @Req() req: Request,
    @Body() body: { responseBase64?: string },
  ): Promise<{ ok: boolean; fingerprint?: string; reason?: string }> {
    if (!(await this.features.isFeatureEnabled('auth.identikey'))) {
      throw new NotFoundException();
    }

    const encoded = typeof body?.responseBase64 === 'string' ? body.responseBase64.trim() : '';
    if (
      encoded.length === 0 ||
      encoded.length > MAX_RESPONSE_BASE64_CHARS ||
      encoded.length % 4 !== 0 ||
      !STRICT_BASE64_PATTERN.test(encoded)
    ) {
      return { ok: false, reason: 'AUTHENTICATION_FAILED' };
    }

    const responseBytes = new Uint8Array(Buffer.from(encoded, 'base64'));
    const host = this.resolveAudience(req);
    const now = Math.floor(Date.now() / 1000);

    const result = await verifyResponse(responseBytes, {
      audience: host,
      now,
      skewSeconds: 60,
      policy: 'pq-optional',
      nonces: this.nonceStore,
    });

    if (!result.ok) {
      return { ok: false, reason: 'AUTHENTICATION_FAILED' };
    }

    return {
      ok: true,
      fingerprint: fingerprintToBase58(result.verified.fingerprint),
    };
  }
}
