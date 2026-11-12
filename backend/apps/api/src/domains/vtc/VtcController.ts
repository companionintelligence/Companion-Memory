import { Body, Controller, NotFoundException, Post } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

import { verifyProof } from './dataIntegrity';
import { parseDtgCredential } from './dtgCredential';
import { createKeyResolver } from './keyResolver';

/**
 * Controller for Verifiable Trust Community (OpenVTC) credentials facade (`/vtc/*`).
 * Gated by `vtc.credentials` feature flag (off by default; returns 404 when disabled).
 */
@Controller('vtc')
export class VtcController {
  constructor(private readonly features: FeatureService) {}

  @Post('verify')
  async verifyCredential(@Body() body: { credential?: unknown; expectedSubject?: string }): Promise<{
    valid: boolean;
    reason?: string;
    issuer?: string;
    subject?: string;
    subtype?: string;
  }> {
    if (!(await this.features.isFeatureEnabled('vtc.credentials'))) {
      throw new NotFoundException();
    }

    if (!body?.credential || typeof body.credential !== 'object' || Array.isArray(body.credential)) {
      return { valid: false, reason: 'MALFORMED_CREDENTIAL' };
    }

    try {
      const parsed = parseDtgCredential(body.credential);

      const nowMs = Date.now();
      const clockSkewMs = 60_000;
      if (parsed.validFrom.getTime() > nowMs + clockSkewMs) {
        return { valid: false, reason: 'NOT_YET_VALID' };
      }

      if (parsed.validUntil && parsed.validUntil.getTime() + clockSkewMs <= nowMs) {
        return { valid: false, reason: 'EXPIRED' };
      }

      // Verify data integrity proof
      const keyResolver = createKeyResolver();
      const proofResult = await verifyProof(body.credential, { resolveKey: keyResolver });
      if (!proofResult.ok) {
        return { valid: false, reason: proofResult.code || 'BAD_PROOF' };
      }

      if (body.expectedSubject && parsed.subject !== body.expectedSubject) {
        return { valid: false, reason: 'SUBJECT_MISMATCH' };
      }

      return {
        valid: true,
        issuer: parsed.issuer,
        subject: parsed.subject,
        subtype: parsed.subtype,
      };
    } catch (err) {
      return {
        valid: false,
        reason: (err as Error).message || 'VERIFICATION_FAILED',
      };
    }
  }
}
