import { blake3Hash } from '../crypto/blake3';
import { ED25519_KEY_LENGTH, ED25519_SIGNATURE_LENGTH, isUsableEd25519Key } from '../crypto/ed25519';
import { ML_DSA } from '../crypto/mlDsa';
import { P256_KEY_LENGTH, P256_SIGNATURE_LENGTH, isUsableP256Key } from '../crypto/p256';
import { base58Decode, base58Encode } from '../encoding/base58';
import { asBytes, asText, cbor, closedMap, encode, type Cbor } from '../encoding/dcbor';
import { IdentiKeyError } from '../errors';

import { classicalAlgFromTag, pqAlgFromTag, type ClassicalAlg, type PqAlg } from './algorithms';

/**
 * Self-describing public keys and signatures, and the fingerprint that names an identity
 * (identikey-auth-challenge-v1 §3.2 and §5).
 *
 * A value of one of these types is WELL-FORMED: its bytes are the right length for its algorithm, a
 * P-256 key is a point on the curve, an Ed25519 key is neither weak nor non-canonical. The checks
 * happen in the constructors, which is where everything from the wire passes through, so the verifier
 * never has to wonder whether it is holding a real key.
 */

export interface ClassicalPublicKey {
  readonly alg: ClassicalAlg;
  readonly bytes: Uint8Array;
}

export interface ClassicalSignature {
  readonly alg: ClassicalAlg;
  readonly bytes: Uint8Array;
}

export interface PqPublicKey {
  readonly alg: PqAlg;
  readonly bytes: Uint8Array;
}

export interface PqSignature {
  readonly alg: PqAlg;
  readonly bytes: Uint8Array;
}

// ─── constructors ────────────────────────────────────────────────────────────

export function classicalPublicKey(alg: ClassicalAlg, bytes: Uint8Array): ClassicalPublicKey {
  const usable =
    alg === 'ed25519'
      ? bytes.length === ED25519_KEY_LENGTH && isUsableEd25519Key(bytes)
      : bytes.length === P256_KEY_LENGTH && isUsableP256Key(bytes);
  if (!usable) {
    throw new IdentiKeyError('bad-key', `not a usable ${alg} public key`);
  }

  return { alg, bytes: new Uint8Array(bytes) };
}

export function classicalSignature(alg: ClassicalAlg, bytes: Uint8Array): ClassicalSignature {
  const length = alg === 'ed25519' ? ED25519_SIGNATURE_LENGTH : P256_SIGNATURE_LENGTH;
  if (bytes.length !== length) {
    throw new IdentiKeyError('bad-signature', `a ${alg} signature is ${length} bytes`);
  }

  return { alg, bytes: new Uint8Array(bytes) };
}

export function pqPublicKey(alg: PqAlg, bytes: Uint8Array): PqPublicKey {
  if (bytes.length !== ML_DSA[alg].publicKey) {
    throw new IdentiKeyError('bad-key', `a ${alg} public key is ${ML_DSA[alg].publicKey} bytes`);
  }

  return { alg, bytes: new Uint8Array(bytes) };
}

export function pqSignature(alg: PqAlg, bytes: Uint8Array): PqSignature {
  if (bytes.length !== ML_DSA[alg].signature) {
    throw new IdentiKeyError('bad-signature', `a ${alg} signature is ${ML_DSA[alg].signature} bytes`);
  }

  return { alg, bytes: new Uint8Array(bytes) };
}

// ─── the wire forms: { "alg": tstr, "key": bstr } and { "alg": tstr, "sig": bstr } ───────

const tagged = (alg: string, field: 'key' | 'sig', bytes: Uint8Array): Cbor =>
  cbor.map([
    ['alg', cbor.text(alg)],
    [field, cbor.bytes(bytes)],
  ]);

function untag(value: Cbor, field: 'key' | 'sig'): { tag: string; bytes: Uint8Array } {
  const members = closedMap(value, ['alg', field]);

  return { tag: asText(requireMember(members, 'alg')), bytes: asBytes(requireMember(members, field)) };
}

/** `closedMap` has already guaranteed presence; this keeps the type honest without a `!`. */
export function requireMember(members: ReadonlyMap<string, Cbor>, key: string): Cbor {
  const value = members.get(key);
  if (value === undefined) {
    throw new IdentiKeyError('malformed', `missing member "${key}"`);
  }

  return value;
}

export const publicKeyToCbor = (key: ClassicalPublicKey | PqPublicKey): Cbor =>
  tagged(key.alg, 'key', key.bytes);

export const signatureToCbor = (signature: ClassicalSignature | PqSignature): Cbor =>
  tagged(signature.alg, 'sig', signature.bytes);

export function classicalPublicKeyFromCbor(value: Cbor): ClassicalPublicKey {
  const { tag, bytes } = untag(value, 'key');

  return classicalPublicKey(classicalAlgFromTag(tag), bytes);
}

export function classicalSignatureFromCbor(value: Cbor): ClassicalSignature {
  const { tag, bytes } = untag(value, 'sig');

  return classicalSignature(classicalAlgFromTag(tag), bytes);
}

export function pqPublicKeyFromCbor(value: Cbor): PqPublicKey {
  const { tag, bytes } = untag(value, 'key');

  return pqPublicKey(pqAlgFromTag(tag), bytes);
}

export function pqSignatureFromCbor(value: Cbor): PqSignature {
  const { tag, bytes } = untag(value, 'sig');

  return pqSignature(pqAlgFromTag(tag), bytes);
}

// ─── fingerprints ────────────────────────────────────────────────────────────

/**
 * The identity fingerprint: `Blake3(dCBOR({ "alg": <alg>, "key": <bytes> }))`, 32 bytes.
 *
 * It commits to the ALGORITHM as well as the key, so the same 32 bytes read as Ed25519 and as anything
 * else name two identities. NOTE that this is not the same function as the fingerprint the wallet
 * format and the Recrypt library use (`Blake3(raw Ed25519 public key)`): identikey itself carries both
 * definitions. Do not compare the two.
 */
export function fingerprintOf(key: ClassicalPublicKey): Uint8Array {
  return blake3Hash(encode(publicKeyToCbor(key)));
}

/** Fingerprints are displayed as Bitcoin-alphabet base58 (identikey `encoding-conventions.md` §3). */
export function fingerprintToBase58(fingerprint: Uint8Array): string {
  if (fingerprint.length !== 32) {
    throw new IdentiKeyError('malformed', 'a fingerprint is 32 bytes');
  }

  return base58Encode(fingerprint);
}

export function fingerprintFromBase58(text: string): Uint8Array {
  const bytes = base58Decode(text);
  if (bytes.length !== 32) {
    throw new IdentiKeyError('malformed', 'a fingerprint is 32 bytes');
  }

  return bytes;
}

// ─── comparison ──────────────────────────────────────────────────────────────

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

export function pqPublicKeysEqual(a: PqPublicKey, b: PqPublicKey): boolean {
  return a.alg === b.alg && bytesEqual(a.bytes, b.bytes);
}

// ─── bridge to the Ed25519 JWKs the rest of Companion-Memory already holds ────────────────

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

/**
 * An Ed25519 identity from a public JWK, as `peers` stores them. Strict: the `x` must be unpadded
 * base64url of exactly 32 bytes, spelled the one canonical way.
 */
export function ed25519KeyFromJwk(jwk: { kty?: unknown; crv?: unknown; x?: unknown }): ClassicalPublicKey {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new IdentiKeyError('bad-key', 'not an Ed25519 public JWK');
  }

  const bytes = Buffer.from(jwk.x, 'base64url');
  if (bytes.toString('base64url') !== jwk.x) {
    throw new IdentiKeyError('bad-key', 'JWK "x" is not canonical base64url');
  }

  return classicalPublicKey('ed25519', bytes);
}

export function ed25519JwkOf(key: ClassicalPublicKey): Ed25519PublicJwk {
  if (key.alg !== 'ed25519') {
    throw new IdentiKeyError('bad-key', `${key.alg} has no OKP/Ed25519 JWK form`);
  }

  return { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key.bytes).toString('base64url') };
}
