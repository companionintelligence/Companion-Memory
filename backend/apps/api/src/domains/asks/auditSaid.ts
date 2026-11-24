import { createHash } from 'node:crypto';

import { canonicalizeJcs } from '@ci/common/crypto';

import type { AskAudit, AskAuditEntity } from './entities/AskAuditEntity';
import type { RecordAskAuditDto } from './types';

/**
 * Self-Addressing Identifier (SAID) and Merkle batch anchoring for ask audit records.
 *
 * Uses RFC 8785 JSON Canonicalization Scheme (JCS) and CESR `I` (SHA2-256) qb64 encoding:
 * 1 zero lead byte prepended to the 32-byte SHA-256 digest produces 33 bytes (44 base64url
 * characters), with the leading `A` (0x00 >> 2) replaced by the CESR 1-character derivation code `I`.
 */

/** Fills `d` while the digest is computed: 44 characters, the width of a qb64 256-bit digest. */
export const AUDIT_SAID_PLACEHOLDER = '#'.repeat(44);

/** CESR `I` (SHA2-256) qb64 pattern: `I` followed by 43 base64url characters. */
const CESR_SHA256_SAID_PATTERN = /^I[A-Za-z0-9_-]{43}$/;

/** Legacy 43-char unpadded base64url digest pattern (kept only for backward-compatible verification). */
const LEGACY_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Encodes a 32-byte SHA-256 digest as a CESR `I` qb64 string (44 characters). */
export function encodeCesrSha256(digest: Buffer): string {
  if (digest.length !== 32) {
    throw new Error(`Expected 32-byte SHA-256 digest, got ${digest.length}`);
  }

  const padded = Buffer.concat([Buffer.from([0]), digest]).toString('base64url');

  return `I${padded.slice(1)}`;
}

/** Computes the CESR `I` (SHA2-256) qb64 digest of `data`. */
export function cesrSha256(data: string | Buffer): string {
  const digest = createHash('sha256').update(data).digest();

  return encodeCesrSha256(digest);
}

/** Legacy unpadded SHA-256 base64url helper retained for backward-compatible verification. */
export function sha256Base64url(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('base64url');
}

/** Canonicalizes `obj` according to RFC 8785 (JCS). */
export function canonicalStringify(obj: unknown): string {
  return canonicalizeJcs(obj);
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
 * Computes the CESR `I` (SHA2-256) SAID over the RFC 8785 JCS-canonicalized audit facts.
 */
export function computeAuditSaid(record: AuditableRecord): string {
  const facts = extractAuditFacts(record);
  const withPlaceholder = { ...facts, d: AUDIT_SAID_PLACEHOLDER };
  const canonical = canonicalStringify(withPlaceholder);

  return cesrSha256(Buffer.from(canonical, 'utf8'));
}

/**
 * Verifies that an audit record matches its expected CESR `I` SAID (or legacy 43-char digest).
 */
export function verifyAuditSaid(record: AuditableRecord, expectedSaid: string): boolean {
  if (typeof expectedSaid !== 'string') {
    return false;
  }

  if (CESR_SHA256_SAID_PATTERN.test(expectedSaid)) {
    return computeAuditSaid(record) === expectedSaid;
  }

  if (LEGACY_DIGEST_PATTERN.test(expectedSaid)) {
    const facts = extractAuditFacts(record);
    const canonical = canonicalStringify({ ...facts, d: AUDIT_SAID_PLACEHOLDER });

    return sha256Base64url(Buffer.from(canonical, 'utf8')) === expectedSaid;
  }

  return false;
}

export interface AuditMerkleProofStep {
  position: 'left' | 'right';
  digest: string;
}

function hashMerklePair(left: string, right: string): string {
  return cesrSha256(Buffer.from(`node:${left}:${right}`, 'utf8'));
}

function hashMerkleLeaf(said: string): string {
  return cesrSha256(Buffer.from(`leaf:${said}`, 'utf8'));
}

/**
 * Computes a deterministic CESR `I` Merkle root over a batch of audit SAIDs for KEL/ledger anchoring.
 */
export function computeAuditMerkleRoot(saids: readonly string[]): string | null {
  if (saids.length === 0) {
    return null;
  }

  let level = saids.map(hashMerkleLeaf);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(hashMerklePair(left, right));
    }

    level = next;
  }

  return level[0]!;
}

/**
 * Builds an inclusion proof for the audit SAID at `index` within `saids`.
 */
export function buildAuditMerkleProof(saids: readonly string[], index: number): AuditMerkleProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= saids.length) {
    throw new RangeError(`Merkle index ${index} out of bounds for batch size ${saids.length}`);
  }

  const proof: AuditMerkleProofStep[] = [];
  let level = saids.map(hashMerkleLeaf);
  let idx = index;

  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = level[siblingIdx] ?? level[idx]!;
    proof.push({
      position: isRight ? 'left' : 'right',
      digest: sibling,
    });

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(hashMerklePair(left, right));
    }

    level = next;
    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Verifies an audit SAID's Merkle inclusion proof against an anchored Merkle root.
 */
export function verifyAuditMerkleProof(
  said: string,
  proof: readonly AuditMerkleProofStep[],
  expectedRoot: string,
): boolean {
  if (
    !CESR_SHA256_SAID_PATTERN.test(said) ||
    !CESR_SHA256_SAID_PATTERN.test(expectedRoot) ||
    !Array.isArray(proof)
  ) {
    return false;
  }

  let current = hashMerkleLeaf(said);
  for (const step of proof) {
    if (
      !step ||
      (step.position !== 'left' && step.position !== 'right') ||
      !CESR_SHA256_SAID_PATTERN.test(step.digest)
    ) {
      return false;
    }

    current =
      step.position === 'left' ? hashMerklePair(step.digest, current) : hashMerklePair(current, step.digest);
  }

  return current === expectedRoot;
}
