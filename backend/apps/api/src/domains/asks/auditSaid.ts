import { createHash } from 'node:crypto';

import type { AskAudit, AskAuditEntity } from './entities/AskAuditEntity';
import type { RecordAskAuditDto } from './types';

/** Standard 44-character placeholder for a 256-bit SHA-256 SAID in CESR encoding. */
export const AUDIT_SAID_PLACEHOLDER = '#'.repeat(44);

/**
 * Deterministically sorts object keys recursively for canonical JSON serialization (RFC 8785 / KERI).
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = canonicalizeJson((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * Serializes an object canonically to a UTF-8 string.
 */
export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(canonicalizeJson(obj));
}

/**
 * Computes a CESR-qualified SHA-256 digest of input with prefix 'E'.
 */
export function computeCesrSha256Digest(data: string | Buffer): string {
  const hash = createHash('sha256').update(data).digest();
  return `E${hash.toString('base64url')}`;
}

export type AuditableRecord = RecordAskAuditDto | AskAudit | AskAuditEntity;

/**
 * Extracts canonical audit facts from an ask audit record or DTO.
 */
export function extractAuditFacts(record: AuditableRecord): Record<string, unknown> {
  return {
    askId: record.askId ?? null,
    askerUserId: record.askerUserId ?? null,
    peerLinkId: record.peerLinkId ?? null,
    peerHandle: record.peerHandle ?? null,
    responderUserId: record.responderUserId ?? null,
    query: record.query,
    consentBasis: record.consentBasis ?? null,
    outcome: record.outcome,
    disclosedCount: record.disclosedCount ?? (record.disclosedEntities ? record.disclosedEntities.length : 0),
    disclosedEntities: record.disclosedEntities ?? [],
  };
}

/**
 * Computes a Self-Addressing Identifier (SAID) for an ask audit entry for
 * cryptographic non-repudiation in KERI / ToIP decentralized trust networks.
 */
export function computeAuditSaid(record: AuditableRecord): string {
  const facts = extractAuditFacts(record);
  const withPlaceholder = { ...facts, d: AUDIT_SAID_PLACEHOLDER };
  const canonical = canonicalStringify(withPlaceholder);
  return computeCesrSha256Digest(Buffer.from(canonical, 'utf8'));
}

/**
 * Verifies that the given audit record matches the provided SAID digest.
 */
export function verifyAuditSaid(record: AuditableRecord, expectedSaid: string): boolean {
  if (typeof expectedSaid !== 'string' || expectedSaid.length !== 44 || !expectedSaid.startsWith('E')) {
    return false;
  }
  return computeAuditSaid(record) === expectedSaid;
}
