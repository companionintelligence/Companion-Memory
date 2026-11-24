import { createECDH, randomBytes } from 'node:crypto';

import { codeOf, hex, toHex } from '../__tests__/support';
import { cbor, decode, encode } from '../encoding/dcbor';

import {
  bytesEqual,
  classicalPublicKey,
  classicalPublicKeyFromCbor,
  classicalSignature,
  classicalSignatureFromCbor,
  ed25519JwkOf,
  ed25519KeyFromJwk,
  fingerprintFromBase58,
  fingerprintOf,
  fingerprintToBase58,
  pqPublicKey,
  pqPublicKeyFromCbor,
  pqPublicKeysEqual,
  pqSignature,
  pqSignatureFromCbor,
  publicKeyToCbor,
  signatureToCbor,
  type ClassicalPublicKey,
} from './keys';

// The keys of the Rust crate's fixtures: Ed25519 seed 0x11 × 32 and P-256 scalar 0x22 × 32.
const ED_KEY = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const P256_KEY = '03d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf3';

/** The same P-256 key as `P256_KEY`, spelled as the 65-byte point: a real key, not a placeholder. */
function uncompressedP256(): Uint8Array {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.alloc(32, 0x22));

  return new Uint8Array(ecdh.getPublicKey(null, 'uncompressed'));
}

describe('keys', () => {
  describe('constructors only make well-formed values', () => {
    it('accepts real keys and signatures of every algorithm', () => {
      expect(classicalPublicKey('ed25519', hex(ED_KEY)).alg).toBe('ed25519');
      expect(classicalPublicKey('p256', hex(P256_KEY)).alg).toBe('p256');
      expect(classicalSignature('ed25519', new Uint8Array(64)).bytes).toHaveLength(64);
      expect(classicalSignature('p256', new Uint8Array(64)).bytes).toHaveLength(64);
      expect(pqPublicKey('ml-dsa-44', new Uint8Array(1312)).bytes).toHaveLength(1312);
      expect(pqPublicKey('ml-dsa-65', new Uint8Array(1952)).bytes).toHaveLength(1952);
      expect(pqPublicKey('ml-dsa-87', new Uint8Array(2592)).bytes).toHaveLength(2592);
      expect(pqSignature('ml-dsa-44', new Uint8Array(2420)).bytes).toHaveLength(2420);
      expect(pqSignature('ml-dsa-65', new Uint8Array(3309)).bytes).toHaveLength(3309);
      expect(pqSignature('ml-dsa-87', new Uint8Array(4627)).bytes).toHaveLength(4627);
    });

    it('copies the bytes, so a caller cannot change a key it already handed over', () => {
      const bytes = hex(ED_KEY);
      const key = classicalPublicKey('ed25519', bytes);
      bytes[0] ^= 0xff;

      expect(toHex(key.bytes)).toBe(ED_KEY);
    });

    it.each([
      ['an Ed25519 key of 31 bytes', () => classicalPublicKey('ed25519', hex(ED_KEY).subarray(1)), 'bad-key'],
      ['an Ed25519 key of 33 bytes', () => classicalPublicKey('ed25519', new Uint8Array(33)), 'bad-key'],
      [
        'the Ed25519 identity point',
        () => classicalPublicKey('ed25519', hex(`01${'00'.repeat(31)}`)),
        'bad-key',
      ],
      [
        'an Ed25519 y that is not on the curve',
        () => classicalPublicKey('ed25519', hex(`02${'00'.repeat(31)}`)),
        'bad-key',
      ],
      [
        'a genuine P-256 key in uncompressed form',
        () => classicalPublicKey('p256', uncompressedP256()),
        'bad-key',
      ],
      [
        'a P-256 key with a prefix that is neither 02 nor 03',
        () => classicalPublicKey('p256', hex(`04${P256_KEY.slice(2)}`)),
        'bad-key',
      ],
      ['a 32-byte value as P-256', () => classicalPublicKey('p256', hex(ED_KEY)), 'bad-key'],
      [
        'an Ed25519 signature of 63 bytes',
        () => classicalSignature('ed25519', new Uint8Array(63)),
        'bad-signature',
      ],
      [
        'a P-256 signature in DER form',
        () => classicalSignature('p256', new Uint8Array(72)),
        'bad-signature',
      ],
      [
        'an ML-DSA-65 key of the ML-DSA-44 size',
        () => pqPublicKey('ml-dsa-65', new Uint8Array(1312)),
        'bad-key',
      ],
      [
        'an ML-DSA-65 signature one byte short',
        () => pqSignature('ml-dsa-65', new Uint8Array(3308)),
        'bad-signature',
      ],
    ])('refuses %s', (_label, make, code) => {
      expect(codeOf(make)).toBe(code);
    });
  });

  describe('wire form { "alg": tstr, "key" | "sig": bstr }', () => {
    it('is exactly the bytes a hand-assembled dCBOR map has', () => {
      // a2 | 63 "alg" | 67 "ed25519" | 63 "key" | 58 20 <32 bytes>, assembled in Python, not here.
      expect(toHex(encode(publicKeyToCbor(classicalPublicKey('ed25519', hex(ED_KEY)))))).toBe(
        'a263616c676765643235353139636b65795820' + ED_KEY,
      );
      expect(toHex(encode(publicKeyToCbor(classicalPublicKey('p256', hex(P256_KEY)))))).toBe(
        'a263616c676470323536636b65795821' + P256_KEY,
      );
    });

    it('round-trips every kind', () => {
      const ed = classicalPublicKey('ed25519', hex(ED_KEY));
      const sig = classicalSignature('p256', new Uint8Array(randomBytes(64)));
      const pk = pqPublicKey('ml-dsa-65', new Uint8Array(randomBytes(1952)));
      const ps = pqSignature('ml-dsa-87', new Uint8Array(randomBytes(4627)));

      expect(classicalPublicKeyFromCbor(decode(encode(publicKeyToCbor(ed))))).toEqual(ed);
      expect(classicalSignatureFromCbor(decode(encode(signatureToCbor(sig))))).toEqual(sig);
      expect(pqPublicKeyFromCbor(decode(encode(publicKeyToCbor(pk))))).toEqual(pk);
      expect(pqSignatureFromCbor(decode(encode(signatureToCbor(ps))))).toEqual(ps);
    });

    it('refuses an algorithm outside the registry, in the right slot only', () => {
      const unknown = cbor.map([
        ['alg', cbor.text('rsa-2048')],
        ['key', cbor.bytes(new Uint8Array(32))],
      ]);

      expect(codeOf(() => classicalPublicKeyFromCbor(unknown))).toBe('unknown-algorithm');
      expect(codeOf(() => pqPublicKeyFromCbor(unknown))).toBe('unknown-algorithm');
      // A real PQ tag is not a classical one, and the reverse.
      const pqTagged = cbor.map([
        ['alg', cbor.text('ml-dsa-65')],
        ['key', cbor.bytes(new Uint8Array(1952))],
      ]);

      expect(codeOf(() => classicalPublicKeyFromCbor(pqTagged))).toBe('unknown-algorithm');
    });

    it.each([
      [
        'a member nobody defined',
        cbor.map([
          ['alg', cbor.text('ed25519')],
          ['extra', cbor.uint(1)],
          ['key', cbor.bytes(hex(ED_KEY))],
        ]),
      ],
      ['no "key"', cbor.map([['alg', cbor.text('ed25519')]])],
      ['no "alg"', cbor.map([['key', cbor.bytes(hex(ED_KEY))]])],
      [
        '"sig" where "key" belongs',
        cbor.map([
          ['alg', cbor.text('ed25519')],
          ['sig', cbor.bytes(hex(ED_KEY))],
        ]),
      ],
      [
        'a text "key"',
        cbor.map([
          ['alg', cbor.text('ed25519')],
          ['key', cbor.text(ED_KEY)],
        ]),
      ],
      [
        'an integer "alg"',
        cbor.map([
          ['alg', cbor.uint(1)],
          ['key', cbor.bytes(hex(ED_KEY))],
        ]),
      ],
      ['an array instead of a map', cbor.array([cbor.text('ed25519'), cbor.bytes(hex(ED_KEY))])],
    ])('refuses %s', (_label, value) => {
      expect(codeOf(() => classicalPublicKeyFromCbor(value))).toBe('malformed');
    });

    it('applies the same length and weak-key checks to what it decodes', () => {
      const weak = cbor.map([
        ['alg', cbor.text('ed25519')],
        ['key', cbor.bytes(hex(`01${'00'.repeat(31)}`))],
      ]);

      expect(codeOf(() => classicalPublicKeyFromCbor(weak))).toBe('bad-key');
    });

    it('does not echo a hostile algorithm tag unbounded into the error message', () => {
      const hostile = cbor.map([
        ['alg', cbor.text(`ab\nforged log line${'x'.repeat(10_000)}`)],
        ['key', cbor.bytes(new Uint8Array(32))],
      ]);

      try {
        classicalPublicKeyFromCbor(hostile);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error).message.length).toBeLessThan(120);
        expect((error as Error).message).not.toContain('\n');
      }
    });
  });

  describe('fingerprints', () => {
    // Computed by the `blake3` PyPI package over dCBOR assembled by hand; see the fixtures README.
    const CASES: readonly (readonly [string, string, string, string])[] = [
      [
        'ed25519',
        ED_KEY,
        '55aece16fd0e038e319188d8e155433ae853f1c3e6bb271b48d68db860777fd4',
        '6mUFfKo4KPLqjeAVqthhCZB82jgWjbo3RPJAAWdTynq1',
      ],
      [
        'p256',
        P256_KEY,
        '611ad1fb11a1a4caba83383a96dd0ea8fceac5723dcff11c853adc80b5c79680',
        '7Y4GTy1PjxWh3KsCisNVT3umvDdZZGqBWwEPSWW9AGWB',
      ],
    ];

    it.each(CASES)('%s: Blake3 of the key map, in hex and base58', (alg, key, fingerprint, base58) => {
      const fp = fingerprintOf(classicalPublicKey(alg as 'ed25519' | 'p256', hex(key)));

      expect(toHex(fp)).toBe(fingerprint);
      expect(fingerprintToBase58(fp)).toBe(base58);
      expect(toHex(fingerprintFromBase58(base58))).toBe(fingerprint);
    });

    it('commits to the algorithm: the same bytes under another algorithm are another identity', () => {
      const bytes = hex(ED_KEY);
      // Built without the constructors, which would (rightly) refuse a 32-byte P-256 key.
      const asEd: ClassicalPublicKey = { alg: 'ed25519', bytes };
      const asP256: ClassicalPublicKey = { alg: 'p256', bytes };

      expect(toHex(fingerprintOf(asEd))).not.toBe(toHex(fingerprintOf(asP256)));
    });

    it('is NOT the fingerprint the wallet format uses (Blake3 of the raw Ed25519 key)', () => {
      const key = classicalPublicKey('ed25519', hex(ED_KEY));

      // Blake3 of the 32 raw bytes, from the `blake3` PyPI package. Two definitions of "fingerprint"
      // live in identikey (this one in `identikey-wallet` and Recrypt, the algorithm-committing one in
      // `identikey-auth` and `identikey-capability`); mixing them up yields two names for one key.
      const walletStyle = '4a78877c4a0926fc5d5cb282bb45c11c8489b202fe1890fa0c6593e6192b9f75';

      expect(toHex(fingerprintOf(key))).not.toBe(walletStyle);
    });

    it('refuses a base58 string that is not 32 bytes', () => {
      expect(codeOf(() => fingerprintFromBase58('2g'))).toBe('malformed');
      expect(codeOf(() => fingerprintFromBase58(''))).toBe('malformed');
      expect(codeOf(() => fingerprintToBase58(new Uint8Array(31)))).toBe('malformed');
      expect(codeOf(() => fingerprintFromBase58('0OIl'))).toBe('malformed');
    });
  });

  describe('comparison', () => {
    it('compares bytes by value', () => {
      expect(bytesEqual(hex('0102'), hex('0102'))).toBe(true);
      expect(bytesEqual(hex('0102'), hex('0103'))).toBe(false);
      expect(bytesEqual(hex('01'), hex('0100'))).toBe(false);
    });

    it('compares PQ keys by algorithm AND bytes', () => {
      const a = pqPublicKey('ml-dsa-44', new Uint8Array(1312));
      const b = pqPublicKey('ml-dsa-44', new Uint8Array(1312));
      const c = pqPublicKey('ml-dsa-44', new Uint8Array(1312).fill(1));

      expect(pqPublicKeysEqual(a, b)).toBe(true);
      expect(pqPublicKeysEqual(a, c)).toBe(false);
      // Same length, different algorithm tag: built directly, since no two parameter sets share a size.
      expect(pqPublicKeysEqual(a, { alg: 'ml-dsa-65', bytes: a.bytes })).toBe(false);
    });
  });

  describe('the bridge to Ed25519 JWKs', () => {
    // RFC 8037 appendix A.2: the public key of RFC 8032 TEST 1.
    const RFC8037_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    const RFC8032_KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

    it('reads a public JWK and writes it back unchanged', () => {
      const key = ed25519KeyFromJwk({ kty: 'OKP', crv: 'Ed25519', x: RFC8037_X });

      expect(toHex(key.bytes)).toBe(RFC8032_KEY);
      expect(ed25519JwkOf(key)).toEqual({ kty: 'OKP', crv: 'Ed25519', x: RFC8037_X });
    });

    it.each([
      ['another key type', { kty: 'EC', crv: 'P-256', x: RFC8037_X }],
      ['another curve', { kty: 'OKP', crv: 'X25519', x: RFC8037_X }],
      ['no x', { kty: 'OKP', crv: 'Ed25519' }],
      ['an x that is not a string', { kty: 'OKP', crv: 'Ed25519', x: 5 }],
      [
        'standard base64 instead of base64url',
        { kty: 'OKP', crv: 'Ed25519', x: RFC8037_X.replace(/_/g, '/') },
      ],
      ['padding', { kty: 'OKP', crv: 'Ed25519', x: `${RFC8037_X}=` }],
      ['a different length', { kty: 'OKP', crv: 'Ed25519', x: RFC8037_X.slice(0, 40) }],
      ['non-canonical trailing bits', { kty: 'OKP', crv: 'Ed25519', x: `${RFC8037_X.slice(0, 42)}p` }],
    ])('refuses %s', (_label, jwk) => {
      expect(codeOf(() => ed25519KeyFromJwk(jwk))).toBe('bad-key');
    });

    it('has no JWK form for a P-256 identity', () => {
      expect(codeOf(() => ed25519JwkOf(classicalPublicKey('p256', hex(P256_KEY))))).toBe('bad-key');
    });
  });
});
