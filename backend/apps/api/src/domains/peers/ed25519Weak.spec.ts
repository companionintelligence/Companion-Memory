import { generateKeyPairSync } from 'node:crypto';

import { didKeyFromPublicKey, didKeyIdFor, didKeyPublicJwk } from './didKeyId';
import { isWeakEd25519PublicKey } from './ed25519Weak';
import { sovereignKeyIdFor, sovereignPublicJwk } from './sovereignKeyId';

/**
 * Every encoding below is a point that needs no private key to sign for (small order), or a
 * non-canonical spelling of one. They were produced by independent Edwards25519 arithmetic (a Python
 * script that decompresses each 32-byte string, multiplies by 8, and compares with the identity), not
 * by `ed25519Weak.ts`, so the code and its test cannot be wrong in the same way.
 */
const WEAK: Array<[string, string]> = [
  ['identity (order 1)', '0100000000000000000000000000000000000000000000000000000000000000'],
  ['identity, sign bit set', '0100000000000000000000000000000000000000000000000000000000000080'],
  ['order 2 (y = p-1)', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['order 2, sign bit set', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
  ['order 4 (y = 0)', '0000000000000000000000000000000000000000000000000000000000000000'],
  ['order 4, sign bit set', '0000000000000000000000000000000000000000000000000000000000000080'],
  ['order 8 (y8)', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
  ['order 8 (y8), sign bit set', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85'],
  ['order 8 (p - y8)', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
  ['order 8 (p - y8), sign bit set', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'],
  ['identity as y + p (non-canonical)', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['identity as y + p, sign bit set', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
  ['order 4 as y + p (non-canonical)', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ['order 4 as y + p, sign bit set', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
  ['all 0xff (y >= p)', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
];

const GENUINE: Array<[string, string]> = [
  ['RFC 8032 section 7.1 test 1', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'],
  ['the did:key specification example', '2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6'],
  ['the KERI reference key', '694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423'],
  ['the Local.Pub service key', 'b7e39ebf66bef1392c106cfa632bfecf4e5edbfe9060b9ed8f51955c04738233'],
];

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

const FIELD_PRIME = (1n << 255n) - 19n;
const ORDER_8_Y = BigInt(
  `0x${Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex').reverse().toString('hex')}`,
);

/** y = 0, 1, p - 1, y8, p - y8, and y = p to p + 18: 24 values, 48 encodings with the sign bit. */
const REFUSED_Y = [
  0n,
  1n,
  FIELD_PRIME - 1n,
  ORDER_8_Y,
  FIELD_PRIME - ORDER_8_Y,
  ...Array.from({ length: 19 }, (_, k) => FIELD_PRIME + BigInt(k)),
];

/** Little-endian y with bit 255 as the sign of x, as RFC 8032 writes a point. */
function encode(y: bigint, negative: boolean): Uint8Array {
  const out = new Uint8Array(32);
  let rest = y;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  if (negative) {
    out[31] |= 0x80;
  }

  return out;
}

describe('isWeakEd25519PublicKey', () => {
  it.each(WEAK)('refuses %s', (_name, hex) => {
    expect(isWeakEd25519PublicKey(bytes(hex))).toBe(true);
  });

  it.each(GENUINE)('accepts %s', (_name, hex) => {
    expect(isWeakEd25519PublicKey(bytes(hex))).toBe(false);
  });

  it('accepts freshly generated keys', () => {
    for (let i = 0; i < 300; i += 1) {
      const x = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x;

      expect(isWeakEd25519PublicKey(Uint8Array.from(Buffer.from(x, 'base64url')))).toBe(false);
    }
  });

  it('refuses anything that is not 32 bytes of key', () => {
    // Bytes that are NOT weak at 32, so only the length rule can refuse them. All zeros would be
    // refused as y = 0 whatever the length check does.
    const genuine = bytes(GENUINE[0][1]);

    expect(isWeakEd25519PublicKey(genuine)).toBe(false);
    expect(isWeakEd25519PublicKey(new Uint8Array(31).fill(7))).toBe(true);
    expect(isWeakEd25519PublicKey(new Uint8Array(33).fill(7))).toBe(true);
    expect(isWeakEd25519PublicKey(genuine.subarray(0, 31))).toBe(true);
    expect(isWeakEd25519PublicKey(Uint8Array.of(...genuine, 0))).toBe(true);
    expect(isWeakEd25519PublicKey(new Uint8Array(0))).toBe(true);
    expect(isWeakEd25519PublicKey(null as unknown as Uint8Array)).toBe(true);
    expect(isWeakEd25519PublicKey('d75a98' as unknown as Uint8Array)).toBe(true);
    expect(isWeakEd25519PublicKey(Array.from(genuine) as unknown as Uint8Array)).toBe(true);
  });

  it('refuses all 48 encodings: five small-order y values and the 19 non-canonical ones, at either sign', () => {
    const encodings = new Set<string>();
    for (const y of REFUSED_Y) {
      for (const negative of [false, true]) {
        const key = encode(y, negative);

        expect(isWeakEd25519PublicKey(key)).toBe(true);
        encodings.add(Buffer.from(key).toString('hex'));
      }
    }

    expect(REFUSED_Y).toHaveLength(24);
    expect(encodings.size).toBe(48);
  });

  it('does not refuse the y values next to the refused ones', () => {
    // Ordinary y values: whether they are on the curve is `ed25519Curve.ts`'s question, not this one's.
    for (const y of [2n, 3n, FIELD_PRIME - 2n, FIELD_PRIME - 18n, ORDER_8_Y - 1n, ORDER_8_Y + 1n]) {
      expect(isWeakEd25519PublicKey(encode(y, false))).toBe(false);
      expect(isWeakEd25519PublicKey(encode(y, true))).toBe(false);
    }

    expect(isWeakEd25519PublicKey(encode(FIELD_PRIME - ORDER_8_Y - 1n, false))).toBe(false);
    expect(isWeakEd25519PublicKey(encode(FIELD_PRIME - ORDER_8_Y + 1n, false))).toBe(false);
  });

  it('does not modify the key it is given', () => {
    const key = bytes(WEAK[1][1]);
    const before = Buffer.from(key).toString('hex');

    isWeakEd25519PublicKey(key);

    expect(Buffer.from(key).toString('hex')).toBe(before);
  });
});

describe('a weak key is not an identifier, in either self-certifying spelling', () => {
  it.each(WEAK)('did:key refuses %s', (_name, hex) => {
    expect(didKeyFromPublicKey(bytes(hex))).toBeNull();
    expect(
      didKeyIdFor({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }),
    ).toBeNull();
  });

  it.each(WEAK)('did:keri:D<x> refuses %s', (_name, hex) => {
    const x = Buffer.from(hex, 'hex').toString('base64url');

    expect(sovereignPublicJwk(`did:keri:D${x}`)).toBeNull();
    expect(sovereignKeyIdFor({ kty: 'OKP', crv: 'Ed25519', x })).toBeNull();
  });

  it.each(WEAK)('refuses to read a did:key that spells out %s', (_name, hex) => {
    // The string a weak key WOULD have had, built by hand so only the reader is under test.
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt(`0xed01${hex}`);
    let digits = '';
    while (n > 0n) {
      digits = alphabet[Number(n % 58n)] + digits;
      n /= 58n;
    }

    const did = `did:key:z${digits}`;

    expect(didKeyPublicJwk(did)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 42],
    ['an empty object', {}],
    ['another key type', { kty: 'EC', crv: 'P-256', x: 'AAAA' }],
    [
      'another curve',
      { kty: 'OKP', crv: 'X25519', x: Buffer.from(GENUINE[0][1], 'hex').toString('base64url') },
    ],
    [
      'an EC key that claims the Ed25519 curve',
      { kty: 'EC', crv: 'Ed25519', x: Buffer.from(GENUINE[0][1], 'hex').toString('base64url') },
    ],
    ['no x', { kty: 'OKP', crv: 'Ed25519' }],
    ['an x that is not a string', { kty: 'OKP', crv: 'Ed25519', x: 7 }],
  ])('did:keri:D<x> is not minted from %s, and nothing throws', (_name, jwk) => {
    expect(sovereignKeyIdFor(jwk as unknown as Record<string, unknown>)).toBeNull();
  });

  it.each(GENUINE)('still accepts %s in both spellings', (_name, hex) => {
    const x = Buffer.from(hex, 'hex').toString('base64url');
    const jwk = { kty: 'OKP', crv: 'Ed25519', x };

    expect(didKeyIdFor(jwk)).not.toBeNull();
    expect(sovereignKeyIdFor(jwk)).toBe(`did:keri:D${x}`);
  });
});
