/**
 * Ed25519 public keys that name no one, and genuine ones, for this domain's specs.
 *
 * `WEAK` and `GENUINE` are copies of the lists in `peers/ed25519Weak.spec.ts`, where the weak encodings
 * were produced by Edwards25519 arithmetic written independently of the code under test (decompress each
 * 32-byte string, multiply by 8, compare with the identity). PWS imports nothing from another domain, so
 * they are copied here, not imported.
 *
 * Every `WEAK` encoding is a point of small order, for which a signature can be made without a private
 * key, or a non-canonical spelling of a point (y >= p). Keys are hex, in RFC 8032 order: little-endian y,
 * with bit 255 the sign of x.
 */
import { base58btcEncode } from '../multibase';

export const WEAK: Array<[string, string]> = [
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

export const GENUINE: Array<[string, string]> = [
  ['RFC 8032 section 7.1 test 1', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'],
  ['the did:key specification example', '2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6'],
  ['the KERI reference key', '694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423'],
  ['the Local.Pub service key', 'b7e39ebf66bef1392c106cfa632bfecf4e5edbfe9060b9ed8f51955c04738233'],
];

/** p = 2^255 - 19. */
export const FIELD_PRIME = (1n << 255n) - 19n;

/** y of the points of order 8: libsodium's blocklist entry, read little-endian. The other is p - y8. */
export const ORDER_8_Y = BigInt(
  `0x${Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex').reverse().toString('hex')}`,
);

/** y = 0, 1, p - 1, y8, p - y8, and y = p to p + 18: 24 values, 48 encodings with the sign bit. */
export const REFUSED_Y = [
  0n,
  1n,
  FIELD_PRIME - 1n,
  ORDER_8_Y,
  FIELD_PRIME - ORDER_8_Y,
  ...Array.from({ length: 19 }, (_, k) => FIELD_PRIME + BigInt(k)),
];

/** Little-endian y with bit 255 as the sign of x, as RFC 8032 writes a point. */
export function encodePoint(y: bigint, negative: boolean): Uint8Array {
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

export const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

/** The `did:key` that spells these 32 bytes, built by hand so that only the reader is under test. */
export function didKeyOf(key: Uint8Array): string {
  return `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...key]))}`;
}

/** The identity point (y = 1): `01` and 31 zero bytes. */
export const IDENTITY_KEY = fromHex(`01${'00'.repeat(31)}`);

/** The `did:key` of the identity point. */
export const IDENTITY_DID_KEY = 'did:key:z6MkeXATEjyXENzBXBxgC5EHk2JE5aqd7qMGGtDpLUH1e2Sj';

/**
 * Signatures that verify under the identity key for every message, with no private key behind them:
 * R = the base point B (`58` then 31 bytes of `66`) with S = 1, and R = the identity with S = 0.
 */
export const KEYLESS_SIGNATURES: Array<[string, Uint8Array]> = [
  ['R = B, S = 1', fromHex(`58${'66'.repeat(31)}01${'00'.repeat(31)}`)],
  ['R = identity, S = 0', fromHex(`01${'00'.repeat(63)}`)],
];
