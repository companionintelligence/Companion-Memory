import { createCipheriv, createDecipheriv, createHash, diffieHellman, type KeyObject } from 'node:crypto';

import { lengthPrefixed, uint32be, utf8Encode } from './encoding';
import { DidcommError } from './errors';

/**
 * Key agreement and key wrapping for JWE: ECDH-ES+A256KW (RFC 7518 §4.6) for anoncrypt and
 * ECDH-1PU+A256KW (draft-madden-jose-ecdh-1pu-04) for authcrypt.
 *
 * Both derive a 256-bit key-encryption key with the NIST SP 800-56A Concat KDF over SHA-256 and
 * wrap the content encryption key with AES-256 Key Wrap (RFC 3394). They differ in two ways, both
 * pinned by the DIDComm specification's own test vectors in `jwe.spec.ts`:
 *
 *   - ES: Z = ECDH(ephemeral, recipient).
 *     1PU: Z = ECDH(ephemeral, recipient) ‖ ECDH(sender static, recipient), which is what
 *     authenticates the sender: only the holder of the static private key can compute the second half.
 *   - 1PU also feeds the content-encryption authentication tag into the KDF, as
 *     `len(tag) ‖ tag` after the 32-bit key length in SuppPubInfo. That is why a 1PU JWE must be
 *     encrypted *before* its content key can be wrapped, and why it needs a key-committing `enc`.
 */

export type KeyWrapAlgorithm = 'ECDH-ES+A256KW' | 'ECDH-1PU+A256KW';

const KEY_WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

/**
 * Diffie-Hellman over X25519 or a NIST curve. A zero result is refused: it means the peer's public
 * key was a small-order point (X25519 clamps the scalar to a multiple of the cofactor, so every
 * such point collapses to zero), and a shared secret every peer can compute is no secret.
 */
export function ecdh(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  let secret: Buffer;

  try {
    secret = diffieHellman({ privateKey, publicKey });
  } catch {
    throw new DidcommError('invalid-key', 'key agreement failed');
  }

  if (secret.every((byte) => byte === 0)) {
    throw new DidcommError('invalid-key', 'key agreement produced a degenerate secret');
  }

  return secret;
}

export interface ConcatKdfInput {
  /** The shared secret Z. */
  z: Buffer;
  /** AlgorithmID: the JWE `alg` for key wrapping, `enc` for direct agreement. */
  algorithmId: string;
  /** PartyUInfo (decoded `apu`), empty for ES. */
  apu: Buffer;
  /** PartyVInfo (decoded `apv`). */
  apv: Buffer;
  /** Derived key length in bits. A single SHA-256 block caps this at 256. */
  keyBits: number;
  /** ECDH-1PU only: the content-encryption authentication tag. */
  tag?: Buffer;
}

/**
 * Concat KDF (SP 800-56A, single-step, SHA-256) with the JOSE field layout of RFC 7518 §4.6.2:
 * `counter ‖ Z ‖ len(AlgorithmID) ‖ AlgorithmID ‖ len(apu) ‖ apu ‖ len(apv) ‖ apv ‖ SuppPubInfo`.
 * Pinned to RFC 7518 Appendix C.
 */
export function concatKdfSha256(input: ConcatKdfInput): Buffer {
  if (input.keyBits <= 0 || input.keyBits > 256 || input.keyBits % 8 !== 0) {
    throw new DidcommError('invalid-argument', 'Concat KDF output is 8 to 256 bits here');
  }

  const suppPubInfo = input.tag
    ? Buffer.concat([uint32be(input.keyBits), lengthPrefixed(input.tag)])
    : uint32be(input.keyBits);

  const digest = createHash('sha256')
    .update(uint32be(1))
    .update(input.z)
    .update(lengthPrefixed(utf8Encode(input.algorithmId)))
    .update(lengthPrefixed(input.apu))
    .update(lengthPrefixed(input.apv))
    .update(suppPubInfo)
    .digest();

  return digest.subarray(0, input.keyBits / 8);
}

/** The 256-bit key-encryption key for A256KW. `zs` is present exactly when the algorithm is ECDH-1PU. */
export function deriveKeyEncryptionKey(input: {
  alg: KeyWrapAlgorithm;
  ze: Buffer;
  zs?: Buffer;
  apu: Buffer;
  apv: Buffer;
  tag?: Buffer;
}): Buffer {
  const onePu = input.alg === 'ECDH-1PU+A256KW';

  if (onePu !== (input.zs !== undefined) || onePu !== (input.tag !== undefined)) {
    throw new DidcommError(
      'invalid-argument',
      'ECDH-1PU needs the static secret and the content tag; ECDH-ES takes neither',
    );
  }

  return concatKdfSha256({
    z: input.zs ? Buffer.concat([input.ze, input.zs]) : input.ze,
    algorithmId: input.alg,
    apu: input.apu,
    apv: input.apv,
    keyBits: 256,
    tag: input.tag,
  });
}

/** AES-256 Key Wrap (RFC 3394) with the default IV. */
export function aesKeyWrap(kek: Buffer, key: Buffer): Buffer {
  if (kek.length !== 32 || key.length < 16 || key.length % 8 !== 0) {
    throw new DidcommError(
      'invalid-argument',
      'AES key wrap takes a 256-bit KEK and a key of 16+ bytes in 8-byte steps',
    );
  }

  const cipher = createCipheriv('id-aes256-wrap', kek, KEY_WRAP_IV);
  return Buffer.concat([cipher.update(key), cipher.final()]);
}

/** Unwraps and checks the RFC 3394 integrity value. Any failure is the same `decryption-failed`. */
export function aesKeyUnwrap(kek: Buffer, wrapped: Buffer): Buffer {
  if (kek.length !== 32 || wrapped.length < 24 || wrapped.length % 8 !== 0) {
    throw new DidcommError('decryption-failed', 'the message could not be decrypted');
  }

  try {
    const decipher = createDecipheriv('id-aes256-wrap', kek, KEY_WRAP_IV);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    throw new DidcommError('decryption-failed', 'the message could not be decrypted');
  }
}
