import { randomBytes } from 'node:crypto';

import { IdentiKeyError } from '../errors';

import { BASE58_MAX_BYTES, BASE58_MAX_CHARS, base58Decode, base58Encode } from './base58';

const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));

/**
 * Bitcoin Core's `base58_encode_decode.json`, plus "Hello World!". Every pair below was ALSO produced
 * by an independent big-integer implementation (the generator in `__tests__/fixtures/README.md`), so a
 * typo here cannot hide a bug in the code under test.
 */
const VECTORS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['00', '1'],
  ['0000', '11'],
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
  ['48656c6c6f20576f726c6421', '2NEpo7TZRRrLZSi2U'],
];

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

describe('base58', () => {
  it.each(VECTORS)('encodes %p as %p and decodes it back', (input, expected) => {
    expect(base58Encode(hex(input))).toBe(expected);
    expect(Buffer.from(base58Decode(expected)).toString('hex')).toBe(input);
  });

  it('keeps every leading zero byte, as a leading "1"', () => {
    expect(base58Encode(hex('000001'))).toBe('112');
    expect(Array.from(base58Decode('112'))).toEqual([0, 0, 1]);
  });

  it.each(['0', 'O', 'I', 'l', ' ', '+', '/', '=', 'é', '１'])(
    'refuses %p, which is not in the alphabet',
    (char) => {
      expect(codeOf(() => base58Decode(`2${char}2`))).toBe('malformed');
    },
  );

  it('round-trips random byte strings of every length up to 64, with and without leading zeros', () => {
    for (let length = 0; length <= 64; length += 1) {
      const plain = new Uint8Array(randomBytes(length));
      const padded = new Uint8Array([0, 0, ...randomBytes(length)]);
      for (const bytes of [plain, padded]) {
        expect(Array.from(base58Decode(base58Encode(bytes)))).toEqual(Array.from(bytes));
      }
    }
  });

  describe('the size ceiling', () => {
    it('encodes exactly the maximum, whose longest spelling is 350 characters', () => {
      const largest = base58Encode(new Uint8Array(BASE58_MAX_BYTES).fill(0xff));

      expect(largest).toHaveLength(350);
      expect(largest.length).toBeLessThanOrEqual(BASE58_MAX_CHARS);
      expect(Array.from(base58Decode(largest))).toEqual(Array.from({ length: BASE58_MAX_BYTES }, () => 0xff));
    });

    it('refuses one byte more', () => {
      expect(codeOf(() => base58Encode(new Uint8Array(BASE58_MAX_BYTES + 1)))).toBe('malformed');
    });

    it('refuses over-long text before doing any of the quadratic work', () => {
      const started = Date.now();

      expect(codeOf(() => base58Decode('2'.repeat(BASE58_MAX_CHARS + 1)))).toBe('malformed');
      expect(codeOf(() => base58Decode('2'.repeat(1_000_000)))).toBe('malformed');
      expect(Date.now() - started).toBeLessThan(250);
    });

    it('refuses text within the character limit that still decodes past the byte limit', () => {
      // 351 characters of the largest digit is a number of about 257 bytes.
      expect(codeOf(() => base58Decode('z'.repeat(BASE58_MAX_CHARS)))).toBe('malformed');
    });
  });
});
