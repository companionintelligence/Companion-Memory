import { createHash } from 'node:crypto';

import type { AskAudit, AskAuditEntity } from './entities/AskAuditEntity';
import type { RecordAskAuditDto } from './types';

/**
 * A self-addressing digest of an ask audit row: SHA-256 over the row's canonical JSON with its
 * own digest field (`d`) held at a fixed placeholder, so the digest can sit inside what it covers.
 *
 * ═══ AN INTERNAL DIGEST, NOT A KERI SAID ═══
 *
 * It borrows the SAID construction but not its encoding, so no KERI / ToIP tool will accept it:
 *
 * - CESR's `E` code means Blake3-256 (SHA2-256 is `I`), and a qb64 digest pads the 32 raw bytes
 *   before base64url. This is plain base64url of a SHA-256 digest, with no code at all, so it
 *   cannot be mistaken for one. A real SAID needs Blake3, which this package does not depend on.
 * - The canonical form is sorted-key `JSON.stringify`, close to but not RFC 8785 (JCS): numbers
 *   and string escapes are not normalized the JCS way.
 *
 * Nothing stores or serves these yet. Before one leaves the box, settle the encoding: a digest
 * published in this shape would have to stay in it.
 */

/** Fills `d` while the digest is computed: 44 characters, the width of a qb64 256-bit digest. */
export const AUDIT_SAID_PLACEHOLDER = '#'.repeat(44);

/** Unpadded base64url of 32 bytes. */
const AUDIT_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Deterministically sorts object keys recursively, for a canonical JSON serialization. Not full
 * RFC 8785 (see the note above).
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

/** SHA-256 of `data` as unpadded base64url. No CESR code: see the note above. */
export function sha256Base64url(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('base64url');
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
 * The self-addressing digest of an ask audit entry. Tamper-evident on this box; not a KERI SAID
 * (see the note above), so it proves nothing to a KERI / ToIP verifier.
 */
export function computeAuditSaid(record: AuditableRecord): string {
  const facts = extractAuditFacts(record);
  const withPlaceholder = { ...facts, d: AUDIT_SAID_PLACEHOLDER };
  const canonical = canonicalStringify(withPlaceholder);

  return sha256Base64url(Buffer.from(canonical, 'utf8'));
}

/**
 * Whether the audit record still matches the digest computed for it.
 */
export function verifyAuditSaid(record: AuditableRecord, expectedSaid: string): boolean {
  if (typeof expectedSaid !== 'string' || !AUDIT_DIGEST_PATTERN.test(expectedSaid)) {
    return false;
  }

  return computeAuditSaid(record) === expectedSaid;
}
