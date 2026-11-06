import { createECDH, randomBytes } from 'node:crypto';

import { P256_KEY_LENGTH, P256_SIGNATURE_LENGTH, isUsableP256Key, p256FromSecret, verifyP256 } from './p256';

const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The order of the P-256 group (FIPS 186-4 D.1.2.3). */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const message = new TextEncoder().encode('a message');

describe('P-256 (ECDSA, SHA-256, compressed keys, r || s)', () => {
  // The public key the Rust reference derives from the scalar 0x22 × 32 (see the fixtures README).
  const RUST_FIXTURE_KEY = '03d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf3';

  it('derives the same compressed public key as the Rust reference for the same scalar', () => {
    const { publicKey } = p256FromSecret(new Uint8Array(32).fill(0x22));

    expect(publicKey).toHaveLength(P256_KEY_LENGTH);
    expect(toHex(publicKey)).toBe(RUST_FIXTURE_KEY);
  });

  it('signs and verifies', () => {
    const { publicKey, sign } = p256FromSecret(new Uint8Array(randomBytes(32)));
    const signature = sign(message);

    expect(signature).toHaveLength(P256_SIGNATURE_LENGTH);
    expect(verifyP256(publicKey, message, signature)).toBe(true);
  });

  it('refuses a changed message, key or signature, and bad lengths, without throwing', () => {
    const { publicKey, sign } = p256FromSecret(new Uint8Array(32).fill(0x22));
    const signature = sign(message);
    const other = p256FromSecret(new Uint8Array(32).fill(0x23)).publicKey;

    expect(verifyP256(publicKey, new TextEncoder().encode('a messagE'), signature)).toBe(false);
    expect(verifyP256(other, message, signature)).toBe(false);
    for (const index of [0, 31, 32, 63]) {
      const damaged = Uint8Array.from(signature);
      damaged[index] ^= 0x01;

      expect(verifyP256(publicKey, message, damaged)).toBe(false);
    }

    expect(verifyP256(publicKey, message, signature.subarray(1))).toBe(false);
    expect(verifyP256(publicKey, message, new Uint8Array(65))).toBe(false);
    expect(verifyP256(publicKey.subarray(1), message, signature)).toBe(false);
  });

  it('refuses r = 0 or s = 0', () => {
    const { publicKey } = p256FromSecret(new Uint8Array(32).fill(0x22));

    expect(verifyP256(publicKey, message, new Uint8Array(64))).toBe(false);
  });

  it('accepts the high-S twin of a signature, because hardware signers do not normalise S', () => {
    // Apple's Secure Enclave and TPMs return whichever S they computed, so rejecting high S would
    // reject honest hardware. The consequence is that a P-256 signature here is MALLEABLE: it must
    // never be used as an identifier or hashed into one.
    const { publicKey, sign } = p256FromSecret(new Uint8Array(32).fill(0x22));
    const signature = sign(message);
    const s = BigInt(`0x${toHex(signature.subarray(32))}`);
    const twin = Uint8Array.from(signature);
    twin.set(hex((N - s).toString(16).padStart(64, '0')), 32);

    expect(toHex(twin)).not.toBe(toHex(signature));
    expect(verifyP256(publicKey, message, twin)).toBe(true);
  });

  describe('which byte strings are keys', () => {
    const { publicKey } = p256FromSecret(new Uint8Array(32).fill(0x22));

    it('accepts a compressed point on the curve', () => {
      expect(isUsableP256Key(publicKey)).toBe(true);
    });

    it('refuses every OTHER valid spelling of the same key: one key must have one spelling, or one fingerprint', () => {
      // These are the genuine points, so a verifier that merely parsed SEC1 would accept them all.
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.alloc(32, 0x22));
      const uncompressed = new Uint8Array(ecdh.getPublicKey(null, 'uncompressed'));
      const hybrid = new Uint8Array(ecdh.getPublicKey(null, 'hybrid'));

      expect(uncompressed).toHaveLength(65);
      expect(uncompressed[0]).toBe(0x04);
      expect(hybrid).toHaveLength(65);
      expect([0x06, 0x07]).toContain(hybrid[0]);
      expect(toHex(uncompressed.subarray(1, 33))).toBe(toHex(publicKey.subarray(1)));
      expect(isUsableP256Key(uncompressed)).toBe(false);
      expect(isUsableP256Key(hybrid)).toBe(false);
      expect(verifyP256(uncompressed, message, p256FromSecret(Buffer.alloc(32, 0x22)).sign(message))).toBe(
        false,
      );
    });

    it('refuses a bad prefix, a bad length, and the point at infinity', () => {
      const wrongPrefix = Uint8Array.from(publicKey);
      wrongPrefix[0] = 0x04;
      const zero = new Uint8Array(33);

      expect(isUsableP256Key(wrongPrefix)).toBe(false);
      expect(isUsableP256Key(publicKey.subarray(0, 32))).toBe(false);
      expect(isUsableP256Key(zero)).toBe(false);
    });

    it('refuses an x that has no point on the curve (about half of all values do not)', () => {
      const offCurve: number[] = [];
      for (let x = 1; x <= 30; x += 1) {
        const candidate = new Uint8Array(33);
        candidate[0] = 0x02;
        candidate[32] = x;
        if (!isUsableP256Key(candidate)) {
          offCurve.push(x);
        }
      }

      expect(offCurve.length).toBeGreaterThan(5);
      expect(offCurve.length).toBeLessThan(30);
    });

    it('refuses an x at or above the field prime', () => {
      const candidate = new Uint8Array(33).fill(0xff);
      candidate[0] = 0x02;

      expect(isUsableP256Key(candidate)).toBe(false);
    });
  });

  it('refuses a secret scalar that is zero or not below the group order', () => {
    expect(() => p256FromSecret(new Uint8Array(32))).toThrow();
    expect(() => p256FromSecret(new Uint8Array(32).fill(0xff))).toThrow();
  });
});
