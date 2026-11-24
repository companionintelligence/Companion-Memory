import { canonicalizeJcs } from '@ci/common/crypto';

import { AUDIT_SAID_PLACEHOLDER, cesrSha256 } from './auditSaid';
import type { AuditableRecord } from './auditSaid';

/**
 * ISO/IEC TS 27560:2023 + W3C Data Privacy Vocabulary (DPV v2) Consent Receipt builder.
 *
 * Self-addressed with a CESR `I` (SHA2-256) SAID over RFC 8785 JCS so consent receipts are
 * tamper-evident, portable, and ready for KEL/Merkle batch anchoring.
 */

export const ISO_27560_DPV_SCHEMA_VERSION = 'iso-27560:2023+dpv:v2';

export interface Iso27560ConsentReceipt {
  d: string;
  schemaVersion: typeof ISO_27560_DPV_SCHEMA_VERSION;
  recordId: string;
  piiPrincipalId: string | null;
  recipient: string | null;
  legalBasis: 'dpv:Consent' | 'dpv:ExplicitConsent';
  purposes: string[];
  processing: string[];
  consentBasis: string | null;
  outcome: string;
  disclosedCount: number;
  issuedAt: string;
}

export interface BuildConsentReceiptOptions {
  issuedAt?: string;
  legalBasis?: 'dpv:Consent' | 'dpv:ExplicitConsent';
  purposes?: string[];
}

function mapConsentBasisToDpvPurposes(consentBasis: string | null | undefined): string[] {
  if (!consentBasis) {
    return ['dpv:ServiceProvision'];
  }

  const normalized = consentBasis.toLowerCase();
  const purposes = new Set<string>(['dpv:ServiceProvision']);
  if (normalized.includes('grant') || normalized.includes('standing')) {
    purposes.add('dpv:PersonalisedBenefits');
  }

  if (normalized.includes('peer') || normalized.includes('federated') || normalized.includes('share')) {
    purposes.add('dpv:DataTransfer');
  }

  if (normalized.includes('explicit') || normalized.includes('approved')) {
    purposes.add('dpv:RequestedServiceProvision');
  }

  return [...purposes].sort();
}

/** Builds a self-addressed ISO/IEC TS 27560 + DPV v2 consent receipt for an ask audit record. */
export function buildIso27560ConsentReceipt(
  record: AuditableRecord,
  options: BuildConsentReceiptOptions = {},
): Iso27560ConsentReceipt {
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const legalBasis =
    options.legalBasis ?? (record.consentBasis === 'owner_approved' ? 'dpv:ExplicitConsent' : 'dpv:Consent');
  const purposes = options.purposes
    ? [...options.purposes].sort()
    : mapConsentBasisToDpvPurposes(record.consentBasis);
  const disclosedCount =
    record.disclosedCount ?? (record.disclosedEntities ? record.disclosedEntities.length : 0);

  const unsigned: Iso27560ConsentReceipt = {
    d: AUDIT_SAID_PLACEHOLDER,
    schemaVersion: ISO_27560_DPV_SCHEMA_VERSION,
    recordId: record.askId ?? 'unassigned',
    piiPrincipalId: record.responderUserId ?? null,
    recipient: record.peerHandle ?? record.askerUserId ?? null,
    legalBasis,
    purposes,
    processing: disclosedCount > 0 ? ['dpv:Disclose', 'dpv:Share'] : ['dpv:Assess'],
    consentBasis: record.consentBasis ?? null,
    outcome: record.outcome,
    disclosedCount,
    issuedAt,
  };

  const d = cesrSha256(Buffer.from(canonicalizeJcs(unsigned), 'utf8'));

  return { ...unsigned, d };
}

/** Verifies the CESR `I` SAID of an ISO/IEC TS 27560 + DPV v2 consent receipt. */
export function verifyIso27560ConsentReceipt(receipt: Iso27560ConsentReceipt): boolean {
  if (!receipt || typeof receipt.d !== 'string' || !/^I[A-Za-z0-9_-]{43}$/.test(receipt.d)) {
    return false;
  }

  const unsigned: Iso27560ConsentReceipt = {
    ...receipt,
    d: AUDIT_SAID_PLACEHOLDER,
  };
  const expected = cesrSha256(Buffer.from(canonicalizeJcs(unsigned), 'utf8'));

  return expected === receipt.d;
}
