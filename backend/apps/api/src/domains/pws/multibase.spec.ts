import { createHash } from 'node:crypto';

import {
  base58btcDecode,
  base58btcEncode,
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlEncode,
  MultibaseError,
  multibaseDecode,
  multibaseEncode,
  sha256Multihash,
} from './multibase';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'ascii'));

/**
 * `src/test/data/base58_encode_decode.json` from Bitcoin Core (MIT licence, (c) The Bitcoin Core developers), every
 * row, copied as published: hex of the
 * bytes, then their base58 text. The 1536-byte ceiling this module puts on decoding sits above the longest row (256
 * bytes). Rows 13-15 are the leading-zero cases.
 */
const BITCOIN_BASE58: Array<[string, string]> = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
  [
    '00000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '1111111111111111111111111111111111111111',
  ],
  [
    '00000000000000000000000000000000000000000000000000000000000000000000000000000001',
    '1111111111111111111111111111111111111112',
  ],
  [
    '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ec39d04c37e71e5d591881f6',
    '111111111111111111111111111111111111111111111111111111111111111111111111111111111111115TYzLYH1udmLdzCLM',
  ],
  [
    '000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5',
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  ],
  [
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    '1cWB5HCBdLjAuqGGReWE3R3CguuwSjw6RHn39s2yuDRTS5NsBgNiFpWgAnEx6VQi8csexkgYw3mdYrMHr8x9i7aEwP8kZ7vccXWqKDvGv3u1GxFKPuAkn8JCPPGDMf3vMMnbzm6Nh9zh1gcNsMvH3ZNLmP5fSG6DGbbi2tuwMWPthr4boWwCxf7ewSgNQeacyozhKDDQQ1qL5fQFUW52QKUZDZ5fw3KXNQJMcNTcaB723LchjeKun7MuGW5qyCBZYzA1KjofN1gYBV3NqyhQJ3Ns746GNuf9N2pQPmHz4xpnSrrfCvy6TVVz5d4PdrjeshsWQwpZsZGzvbdAdN8MKV5QsBDY',
  ],
  ['271f359e', 'zzzzy'],
  ['271f359f', 'zzzzz'],
  ['271f35a0', '211111'],
  ['271f35a1', '211112'],
];

/** RFC 4648 §10 test vectors. */
const RFC4648: Array<[string, string, string]> = [
  // [text, base64 (padded), base64url (unpadded)]; none of these touch the two characters that differ.
  ['', '', ''],
  ['f', 'Zg==', 'Zg'],
  ['fo', 'Zm8=', 'Zm8'],
  ['foo', 'Zm9v', 'Zm9v'],
  ['foob', 'Zm9vYg==', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE=', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy', 'Zm9vYmFy'],
];

describe('base58btc', () => {
  it.each(BITCOIN_BASE58)('encodes %s and decodes it back (Bitcoin Core vector)', (bytesHex, text) => {
    expect(base58btcEncode(fromHex(bytesHex))).toBe(text);
    expect(hex(base58btcDecode(text))).toBe(bytesHex);
  });

  it('refuses characters outside the alphabet, including the look-alikes 0, O, I and l', () => {
    for (const bad of ['0', 'O', 'I', 'l', 'ab c', 'ab+c', 'é', '=']) {
      expect(() => base58btcDecode(bad)).toThrow(MultibaseError);
    }
  });

  it('bounds the work an attacker can ask for', () => {
    expect(() => base58btcDecode('2'.repeat(2049))).toThrow(MultibaseError);
    expect(() => base58btcEncode(new Uint8Array(1537))).toThrow(MultibaseError);
  });
});

describe('base64 and base64url', () => {
  it.each(RFC4648)('encodes and decodes %j (RFC 4648 §10)', (text, padded, unpadded) => {
    expect(base64Encode(ascii(text))).toBe(padded);
    expect(base64urlEncode(ascii(text))).toBe(unpadded);
    expect(Buffer.from(base64Decode(padded)).toString('ascii')).toBe(text);
    expect(Buffer.from(base64urlDecode(unpadded)).toString('ascii')).toBe(text);
  });

  it('uses - and _ in the URL alphabet and + and / in the standard one (RFC 4648 §5)', () => {
    const bytes = fromHex('fbffbf');

    expect(base64Encode(bytes)).toBe('+/+/');
    expect(base64urlEncode(bytes)).toBe('-_-_');
    expect(hex(base64urlDecode('-_-_'))).toBe('fbffbf');
    expect(hex(base64Decode('+/+/'))).toBe('fbffbf');
  });

  it('refuses the other alphabet, padding on base64url, whitespace and impossible lengths', () => {
    expect(() => base64urlDecode('+/+/')).toThrow(MultibaseError);
    expect(() => base64urlDecode('Zg==')).toThrow(MultibaseError);
    expect(() => base64urlDecode('Zm 8')).toThrow(MultibaseError);
    expect(() => base64urlDecode('Z')).toThrow(MultibaseError);
    expect(() => base64Decode('-_-_')).toThrow(MultibaseError);
    expect(() => base64Decode('Zg')).toThrow(MultibaseError);
    expect(() => base64Decode('Zm9v\n')).toThrow(MultibaseError);
    expect(() => base64Decode('Zg=')).toThrow(MultibaseError);
  });

  it('refuses text whose unused trailing bits are not zero, so one value has one spelling', () => {
    // "Zh==" and "Zg==" would both decode to "f" with a lenient decoder.
    expect(() => base64Decode('Zh==')).toThrow(MultibaseError);
    expect(() => base64urlDecode('Zh')).toThrow(MultibaseError);
    expect(() => base64Decode('Zm9=')).toThrow(MultibaseError);
    expect(() => base64urlDecode('Zm9')).toThrow(MultibaseError);
  });
});

describe('multibase', () => {
  it('prefixes z for base58btc and u for base64url without padding', () => {
    expect(multibaseEncode('z', ascii('ccc'))).toBe('zaPEr'); // Bitcoin Core vector 636363 -> aPEr
    expect(multibaseEncode('u', ascii('foob'))).toBe('uZm9vYg');
    expect(multibaseDecode('zaPEr')).toEqual({ prefix: 'z', bytes: ascii('ccc') });
    expect(multibaseDecode('uZm9vYg')).toEqual({ prefix: 'u', bytes: ascii('foob') });
  });

  it('accepts nothing but z and u', () => {
    for (const bad of ['', 'f616263', 'Zm9v', 'm', 'U']) {
      expect(() => multibaseDecode(bad)).toThrow(MultibaseError);
    }
  });
});

describe('sha256Multihash', () => {
  it('is 0x12 0x20 then the SHA-256 digest', () => {
    const multihash = sha256Multihash(ascii('abc'));

    expect(hex(multihash)).toBe('1220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(Buffer.from(multihash).subarray(2).equals(createHash('sha256').update('abc').digest())).toBe(true);
    expect(multibaseEncode('u', multihash).startsWith('uEiC')).toBe(true);
  });
});
