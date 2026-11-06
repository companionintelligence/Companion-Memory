import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import { parseRfc3339 } from '../document';

import { canonicalize, DEFAULT_MAX_DEPTH } from './jcs';
import {
  base58btcDecode,
  base64urlEncode,
  multibaseEncode,
  sha256Multihash,
  type MultibaseBase,
} from './multibase';

/**
 * W3C Data Integrity `eddsa-jcs-2022`: Ed25519 over the RFC 8785 canonical form of the document.
 *
 * It is the one cryptosuite SPEC §4.7.1 obliges every Trust Task consumer to verify, so it is the one
 * two independent implementations can interoperate on without prior agreement. The algorithms follow
 * W3C vc-di-eddsa §3.3 ("Create Proof", "Verify Proof", "Proof Configuration"):
 *
 *   proof options = the proof's members except `proofValue`, taken AS RECEIVED
 *   hashData      = SHA-256(JCS(proof options)) ‖ SHA-256(JCS(document without `proof`))
 *   proofValue    = "z" + base58btc(Ed25519.sign(hashData))
 *
 * ═══ `@context` ═══
 *
 * A document that carries a JSON-LD `@context` has it copied INTO the proof options when the proof is
 * created (§3.3.1 step 2; the worked example's emitted proof carries it), so it is signed with them.
 * When a proof is verified, a proof-level `@context` must be a PREFIX of the document's (same values, same
 * order) and is then used for the document too (§3.3.2); a proof with none adds nothing. Nothing is ever
 * injected into the options on the verifier's side, which is what lets proofs from other implementations
 * verify here and ours verify there.
 *
 * Both halves are tested against the W3C worked example byte for byte, including the published secured
 * credential (see `dataIntegrity.spec.ts`).
 *
 * ═══ WHAT VERIFICATION IS GIVEN, AND WHAT IT IS NOT ═══
 *
 * `verifyEddsaJcs2022Proof` takes the document AS RECEIVED — the parsed object, `proof` still on it —
 * and takes the public key from the caller. It does NOT decide whether that key belongs to the issuer,
 * whether the `proofPurpose` is one the issuer authorized, or whether the verification method resolves
 * to the issuer's controller document. Those are SPEC §4.7.3 checks that need a resolver; they live in
 * `consumer.ts`. A true here means only "this key produced this signature over exactly these bytes".
 */

export const DATA_INTEGRITY_PROOF = 'DataIntegrityProof';
export const EDDSA_JCS_2022 = 'eddsa-jcs-2022';

type JsonObject = Record<string, unknown>;

export interface DataIntegrityProof extends JsonObject {
  type: typeof DATA_INTEGRITY_PROOF;
  cryptosuite: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  created?: string;
}

export interface CreateProofOptions {
  /** Absolute verification method id, e.g. `did:keri:D…#D…`. */
  verificationMethod: string;
  privateKey: KeyObject;
  /** The verification relationship the key is authorized for. Trust Tasks sign with `authentication`. */
  proofPurpose?: string;
  /** RFC 3339 instant; omitted from the proof when absent. */
  created?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Bytes(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The document with its top-level `proof` removed, and nothing else changed. */
export function withoutProof(document: JsonObject): JsonObject {
  const copy: JsonObject = { ...document };
  delete copy.proof;

  return copy;
}

function hashData(proofOptions: JsonObject, unsecured: JsonObject): Buffer {
  return Buffer.concat([sha256Bytes(canonicalize(proofOptions)), sha256Bytes(canonicalize(unsecured))]);
}

/** A JSON-LD `@context` as a list: a lone string is a one-element list. */
function contextValues(context: unknown): unknown[] {
  return Array.isArray(context) ? context : [context];
}

/** Whether `document` `@context` starts with every value of `proof` `@context`, in the same order. */
function contextStartsWith(documentContext: unknown, proofContext: unknown): boolean {
  if (documentContext === undefined) {
    return false;
  }

  const document = contextValues(documentContext);
  const proof = contextValues(proofContext);

  return (
    proof.length <= document.length &&
    proof.every((value, index) => canonicalize(value) === canonicalize(document[index]))
  );
}

/** A Node public key for a raw 32-byte Ed25519 key. */
export function ed25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new RangeError('an Ed25519 public key is 32 bytes');
  }

  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(raw) }, format: 'jwk' });
}

/** Sign `unsecured` (a document with no `proof`) and return the proof to attach to it. */
export function createEddsaJcs2022Proof(
  unsecured: JsonObject,
  options: CreateProofOptions,
): DataIntegrityProof {
  if ('proof' in unsecured) {
    throw new TypeError('the document already carries a proof');
  }

  if (options.created !== undefined && parseRfc3339(options.created) === null) {
    throw new TypeError('`created` is not an RFC 3339 date-time');
  }

  const proofOptions: JsonObject = {
    type: DATA_INTEGRITY_PROOF,
    cryptosuite: EDDSA_JCS_2022,
    ...(options.created === undefined ? {} : { created: options.created }),
    verificationMethod: options.verificationMethod,
    proofPurpose: options.proofPurpose ?? 'authentication',
    // §3.3.1 step 2: the document's context is signed with the options and travels in the proof.
    ...(unsecured['@context'] === undefined ? {} : { '@context': unsecured['@context'] }),
  };

  const signature = cryptoSign(null, hashData(proofOptions, unsecured), options.privateKey);

  return { ...proofOptions, proofValue: multibaseEncode('z', signature) } as DataIntegrityProof;
}

/**
 * Whether `publicKey` produced the `proof` on `secured` over exactly these members.
 *
 * Never throws: anything that cannot be verified — an unsupported suite, a malformed `proofValue`, a
 * `created` that is not a date-time, a proof `@context` the document does not start with, a value JCS
 * cannot represent — is simply not verified.
 */
export function verifyEddsaJcs2022Proof(secured: JsonObject, publicKey: KeyObject | Uint8Array): boolean {
  try {
    const proof = secured.proof;
    if (!isRecord(proof) || proof.type !== DATA_INTEGRITY_PROOF || proof.cryptosuite !== EDDSA_JCS_2022) {
      return false;
    }

    const { proofValue, ...proofOptions } = proof;
    if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) {
      return false;
    }

    const signature = base58btcDecode(proofValue.slice(1));
    if (signature == null || signature.length !== 64) {
      return false;
    }

    if (proofOptions.created !== undefined && parseRfc3339(proofOptions.created) === null) {
      return false;
    }

    const unsecured = withoutProof(secured);
    if (proofOptions['@context'] !== undefined) {
      // §3.3.2: the document must start with the proof's context, and is then hashed with exactly it.
      if (!contextStartsWith(secured['@context'], proofOptions['@context'])) {
        return false;
      }

      unsecured['@context'] = proofOptions['@context'];
    }

    const key = publicKey instanceof Uint8Array ? ed25519PublicKeyFromRaw(publicKey) : publicKey;

    return cryptoVerify(null, hashData(proofOptions, unsecured), key, signature);
  } catch {
    return false;
  }
}

/**
 * The task digest of SPEC §4.9.3: `multibase(multihash(SHA-256(JCS(document ∖ proof))))`.
 *
 * It names WHAT A DOCUMENT SAYS, so the same statement signed, unsigned or re-signed has one digest.
 * It is not the duplicate-execution identity — see {@link documentDigest}.
 */
export function taskDigest(document: JsonObject, base: MultibaseBase = 'u'): string {
  const digest = createHash('sha256')
    .update(canonicalize(withoutProof(document)), 'utf8')
    .digest();

  return multibaseEncode(base, sha256Multihash(digest));
}

/**
 * The identity of a document AS RECEIVED, `proof` included (SPEC §7.2 item 11, "Keying and
 * comparison"): two arrivals under one `id` are the same document only when their RFC 8785
 * serializations are identical, so a re-signed copy over identical content is a DIFFERENT document —
 * the `idConflict` case.
 *
 * The `proof` is one level deeper than the document it covers, so the depth bound is one larger than the
 * one proof verification used: a document that verified must not then fail to be identified.
 */
export function documentDigest(document: JsonObject): string {
  return createHash('sha256')
    .update(canonicalize(document, DEFAULT_MAX_DEPTH + 1), 'utf8')
    .digest('base64url');
}
