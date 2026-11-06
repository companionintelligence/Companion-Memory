import { IdentiKeyError } from '../errors';

import { decodeTagged, encodeTagged } from './tagged';

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

describe('tagged base64 (b64:)', () => {
  it('uses standard base64 with padding behind a "b64:" tag', () => {
    expect(encodeTagged(Uint8Array.of(1, 2, 3))).toBe('b64:AQID');
    expect(encodeTagged(Uint8Array.of(1))).toBe('b64:AQ==');
    expect(encodeTagged(Uint8Array.of(0xfb, 0xff))).toBe('b64:+/8=');
    expect(encodeTagged(new Uint8Array(0))).toBe('b64:');
  });

  it('round-trips every length from 0 to 40', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) & 0xff);

      expect(Array.from(decodeTagged(encodeTagged(bytes), 64))).toEqual(Array.from(bytes));
    }
  });

  it.each([
    ['no tag', 'AQID'],
    ['the wrong tag', 'b58:AQID'],
    ['a tag in the wrong case', 'B64:AQID'],
    ['the URL-safe alphabet', 'b64:-_8='],
    ['missing padding', 'b64:AQ'],
    ['too much padding', 'b64:AQ==='],
    ['embedded whitespace', 'b64:AQ ID'],
    ['a trailing newline', 'b64:AQID\n'],
    ['non-zero padding bits (a second spelling of [1])', 'b64:AR=='],
    ['characters outside the alphabet', 'b64:AQI*'],
  ])('refuses %s', (_label, text) => {
    expect(codeOf(() => decodeTagged(text, 64))).toBe('malformed');
  });

  it('enforces the caller’s limit exactly', () => {
    const text = encodeTagged(new Uint8Array(32));

    expect(decodeTagged(text, 32)).toHaveLength(32);
    expect(codeOf(() => decodeTagged(text, 31))).toBe('malformed');
  });

  it('bounds the work by the limit, not by the input', () => {
    const started = Date.now();

    expect(codeOf(() => decodeTagged(`b64:${'A'.repeat(4_000_000)}`, 16))).toBe('malformed');
    expect(Date.now() - started).toBeLessThan(250);
  });
});
