import { IdentiKeyError } from '../errors';

import {
  asArray,
  asBytes,
  asSafeUint,
  asText,
  asUint,
  cbor,
  closedMap,
  decode,
  encode,
  type Cbor,
} from './dcbor';

const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof IdentiKeyError) {
      return error.code;
    }

    throw error;
  }

  return 'no error';
}

describe('dCBOR subset', () => {
  describe('encoding, against bytes written out by hand from RFC 8949', () => {
    it.each<[string, Cbor, string]>([
      ['uint 0', cbor.uint(0), '00'],
      ['uint 23, the last single-byte form', cbor.uint(23), '17'],
      ['uint 24, the first one-byte argument', cbor.uint(24), '1818'],
      ['uint 255', cbor.uint(255), '18ff'],
      ['uint 256, the first two-byte argument', cbor.uint(256), '190100'],
      ['uint 65535', cbor.uint(65535), '19ffff'],
      ['uint 65536, the first four-byte argument', cbor.uint(65536), '1a00010000'],
      ['uint 4294967295', cbor.uint(4294967295), '1affffffff'],
      ['uint 4294967296, the first eight-byte argument', cbor.uint(4294967296), '1b0000000100000000'],
      ['uint 1700000000 (a timestamp)', cbor.uint(1700000000), '1a6553f100'],
      ['uint 2^64 - 1', cbor.uint((1n << 64n) - 1n), '1bffffffffffffffff'],
      ['an empty byte string', cbor.bytes(new Uint8Array(0)), '40'],
      ['bytes 01020304', cbor.bytes(hex('01020304')), '4401020304'],
      [
        'a 24-byte string, whose length needs the extra byte',
        cbor.bytes(new Uint8Array(24)),
        `5818${'00'.repeat(24)}`,
      ],
      ['an empty text string', cbor.text(''), '60'],
      ['text "a"', cbor.text('a'), '6161'],
      ['text "IETF"', cbor.text('IETF'), '6449455446'],
      ['text "ü", two bytes of UTF-8', cbor.text('ü'), '62c3bc'],
      ['text "水", three bytes of UTF-8', cbor.text('水'), '63e6b0b4'],
      ['an astral character, four bytes of UTF-8', cbor.text('\u{10151}'), '64f0908591'],
      ['an empty array', cbor.array([]), '80'],
      ['[1, 2, 3]', cbor.array([cbor.uint(1), cbor.uint(2), cbor.uint(3)]), '83010203'],
      ['an empty map', cbor.map([]), 'a0'],
    ])('%s', (_label, value, expected) => {
      expect(toHex(encode(value))).toBe(expected);
    });

    it('orders map keys by their ENCODED bytes, whatever order they were given in', () => {
      const entries: [string, Cbor][] = [
        ['nonce', cbor.uint(5)],
        ['iat', cbor.uint(3)],
        ['v', cbor.uint(1)],
        ['exp', cbor.uint(4)],
        ['aud', cbor.uint(2)],
      ];
      const forward = encode(cbor.map(entries));
      const backward = encode(cbor.map([...entries].reverse()));

      // v (61 76) < aud (63 61..) < exp (63 65..) < iat (63 69..) < nonce (65 ..)
      expect(toHex(forward)).toBe(
        'a5' +
          '6176' +
          '01' +
          '63617564' +
          '02' +
          '63657870' +
          '04' +
          '63696174' +
          '03' +
          '656e6f6e6365' +
          '05',
      );
      expect(toHex(backward)).toBe(toHex(forward));
    });

    it('sorts by encoded bytes (length first), which is NOT string order', () => {
      // As strings "aa" < "b". Encoded, "b" is 61 62 and "aa" is 62 61 61, so "b" comes first.
      const encoded = encode(
        cbor.map([
          ['aa', cbor.uint(1)],
          ['b', cbor.uint(2)],
        ]),
      );

      expect(toHex(encoded)).toBe('a2' + '6162' + '02' + '626161' + '01');
    });

    it('refuses a duplicate key rather than picking one', () => {
      expect(
        codeOf(() =>
          encode(
            cbor.map([
              ['a', cbor.uint(1)],
              ['a', cbor.uint(2)],
            ]),
          ),
        ),
      ).toBe('malformed');
    });

    it('refuses text that is not well-formed Unicode, instead of encoding U+FFFD in its place', () => {
      expect(codeOf(() => encode(cbor.text('\ud800')))).toBe('malformed');
      expect(codeOf(() => encode(cbor.text('x\udc00y')))).toBe('malformed');
      expect(codeOf(() => encode(cbor.map([['\ud83d', cbor.uint(1)]])))).toBe('malformed');
      // A correctly paired surrogate is a character, and is fine.
      expect(toHex(encode(cbor.text('😀')))).toBe('64f09f9880');
    });

    it('will not build a value it would have to mangle', () => {
      expect(() => cbor.uint(-1)).toThrow(RangeError);
      expect(() => cbor.uint(1.5)).toThrow(RangeError);
      expect(() => cbor.uint(Number.NaN)).toThrow(RangeError);
      expect(() => cbor.uint(Number.MAX_SAFE_INTEGER + 1)).toThrow(/bigint/);
      expect(() => cbor.uint(1n << 64n)).toThrow(RangeError);
      expect(() => cbor.uint(-1n)).toThrow(RangeError);
    });
  });

  describe('decoding accepts exactly what encoding produces', () => {
    it('reads back every value the encoder test wrote', () => {
      const value = cbor.map([
        ['a', cbor.uint(1)],
        ['bb', cbor.array([cbor.text('x'), cbor.bytes(hex('0102')), cbor.map([['k', cbor.uint(70000)]])])],
      ]);

      expect(decode(encode(value))).toEqual(value);
    });

    it('keeps a leading byte-order mark instead of dropping it', () => {
      const decoded = decode(hex('63efbbbf'));

      expect(asText(decoded)).toBe('﻿');
    });

    it('round-trips 300 random structures byte for byte (fixed seed)', () => {
      let state = 0x2545f491;
      const next = (): number => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;

        return (state >>> 0) / 0x100000000;
      };

      const pick = (n: number): number => Math.floor(next() * n);

      const make = (depth: number): Cbor => {
        const kind = pick(depth >= 3 ? 3 : 5);
        switch (kind) {
          case 0:
            return cbor.uint(
              [0, 23, 24, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1][pick(10)],
            );
          case 1:
            return cbor.bytes(new Uint8Array(pick(40)).map(() => pick(256)));
          case 2:
            return cbor.text(['', 'a', 'v', 'aud', 'ü', '水', '😀', 'x'.repeat(30)][pick(8)]);
          case 3:
            return cbor.array(Array.from({ length: pick(4) }, () => make(depth + 1)));
          default: {
            const keys = ['v', 'aud', 'exp', 'iat', 'nonce', 'b', 'aa', 'ü', 'long-key-'.repeat(3)];
            const chosen = keys.filter(() => next() < 0.4);

            return cbor.map(chosen.map((key): [string, Cbor] => [key, make(depth + 1)]));
          }
        }
      };

      for (let i = 0; i < 300; i += 1) {
        const bytes = encode(make(0));

        expect(toHex(encode(decode(bytes)))).toBe(toHex(bytes));
      }
    });
  });

  describe('decoding REFUSES everything that is not the one canonical form', () => {
    it.each([
      ['a one-byte argument that fits in the head (0 as 18 00)', '1800'],
      ['23 as 18 17', '1817'],
      ['a two-byte argument that fits in one byte (19 00ff)', '1900ff'],
      ['a four-byte argument that fits in two (1a 0000ffff)', '1a0000ffff'],
      ['an eight-byte argument that fits in four (1b 00000000ffffffff)', '1b00000000ffffffff'],
      ['a non-minimal byte-string length', '580100'],
      ['a non-minimal array count', '9801' + '00'],
      ['a non-minimal map count', 'b801' + '6161' + '00'],
    ])('non-minimal integers: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it.each([
      ['an indefinite array', '9f01ff'],
      ['an indefinite byte string', '5f4101ff'],
      ['an indefinite text string', '7f6161ff'],
      ['an indefinite map', 'bf616101ff'],
      ['a stray break', 'ff'],
      ['a reserved additional-information value (1c)', '1c'],
    ])('indefinite or reserved forms: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it.each([
      ['a half-precision float', 'f93c00'],
      ['a single-precision float', 'fa3fc00000'],
      ['a double-precision float', 'fb3ff8000000000000'],
      ['false', 'f4'],
      ['true', 'f5'],
      ['null', 'f6'],
      ['undefined', 'f7'],
      ['a tag (0: date/time text)', 'c074323031332d30332d32315432303a30343a30305a'],
      ['a tag with a one-byte number (24)', 'd8184100'],
      ['a negative integer', '20'],
      ['a larger negative integer', '3863'],
    ])('values outside the subset: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it.each([
      ['an integer map key', 'a10101'],
      ['a byte-string map key', 'a1410100'],
      ['keys in the wrong order (b before a)', 'a2' + '6162' + '01' + '6161' + '02'],
      ['a repeated key', 'a2' + '6161' + '01' + '6161' + '02'],
      ['a longer key before a shorter one ("aa" before "b")', 'a2' + '626161' + '01' + '6162' + '02'],
    ])('malformed maps: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it.each([
      ['a continuation byte alone', '61' + '80'],
      ['0xff, which is never valid UTF-8', '61' + 'ff'],
      ['a truncated sequence', '62' + 'c3' + '28'],
      ['an overlong encoding of "/"', '62' + 'c0af'],
      ['a UTF-8-encoded surrogate (U+D800)', '63' + 'eda080'],
      ['a code point beyond U+10FFFF', '64' + 'f4908080'],
    ])('invalid UTF-8: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it.each([
      ['a byte string cut short', '44010203'],
      ['an empty input', ''],
      ['a head with its argument missing', '19ff'],
      ['bytes after the value', '0000'],
      ['a byte-string length larger than the input', '5bffffffffffffffff'],
      ['an array count larger than the input', '9bffffffffffffffff'],
      ['a text length larger than the input', '7affffffff'],
      ['a map count larger than the input', 'bbffffffffffffffff'],
    ])('truncated or oversized: %s', (_label, input) => {
      expect(codeOf(() => decode(hex(input)))).toBe('malformed');
    });

    it('allows nesting up to the depth limit and refuses one level more', () => {
      const nested = (arrays: number): Uint8Array => hex('81'.repeat(arrays) + '00');

      expect(() => decode(nested(16))).not.toThrow();
      expect(codeOf(() => decode(nested(17)))).toBe('malformed');
      expect(() => decode(nested(3), { maxDepth: 3 })).not.toThrow();
      expect(codeOf(() => decode(nested(4), { maxDepth: 3 }))).toBe('malformed');
    });

    it('does not recurse its way to a stack overflow on deep hostile input', () => {
      expect(codeOf(() => decode(hex('81'.repeat(60_000) + '00'), { maxBytes: 100_000 }))).toBe('malformed');
    });

    it('refuses input over the size limit before reading it', () => {
      expect(codeOf(() => decode(new Uint8Array(65 * 1024)))).toBe('malformed');
      expect(codeOf(() => decode(new Uint8Array(11), { maxBytes: 10 }))).toBe('malformed');
      expect(() => decode(hex('00'), { maxBytes: 1 })).not.toThrow();
    });
  });

  describe('reading values out', () => {
    it('returns the type asked for and refuses the others', () => {
      expect(asUint(cbor.uint(7))).toBe(7n);
      expect(Array.from(asBytes(cbor.bytes(hex('0a'))))).toEqual([10]);
      expect(asText(cbor.text('hi'))).toBe('hi');
      expect(asArray(cbor.array([]))).toEqual([]);

      expect(codeOf(() => asUint(cbor.text('7')))).toBe('malformed');
      expect(codeOf(() => asBytes(cbor.text('7')))).toBe('malformed');
      expect(codeOf(() => asText(cbor.uint(7)))).toBe('malformed');
      expect(codeOf(() => asArray(cbor.map([])))).toBe('malformed');
    });

    it('treats a uint as a JS number only when that is exact', () => {
      expect(asSafeUint(cbor.uint(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
      expect(codeOf(() => asSafeUint(cbor.uint(BigInt(Number.MAX_SAFE_INTEGER) + 1n)))).toBe('malformed');
    });
  });

  describe('closedMap', () => {
    const map = cbor.map([
      ['a', cbor.uint(1)],
      ['b', cbor.uint(2)],
    ]);

    it('returns the members of a map that has exactly what was asked for', () => {
      const members = closedMap(map, ['a', 'b']);

      expect(members.get('a')).toEqual(cbor.uint(1));
      expect(members.size).toBe(2);
    });

    it('allows optional members to be present or absent', () => {
      expect(closedMap(map, ['a'], ['b']).size).toBe(2);
      expect(closedMap(cbor.map([['a', cbor.uint(1)]]), ['a'], ['b']).size).toBe(1);
    });

    it('refuses a member nobody defined', () => {
      expect(codeOf(() => closedMap(map, ['a']))).toBe('malformed');
    });

    it('refuses a missing required member', () => {
      expect(codeOf(() => closedMap(map, ['a', 'b', 'c']))).toBe('malformed');
    });

    it('refuses something that is not a map', () => {
      expect(codeOf(() => closedMap(cbor.array([]), []))).toBe('malformed');
    });
  });
});
