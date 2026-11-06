import { generateKeyPairSync } from 'node:crypto';

import { isUsableEd25519PublicKey } from './ed25519';

const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * The eight points of order dividing 8, computed independently (pure-integer Python, multiplying random
 * points by the prime group order) and matching libsodium's blocklist: the identity, the point of order
 * 2, two of order 4 and four of order 8, in the encodings a key could take.
 */
const SMALL_ORDER = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
];

/** y >= p (the same point as a small y), and "negative zero": x = 0 with the sign bit set. */
const NON_CANONICAL = [
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
];

describe('isUsableEd25519PublicKey', () => {
  it('accepts real Ed25519 public keys', () => {
    for (let count = 0; count < 60; count += 1) {
      const x = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;

      expect(isUsableEd25519PublicKey(new Uint8Array(Buffer.from(x, 'base64url')))).toBe(true);
    }
  });

  for (const hex of SMALL_ORDER) {
    it(`refuses the small-order point ${hex.slice(0, 16)}…`, () => {
      expect(isUsableEd25519PublicKey(bytes(hex))).toBe(false);
    });
  }

  for (const hex of NON_CANONICAL) {
    it(`refuses the non-canonical encoding ${hex.slice(0, 16)}…`, () => {
      expect(isUsableEd25519PublicKey(bytes(hex))).toBe(false);
    });
  }

  it('refuses a string that is not a point on the curve', () => {
    // y = 2 has no x on the curve; scan a few small y values for ones that do not decode.
    let refused = 0;
    for (let y = 2; y < 40; y += 1) {
      const candidate = new Uint8Array(32);
      candidate[0] = y;

      if (!isUsableEd25519PublicKey(candidate)) {
        refused += 1;
      }
    }

    expect(refused).toBeGreaterThan(5);
  });

  it('refuses anything that is not 32 bytes', () => {
    expect(isUsableEd25519PublicKey(new Uint8Array(31))).toBe(false);
    expect(isUsableEd25519PublicKey(new Uint8Array(33))).toBe(false);
    expect(isUsableEd25519PublicKey(new Uint8Array(0))).toBe(false);
  });
});
