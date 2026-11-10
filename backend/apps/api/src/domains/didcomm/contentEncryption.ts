import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { constantTimeEqual } from './encoding';
import { DidcommError } from './errors';

/**
 * Content encryption for JWE: the three `enc` values DIDComm Messaging v2.1 defines.
 *
 *   - `A256CBC-HS512` (RFC 7518 §5.2.5): required, and the only one allowed under authcrypt, because
 *     ECDH-1PU needs a key-committing AEAD. The default for everything this domain sends: it is also
 *     the only `enc` the Affinidi `affinidi-messaging-didcomm` crate that OpenVTC's mediator and VTA
 *     use will decrypt.
 *   - `A256GCM`: recommended for anoncrypt.
 *   - `XC20P` (XChaCha20-Poly1305): optional, anoncrypt only. Node has ChaCha20-Poly1305 but not the
 *     extended-nonce variant, so the subkey is derived with HChaCha20 below.
 *
 * Decryption authenticates before it decrypts and reports every failure the same way.
 */

export type ContentEncryption = 'A256CBC-HS512' | 'A256GCM' | 'XC20P';

interface EncSpec {
  /** Content encryption key length in bytes. */
  cekBytes: number;
  ivBytes: number;
  tagBytes: number;
}

const SPECS: Record<ContentEncryption, EncSpec> = {
  'A256CBC-HS512': { cekBytes: 64, ivBytes: 16, tagBytes: 32 },
  A256GCM: { cekBytes: 32, ivBytes: 12, tagBytes: 16 },
  XC20P: { cekBytes: 32, ivBytes: 24, tagBytes: 16 },
};

export interface EncryptedContent {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function isContentEncryption(value: unknown): value is ContentEncryption {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SPECS, value);
}

export function contentEncryptionSpec(enc: ContentEncryption): Readonly<EncSpec> {
  return SPECS[enc];
}

export function generateCek(enc: ContentEncryption): Buffer {
  return randomBytes(SPECS[enc].cekBytes);
}

function failed(): DidcommError {
  return new DidcommError('decryption-failed', 'the message could not be decrypted');
}

// ─── HChaCha20 / XChaCha20-Poly1305 ──────────────────────────────────────────────────────────

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotateLeft(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotateLeft(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotateLeft(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotateLeft(s[b] ^ s[c], 7);
}

/**
 * HChaCha20 (draft-irtf-cfrg-xchacha-03 §2.2): 20 ChaCha rounds over (constants, key, 16-byte
 * nonce), output words 0–3 and 12–15 with no feed-forward addition. Pinned to the draft's §2.2.1
 * test vector in `contentEncryption.spec.ts`.
 */
export function hchacha20(key: Uint8Array, nonce: Uint8Array): Buffer {
  if (key.length !== 32 || nonce.length !== 16) {
    throw new DidcommError('invalid-argument', 'HChaCha20 takes a 32-byte key and a 16-byte nonce');
  }

  const keyBuffer = Buffer.from(key);
  const nonceBuffer = Buffer.from(nonce);
  const state = new Uint32Array(16);

  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = keyBuffer.readUInt32LE(index * 4);
  }

  for (let index = 0; index < 4; index += 1) {
    state[12 + index] = nonceBuffer.readUInt32LE(index * 4);
  }

  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }

  const out = Buffer.alloc(32);

  for (let index = 0; index < 4; index += 1) {
    out.writeUInt32LE(state[index], index * 4);
    out.writeUInt32LE(state[12 + index], 16 + index * 4);
  }

  return out;
}

function xchachaParts(key: Buffer, nonce: Buffer): { subkey: Buffer; nonce: Buffer } {
  return {
    subkey: hchacha20(key, nonce.subarray(0, 16)),
    // ChaCha20-Poly1305's 96-bit nonce: four zero bytes, then the last eight bytes of the XChaCha nonce.
    nonce: Buffer.concat([Buffer.alloc(4), nonce.subarray(16, 24)]),
  };
}

// ─── encrypt / decrypt ───────────────────────────────────────────────────────────────────────

/**
 * Encrypts `plaintext` with the (random, per-message) content encryption key. `iv` is injectable
 * so known-answer tests can pin the output; production callers leave it out.
 */
export function encryptContent(
  enc: ContentEncryption,
  cek: Buffer,
  plaintext: Uint8Array,
  aad: Uint8Array,
  iv: Buffer = randomBytes(SPECS[enc].ivBytes),
): EncryptedContent {
  const spec = SPECS[enc];

  if (cek.length !== spec.cekBytes || iv.length !== spec.ivBytes) {
    throw new DidcommError(
      'invalid-argument',
      `${enc} needs a ${spec.cekBytes}-byte key and a ${spec.ivBytes}-byte IV`,
    );
  }

  if (enc === 'A256CBC-HS512') {
    const cipher = createCipheriv('aes-256-cbc', cek.subarray(32), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return { ciphertext, iv, tag: cbcHmacTag(cek.subarray(0, 32), aad, iv, ciphertext) };
  }

  if (enc === 'A256GCM') {
    const cipher = createCipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  const parts = xchachaParts(cek, iv);
  const cipher = createCipheriv('chacha20-poly1305', parts.subkey, parts.nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptContent(
  enc: ContentEncryption,
  cek: Buffer,
  content: EncryptedContent,
  aad: Uint8Array,
): Buffer {
  const spec = SPECS[enc];
  const { ciphertext, iv, tag } = content;

  if (cek.length !== spec.cekBytes || iv.length !== spec.ivBytes || tag.length !== spec.tagBytes) {
    throw failed();
  }

  try {
    if (enc === 'A256CBC-HS512') {
      if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
        throw failed();
      }

      // Verify the MAC over everything before decrypting a single block.
      if (!constantTimeEqual(cbcHmacTag(cek.subarray(0, 32), aad, iv, ciphertext), tag)) {
        throw failed();
      }

      const decipher = createDecipheriv('aes-256-cbc', cek.subarray(32), iv);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    if (enc === 'A256GCM') {
      const decipher = createDecipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    const parts = xchachaParts(cek, iv);
    const decipher = createDecipheriv('chacha20-poly1305', parts.subkey, parts.nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw failed();
  }
}

/** RFC 7518 §5.2.2.1: HMAC-SHA-512 over AAD ‖ IV ‖ ciphertext ‖ AL, first 32 bytes. */
function cbcHmacTag(macKey: Buffer, aad: Uint8Array, iv: Buffer, ciphertext: Buffer): Buffer {
  const aadBits = Buffer.alloc(8);
  aadBits.writeBigUInt64BE(BigInt(aad.length) * 8n);

  return createHmac('sha512', macKey)
    .update(aad)
    .update(iv)
    .update(ciphertext)
    .update(aadBits)
    .digest()
    .subarray(0, 32);
}
