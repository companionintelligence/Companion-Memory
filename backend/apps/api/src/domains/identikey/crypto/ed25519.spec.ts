import { createHash, createPublicKey, verify as nodeVerify, randomBytes } from 'node:crypto';

import { ORDER8_Y, ed25519FromSeed, isSmallOrderPoint, isUsableEd25519Key, verifyEd25519 } from './ed25519';

const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** RFC 8032 §7.1 TEST 1, 2 and 3 (the empty message, one byte, two bytes). */
const RFC8032 = [
  {
    name: 'TEST 1',
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature:
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'TEST 2',
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature:
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'TEST 3',
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature:
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
];

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const P = (1n << 255n) - 19n;

const leToBigInt = (bytes: Uint8Array): bigint =>
  [...bytes].reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
const bigIntToLe = (value: bigint, length = 32): Uint8Array => {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  return out;
};

/** The eight points of order dividing 8, in their canonical encodings, then the sign-bit twins. */
const SMALL_ORDER = [
  '0100000000000000000000000000000000000000000000000000000000000000', // the identity
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2: y = p - 1
  '0000000000000000000000000000000000000000000000000000000000000000', // order 4
  '0000000000000000000000000000000000000000000000000000000000000080', // order 4, x negative
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8, x negative
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8, x negative
  // Non-canonical spellings: y + p for y = 0 and y = 1, and the identity with its sign bit set.
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0100000000000000000000000000000000000000000000000000000000000080',
];

describe('Ed25519', () => {
  describe('against RFC 8032', () => {
    it.each(RFC8032)('derives the key and reproduces the signature for RFC 8032 $name', (vector) => {
      const pair = ed25519FromSeed(hex(vector.seed));

      expect(toHex(pair.publicKey)).toBe(vector.publicKey);
      expect(toHex(pair.sign(hex(vector.message)))).toBe(vector.signature);
      expect(verifyEd25519(pair.publicKey, hex(vector.message), hex(vector.signature))).toBe(true);
    });
  });

  describe('rejects what is simply wrong', () => {
    const { publicKey, sign } = ed25519FromSeed(hex(RFC8032[0].seed));
    const message = new TextEncoder().encode('a message');
    const signature = sign(message);

    it('accepts the genuine signature', () => {
      expect(verifyEd25519(publicKey, message, signature)).toBe(true);
    });

    it('refuses a changed message, key, or signature byte', () => {
      expect(verifyEd25519(publicKey, new TextEncoder().encode('a messagE'), signature)).toBe(false);

      for (const index of [0, 31, 32, 63]) {
        const damaged = Uint8Array.from(signature);
        damaged[index] ^= 0x01;

        expect(verifyEd25519(publicKey, message, damaged)).toBe(false);
      }

      const other = ed25519FromSeed(hex(RFC8032[1].seed)).publicKey;
      expect(verifyEd25519(other, message, signature)).toBe(false);
    });

    it('refuses the wrong lengths without throwing', () => {
      expect(verifyEd25519(publicKey.subarray(1), message, signature)).toBe(false);
      expect(verifyEd25519(publicKey, message, signature.subarray(1))).toBe(false);
      expect(verifyEd25519(new Uint8Array(0), message, new Uint8Array(0))).toBe(false);
      expect(() => ed25519FromSeed(new Uint8Array(31))).toThrow(RangeError);
    });
  });

  describe('strict verification (what OpenSSL alone does not do)', () => {
    it('refuses a signature whose S is not reduced, though the point equation still holds for it', () => {
      const { publicKey, sign } = ed25519FromSeed(hex(RFC8032[0].seed));
      const message = hex('72');
      const signature = sign(message);
      const s = leToBigInt(signature.subarray(32));

      expect(s).toBeLessThan(L);

      // S + L is the same point equation, so a lenient verifier takes it as a second valid signature.
      // (OpenSSL 3.x refuses it too, which is why no mutation of the explicit check is caught here.)
      const malleated = Uint8Array.from(signature);
      malleated.set(bigIntToLe(s + L), 32);

      expect(verifyEd25519(publicKey, message, signature)).toBe(true);
      expect(verifyEd25519(publicKey, message, malleated)).toBe(false);
    });

    it.each(SMALL_ORDER)('knows %s is a small-order point and refuses it as a key', (encoded) => {
      expect(isSmallOrderPoint(hex(encoded))).toBe(true);
      expect(isUsableEd25519Key(hex(encoded))).toBe(false);
    });

    const rawKey = (publicKey: Uint8Array) =>
      createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
        format: 'der',
        type: 'spki',
      });

    it('refuses the universal forgery under the identity key, which OpenSSL ACCEPTS for any message', () => {
      // With A = identity, [S]B = R + [k]A reduces to [S]B = R, whatever k (the message) is. So
      // R = B, S = 1 "signs" everything. Its R is the base point, NOT a small-order point: only the
      // check on the KEY stands between this and an identity anybody can speak for.
      const identity = hex(SMALL_ORDER[0]);
      const basePoint = hex('5866666666666666666666666666666666666666666666666666666666666666');
      const universal = new Uint8Array(64);
      universal.set(basePoint, 0);
      universal[32] = 1;

      expect(isSmallOrderPoint(basePoint)).toBe(false);
      for (const text of ['pay the attacker', 'something else entirely']) {
        const bytes = new TextEncoder().encode(text);

        expect(nodeVerify(null, bytes, rawKey(identity), universal)).toBe(true);
        expect(verifyEd25519(identity, bytes, universal)).toBe(false);
      }
    });

    it('also refuses the simpler forgery (R = identity, S = 0), which is caught on both counts', () => {
      const identity = hex(SMALL_ORDER[0]);
      const universal = new Uint8Array(64);
      universal.set(identity, 0);

      expect(nodeVerify(null, Buffer.from('anything'), rawKey(identity), universal)).toBe(true);
      expect(verifyEd25519(identity, new TextEncoder().encode('anything'), universal)).toBe(false);
    });

    it('refuses a small-order R even under an honest key, where the plain equation holds', () => {
      // The signer knows the secret scalar a, so it can pick R = identity and S = k·a (mod L), with
      // k = SHA-512(R || A || M): then [S]B = [k]A = R + [k]A. A valid signature, as far as RFC 8032's
      // equation goes, that no `verify_strict` signer would ever have produced.
      const seed = hex(RFC8032[0].seed);
      const message = hex('72');
      const { publicKey } = ed25519FromSeed(seed);
      const h = createHash('sha512').update(seed).digest();
      const clamped = Uint8Array.from(h.subarray(0, 32));
      clamped[0] &= 248;
      clamped[31] &= 127;
      clamped[31] |= 64;
      const r = hex(SMALL_ORDER[0]);
      const k = leToBigInt(createHash('sha512').update(r).update(publicKey).update(message).digest()) % L;
      const weak = new Uint8Array(64);
      weak.set(r, 0);
      weak.set(bigIntToLe((k * leToBigInt(clamped)) % L), 32);

      expect(nodeVerify(null, message, rawKey(publicKey), weak)).toBe(true);
      expect(verifyEd25519(publicKey, message, weak)).toBe(false);
    });

    it('has the small-order constants right: the second order-8 y is p minus the first', () => {
      expect(toHex(bigIntToLe(P - ORDER8_Y))).toBe(SMALL_ORDER[5]);
      expect(toHex(bigIntToLe(P - 1n))).toBe(SMALL_ORDER[1]);
    });

    it('does not mistake ordinary keys for weak ones', () => {
      for (let i = 0; i < 25; i += 1) {
        const { publicKey } = ed25519FromSeed(new Uint8Array(randomBytes(32)));

        expect(isSmallOrderPoint(publicKey)).toBe(false);
        expect(isUsableEd25519Key(publicKey)).toBe(true);
      }
    });
  });

  describe('which byte strings are keys at all', () => {
    // y = 3 is on the curve, y = 2 is not. (Found by solving x² = (y² - 1) / (d·y² + 1).)
    const encodeY = (y: bigint): Uint8Array => bigIntToLe(y);

    it('accepts a canonical y on the curve', () => {
      expect(isUsableEd25519Key(encodeY(3n))).toBe(true);
    });

    it('refuses a y with no point on the curve', () => {
      for (const y of [2n, 7n, 8n, 11n, 12n, 13n, 17n]) {
        expect(isUsableEd25519Key(encodeY(y))).toBe(false);
      }
    });

    it('refuses a second spelling of a real point (y + p), which would be a second fingerprint', () => {
      for (const y of [3n, 4n, 5n, 6n, 9n, 10n, 14n, 15n, 16n, 18n]) {
        expect(isUsableEd25519Key(encodeY(y))).toBe(true);
        expect(isUsableEd25519Key(encodeY(y + P))).toBe(false);
      }
    });

    it('refuses anything that is not 32 bytes', () => {
      expect(isUsableEd25519Key(new Uint8Array(31))).toBe(false);
      expect(isUsableEd25519Key(new Uint8Array(33))).toBe(false);
    });
  });
});
