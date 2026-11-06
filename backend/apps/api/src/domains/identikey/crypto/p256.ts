import {
  ECDH,
  createECDH,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * ECDSA over NIST P-256 with SHA-256, in IdentiKey's wire forms: a 33-byte COMPRESSED SEC1 public key
 * and a 64-byte fixed-width `r || s` signature.
 *
 * P-256 is the hardware common denominator (the only asymmetric type the Apple Secure Enclave holds,
 * and supported by TPM 2.0 and Android StrongBox), so this is the algorithm an enclave-backed
 * identity uses; Ed25519 is for software identities. See identikey-auth-challenge-v1 §3.1.
 *
 * Only the COMPRESSED form is accepted. The Rust reference also takes a 65-byte uncompressed point,
 * but a fingerprint is a hash of the key's bytes: two encodings of one key would be two identities.
 * Signers always emit the compressed form, so honest peers are unaffected.
 */

export const P256_KEY_LENGTH = 33;
export const P256_SIGNATURE_LENGTH = 64;

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A verifying key from a compressed point, or null when it is not a valid point on the curve. */
function publicKeyObject(compressed: Uint8Array): KeyObject | null {
  if (compressed.length !== P256_KEY_LENGTH || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    return null;
  }

  try {
    // OpenSSL decompresses the point and refuses one that is not on the curve.
    const uncompressed = ECDH.convertKey(
      Buffer.from(compressed),
      'prime256v1',
      undefined,
      undefined,
      'uncompressed',
    ) as Buffer;

    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64u(uncompressed.subarray(1, 33)),
        y: b64u(uncompressed.subarray(33, 65)),
      },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/** Whether `compressed` is a well-formed point on the curve. */
export function isUsableP256Key(compressed: Uint8Array): boolean {
  return publicKeyObject(compressed) !== null;
}

/** Verify `r || s` over `message` (hashed with SHA-256) under the compressed public key. Never throws. */
export function verifyP256(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== P256_SIGNATURE_LENGTH) {
    return false;
  }

  const key = publicKeyObject(publicKey);
  if (key === null) {
    return false;
  }

  try {
    return nodeVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** A P-256 key pair rebuilt from its 32-byte secret scalar. */
export function p256FromSecret(secret: Uint8Array): {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
} {
  const ecdh = createECDH('prime256v1');
  // Throws for 0 and for anything not below the group order.
  ecdh.setPrivateKey(Buffer.from(secret));

  const uncompressed = ecdh.getPublicKey(null, 'uncompressed');
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(secret),
      x: b64u(uncompressed.subarray(1, 33)),
      y: b64u(uncompressed.subarray(33, 65)),
    },
    format: 'jwk',
  });

  return {
    publicKey: new Uint8Array(ecdh.getPublicKey(null, 'compressed')),
    // Random-nonce ECDSA, as OpenSSL does it. (The Rust reference signs with RFC 6979 nonces, so its
    // P-256 fixtures cannot be reproduced byte for byte here, only verified.)
    sign: (message) =>
      new Uint8Array(nodeSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
  };
}
