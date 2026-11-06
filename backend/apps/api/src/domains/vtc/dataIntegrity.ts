import { createHash } from 'node:crypto';

import { parseDateTime } from './dateTime';
import { verifyEd25519, type Signer } from './ed25519';
import { canonicalize, JcsError } from './jcs';
import { isPlainObject, type JsonObject } from './json';
import type { KeyResolver } from './keyResolver';
import { decodeMultibaseBase58btc, encodeMultibaseBase58btc, MultibaseError } from './multibase';

/**
 * W3C Verifiable Credential Data Integrity: the `eddsa-jcs-2022` cryptosuite
 * (https://www.w3.org/TR/vc-di-eddsa/, §3.3).
 *
 * The signature covers 64 bytes, in this order:
 *
 *     SHA-256(JCS(proof options))  ||  SHA-256(JCS(document without its proof))
 *
 * where the proof options are the proof object without its `proofValue`, plus the document's
 * `@context` when it has one. `proofValue` is the Ed25519 signature in Multibase base58btc.
 *
 * `dataIntegrity.spec.ts` reproduces every intermediate value of the specification's Appendix B.3
 * test vector, including the signature, from the published secret key.
 *
 * ═══ WHAT THIS DOES NOT DECIDE ═══
 *
 * Whether the verification method is allowed to sign for the issuer. That is the `KeyResolver`'s
 * job, because it depends on the issuer's DID method: a `did:key` authorizes only its own key, a
 * pinned community lists its keys. A signature that verifies under a key nobody authorized proves
 * nothing, so a resolver answers `null` for anything it cannot tie to the issuer.
 *
 * One proof per document. A proof set or chain is refused, not partly read, and so is a single
 * proof that names a condition this module does not enforce: `previousProof`, `domain`,
 * `challenge`, `nonce` or `expires` (the members are signed, so they cannot be stripped, but
 * accepting the signature while ignoring them would mean something the signer did not). The
 * proof's `created` is checked to be a date-time and nothing more.
 *
 * Deliberately STRICTER than the W3C algorithm in one place: when the proof carries an `@context`
 * it must be identical to the document's. The specification only requires the document's to START
 * WITH the proof's and then hashes the proof's, so a proof it accepts can be refused here. That
 * fails closed, and the credentials this module reads and writes never differ.
 *
 * A proof with NO `@context` is verified over its options as they are, as the specification's
 * verification does (only creation copies the document's `@context` into the proof, and
 * `createProof` always does).
 */

export const EDDSA_JCS_2022 = 'eddsa-jcs-2022';

/** Proof members that put a condition on the proof which this module does not enforce. */
const UNENFORCED_PROOF_MEMBERS: readonly string[] = [
  'previousProof',
  'domain',
  'challenge',
  'nonce',
  'expires',
];

export interface DataIntegrityProof extends JsonObject {
  type: 'DataIntegrityProof';
  cryptosuite: typeof EDDSA_JCS_2022;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  created?: string;
}

export type ProofFailure =
  | 'PROOF_MISSING'
  | 'PROOF_MALFORMED'
  | 'PROOF_UNSUPPORTED'
  | 'PROOF_PURPOSE_MISMATCH'
  | 'PROOF_CONTEXT_MISMATCH'
  | 'PROOF_KEY_UNRESOLVED'
  | 'PROOF_SIGNATURE_INVALID';

export type ProofResult =
  | { ok: true; proof: DataIntegrityProof; verificationMethod: string }
  | { ok: false; code: ProofFailure; detail?: string };

export interface VerifyProofOptions {
  resolveKey: KeyResolver;
  /** The purpose the proof must declare. Credentials are signed for `assertionMethod`. */
  proofPurpose?: string;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The 64 bytes that get signed: the proof-options hash first, then the document hash. */
function hashData(proofOptions: JsonObject, unsecured: JsonObject): Buffer {
  return Buffer.concat([sha256(canonicalize(proofOptions)), sha256(canonicalize(unsecured))]);
}

function issuerOf(document: JsonObject): string {
  const { issuer } = document;
  if (typeof issuer === 'string') {
    return issuer;
  }

  return isPlainObject(issuer) && typeof issuer.id === 'string' ? issuer.id : '';
}

function failure(code: ProofFailure, detail?: string): ProofResult {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

/** Creates the proof for `unsecured`. Throws if the document already carries one. */
export async function createProof(
  unsecured: JsonObject,
  signer: Signer,
  options: { created: Date; proofPurpose?: string },
): Promise<DataIntegrityProof> {
  if ('proof' in unsecured) {
    throw new Error('the document already carries a proof');
  }

  const proofOptions: JsonObject = {
    type: 'DataIntegrityProof',
    cryptosuite: EDDSA_JCS_2022,
    created: options.created.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    verificationMethod: signer.verificationMethod,
    proofPurpose: options.proofPurpose ?? 'assertionMethod',
  };

  if (unsecured['@context'] !== undefined) {
    proofOptions['@context'] = unsecured['@context'];
  }

  const signature = await signer.sign(hashData(proofOptions, unsecured));
  if (signature.length !== 64) {
    throw new Error('the signer did not return a 64-byte Ed25519 signature');
  }

  return { ...proofOptions, proofValue: encodeMultibaseBase58btc(signature) } as DataIntegrityProof;
}

/** `unsecured` with its proof attached. */
export async function secureDocument(
  unsecured: JsonObject,
  signer: Signer,
  options: { created: Date; proofPurpose?: string },
): Promise<JsonObject> {
  return { ...unsecured, proof: await createProof(unsecured, signer, options) };
}

/**
 * Verifies the one proof on `secured`. Every refusal is a returned code, never a throw, so a caller
 * cannot turn an exception path into an acceptance.
 */
export async function verifyProof(secured: unknown, options: VerifyProofOptions): Promise<ProofResult> {
  if (!isPlainObject(secured)) {
    return failure('PROOF_MALFORMED', 'the document is not an object');
  }

  const { proof, ...unsecured } = secured;
  if (proof === undefined) {
    return failure('PROOF_MISSING');
  }

  if (!isPlainObject(proof)) {
    return failure(
      'PROOF_MALFORMED',
      Array.isArray(proof) ? 'proof sets are not supported' : 'proof is not an object',
    );
  }

  if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== EDDSA_JCS_2022) {
    return failure('PROOF_UNSUPPORTED', 'only DataIntegrityProof with eddsa-jcs-2022 is supported');
  }

  const { proofValue, verificationMethod } = proof;
  if (typeof proofValue !== 'string' || typeof verificationMethod !== 'string') {
    return failure('PROOF_MALFORMED', 'proofValue and verificationMethod must be strings');
  }

  const unenforced = UNENFORCED_PROOF_MEMBERS.find((member) => member in proof);
  if (unenforced !== undefined) {
    return failure('PROOF_UNSUPPORTED', `the proof names ${unenforced}, which is not enforced here`);
  }

  if (proof.created !== undefined && parseDateTime(proof.created) === null) {
    return failure('PROOF_MALFORMED', 'created is not a date-time');
  }

  if (proof.proofPurpose !== (options.proofPurpose ?? 'assertionMethod')) {
    return failure('PROOF_PURPOSE_MISMATCH');
  }

  let signature: Uint8Array;
  try {
    signature = decodeMultibaseBase58btc(proofValue);
  } catch (error) {
    return failure('PROOF_MALFORMED', error instanceof MultibaseError ? error.message : 'proofValue');
  }

  if (signature.length !== 64) {
    return failure('PROOF_MALFORMED', 'proofValue is not a 64-byte signature');
  }

  const { proofValue: _removed, ...proofOptions } = proof;

  let data: Buffer;
  try {
    if (
      proofOptions['@context'] !== undefined &&
      canonicalize(proofOptions['@context']) !== canonicalize(unsecured['@context'])
    ) {
      return failure('PROOF_CONTEXT_MISMATCH');
    }

    data = hashData(proofOptions, unsecured);
  } catch (error) {
    if (error instanceof JcsError) {
      return failure('PROOF_MALFORMED', error.message);
    }

    throw error;
  }

  const publicKey = await options.resolveKey({ issuer: issuerOf(unsecured), verificationMethod });
  if (!publicKey) {
    return failure('PROOF_KEY_UNRESOLVED');
  }

  if (!verifyEd25519(publicKey, data, signature)) {
    return failure('PROOF_SIGNATURE_INVALID');
  }

  return { ok: true, proof: proof as DataIntegrityProof, verificationMethod };
}
