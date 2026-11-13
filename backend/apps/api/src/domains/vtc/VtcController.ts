import { Body, Controller, NotFoundException, Post } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

import { verifyProof } from './dataIntegrity';
import { DtgParseError, parseDtgCredential, type DtgCredential } from './dtgCredential';
import { isPlainObject } from './json';
import { createKeyResolver, type KeyResolver } from './keyResolver';
import { DEFAULT_STATUS_LIST_MAX_AGE_MS } from './recognition';
import {
  evaluateStatus,
  parseStatusEntry,
  StatusListError,
  type BitstringStatusListEntry,
} from './statusList';

export interface VerifyCredentialBody {
  credential?: unknown;
  expectedSubject?: string;
  expectedCommunity?: string;
  requireStatus?: boolean;
  /** Optional pre-fetched BitstringStatusListCredential matching the credential's status entry. */
  statusListCredential?: unknown;
  /** Optional map of `statusListCredential` URL -> pre-fetched BitstringStatusListCredential (zero outbound fetch). */
  statusListCredentials?: Record<string, unknown>;
}

export interface VerifyCredentialResult {
  valid: boolean;
  reason?: string;
  issuer?: string;
  issuerScope?: string;
  subject?: string;
  subtype?: string;
  credentialId?: string | null;
  validFrom?: string;
  validUntil?: string | null;
  statusChecked?: boolean;
  personhoodHint?: boolean;
}

export interface EvaluateStatusListBody {
  entry?: unknown;
  statusListCredential?: unknown;
  expectedIssuer?: string;
}

/**
 * Controller for Verifiable Trust Community (OpenVTC) credentials facade (`/vtc/*`).
 * Gated by `vtc.credentials` feature flag (off by default; returns 404 when disabled).
 *
 * All verification runs strictly offline against caller-presented credentials and optional
 * pre-fetched status lists (no outbound network calls from this verification endpoint).
 */
@Controller('vtc')
export class VtcController {
  constructor(private readonly features: FeatureService) {}

  @Post('verify')
  async verifyCredential(@Body() body: VerifyCredentialBody): Promise<VerifyCredentialResult> {
    if (!(await this.features.isFeatureEnabled('vtc.credentials'))) {
      throw new NotFoundException();
    }

    if (!body?.credential || typeof body.credential !== 'object' || Array.isArray(body.credential)) {
      return { valid: false, reason: 'MALFORMED_CREDENTIAL' };
    }

    try {
      const parsed = parseDtgCredential(body.credential);

      if (body.expectedCommunity && parsed.issuer !== body.expectedCommunity) {
        return { valid: false, reason: 'UNRECOGNIZED_COMMUNITY' };
      }

      const now = new Date();
      const nowMs = now.getTime();
      const clockSkewMs = 60_000;
      if (parsed.validFrom.getTime() > nowMs + clockSkewMs) {
        return { valid: false, reason: 'NOT_YET_VALID' };
      }

      if (parsed.validUntil && parsed.validUntil.getTime() + clockSkewMs <= nowMs) {
        return { valid: false, reason: 'EXPIRED' };
      }

      const keyResolver = createKeyResolver();
      const proofResult = await verifyProof(body.credential, { resolveKey: keyResolver });
      if (!proofResult.ok) {
        return { valid: false, reason: proofResult.code || 'BAD_PROOF' };
      }

      if (body.expectedSubject && parsed.subject !== body.expectedSubject) {
        return { valid: false, reason: 'SUBJECT_MISMATCH' };
      }

      const statusOutcome = await this.verifyStatusEntries(parsed, body, keyResolver, now, clockSkewMs);
      if (!statusOutcome.ok) {
        return { valid: false, reason: statusOutcome.reason };
      }

      return {
        valid: true,
        issuer: parsed.issuer,
        issuerScope: parsed.issuerScope,
        subject: parsed.subject,
        subtype: parsed.subtype,
        credentialId: parsed.id,
        validFrom: parsed.validFrom.toISOString(),
        validUntil: parsed.validUntil ? parsed.validUntil.toISOString() : null,
        statusChecked: statusOutcome.checked,
        personhoodHint: parsed.personhoodHint,
      };
    } catch (err) {
      if (err instanceof DtgParseError) {
        return { valid: false, reason: err.message };
      }

      return {
        valid: false,
        reason: (err as Error).message || 'VERIFICATION_FAILED',
      };
    }
  }

  /**
   * Evaluates a W3C Bitstring Status List entry against a caller-supplied signed list credential.
   * Useful for inspecting revocation/suspension bits without making network requests.
   */
  @Post('status-list/evaluate')
  async evaluateStatusList(@Body() body: EvaluateStatusListBody): Promise<{
    valid: boolean;
    purpose?: string;
    status?: number;
    bounded?: boolean;
    reason?: string;
  }> {
    if (!(await this.features.isFeatureEnabled('vtc.credentials'))) {
      throw new NotFoundException();
    }

    let entry: BitstringStatusListEntry;
    try {
      entry = parseStatusEntry(body?.entry);
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : 'MALFORMED_STATUS_ENTRY' };
    }

    if (!isPlainObject(body?.statusListCredential)) {
      return { valid: false, reason: 'STATUS_LIST_MISSING' };
    }

    if (body.expectedIssuer && body.statusListCredential.issuer !== body.expectedIssuer) {
      return { valid: false, reason: 'STATUS_LIST_ISSUER_MISMATCH' };
    }

    const proof = await verifyProof(body.statusListCredential, { resolveKey: createKeyResolver() });
    if (!proof.ok) {
      return { valid: false, reason: proof.code || 'STATUS_LIST_BAD_PROOF' };
    }

    try {
      const evaluated = evaluateStatus(entry, body.statusListCredential, {
        now: new Date(),
        skewMs: 60_000,
        maxAgeMs: DEFAULT_STATUS_LIST_MAX_AGE_MS,
      });

      if (!evaluated.valid) {
        const failureReason =
          evaluated.purpose === 'revocation'
            ? 'REVOKED'
            : evaluated.purpose === 'suspension'
              ? 'SUSPENDED'
              : `STATUS_${evaluated.purpose.toUpperCase()}`;

        return {
          valid: false,
          purpose: evaluated.purpose,
          status: evaluated.status,
          bounded: evaluated.bounded,
          reason: failureReason,
        };
      }

      return {
        valid: true,
        purpose: evaluated.purpose,
        status: evaluated.status,
        bounded: evaluated.bounded,
      };
    } catch (err) {
      if (err instanceof StatusListError) {
        return { valid: false, reason: err.code };
      }

      return { valid: false, reason: err instanceof Error ? err.message : 'STATUS_LIST_INVALID' };
    }
  }

  private async verifyStatusEntries(
    parsed: DtgCredential,
    body: VerifyCredentialBody,
    keyResolver: KeyResolver,
    now: Date,
    skewMs: number,
  ): Promise<{ ok: true; checked: boolean } | { ok: false; reason: string }> {
    const hasInlineLists =
      body.statusListCredential !== undefined ||
      (body.statusListCredentials !== undefined && isPlainObject(body.statusListCredentials));

    if (parsed.status.length === 0) {
      return body.requireStatus ? { ok: false, reason: 'STATUS_REQUIRED' } : { ok: true, checked: false };
    }

    if (!hasInlineLists && !body.requireStatus) {
      return { ok: true, checked: false };
    }

    for (const entry of parsed.status) {
      if (entry.statusPurpose !== 'revocation' && entry.statusPurpose !== 'suspension') {
        return { ok: false, reason: 'STATUS_UNSUPPORTED' };
      }

      const listCredential = this.pickStatusListCredential(entry, body, parsed.status.length);
      if (!isPlainObject(listCredential)) {
        return { ok: false, reason: 'STATUS_UNAVAILABLE' };
      }

      if (listCredential.issuer !== parsed.issuer) {
        return { ok: false, reason: 'STATUS_LIST_INVALID' };
      }

      const listProof = await verifyProof(listCredential, { resolveKey: keyResolver });
      if (!listProof.ok) {
        return { ok: false, reason: 'STATUS_LIST_INVALID' };
      }

      try {
        const result = evaluateStatus(entry, listCredential, {
          now,
          skewMs,
          maxAgeMs: DEFAULT_STATUS_LIST_MAX_AGE_MS,
        });
        if (!result.valid) {
          return {
            ok: false,
            reason: entry.statusPurpose === 'revocation' ? 'REVOKED' : 'SUSPENDED',
          };
        }
      } catch {
        return { ok: false, reason: 'STATUS_LIST_INVALID' };
      }
    }

    return { ok: true, checked: true };
  }

  private pickStatusListCredential(
    entry: BitstringStatusListEntry,
    body: VerifyCredentialBody,
    totalEntries: number,
  ): unknown {
    if (body.statusListCredentials && entry.statusListCredential in body.statusListCredentials) {
      return body.statusListCredentials[entry.statusListCredential];
    }

    if (isPlainObject(body.statusListCredential)) {
      if (body.statusListCredential.id === entry.statusListCredential || totalEntries === 1) {
        return body.statusListCredential;
      }
    }

    return undefined;
  }
}
