import { verifyEd25519 } from '../crypto/ed25519';
import { verifyMlDsa } from '../crypto/mlDsa';
import { verifyP256 } from '../crypto/p256';

import type { ClassicalPublicKey, ClassicalSignature, PqPublicKey, PqSignature } from './keys';

/**
 * Signature checks over an already-built payload. Both return a plain boolean and never throw: a
 * signature that does not verify is an expected input from the network, not an exceptional one.
 *
 * A key and a signature that name different algorithms never verify, whatever their bytes are.
 */
export function verifyClassical(
  key: ClassicalPublicKey,
  payload: Uint8Array,
  signature: ClassicalSignature,
): boolean {
  if (key.alg !== signature.alg) {
    return false;
  }

  return key.alg === 'ed25519'
    ? verifyEd25519(key.bytes, payload, signature.bytes)
    : verifyP256(key.bytes, payload, signature.bytes);
}

export function verifyPq(key: PqPublicKey, payload: Uint8Array, signature: PqSignature): boolean {
  if (key.alg !== signature.alg) {
    return false;
  }

  return verifyMlDsa(key.alg, key.bytes, payload, signature.bytes);
}
