import { canonicalize, JcsError } from './jcs';

/**
 * The §3.2.2 sample, the Appendix B number table and the NaN and Infinity refusals are copied from
 * RFC 8785, not produced by the code under test. The rest (member sorting, escapes, refusals of
 * values with no JSON form) are the author's own expectations of what the RFC's rules imply.
 *
 * Inputs that the RFC writes with \u escapes are built from code points here instead, so the test
 * source holds no escape sequence a tool could rewrite on the way to disk.
 */

const BACKSLASH = String.fromCharCode(92);

describe('canonicalize (RFC 8785)', () => {
  it('turns the RFC 8785 §3.2.2 sample into its §3.2.3 canonical form', () => {
    // The string member of the RFC sample once parsed: U+20AC, "$", U+000F, U+000A, "A", "'", "B",
    // a quote, two backslashes, a quote and a slash.
    const parsedString = String.fromCodePoint(
      0x20ac,
      0x24,
      0x0f,
      0x0a,
      0x41,
      0x27,
      0x42,
      0x22,
      0x5c,
      0x5c,
      0x22,
      0x2f,
    );

    const sample = {
      // The RFC's number text, run through JSON.parse so number handling is exercised, not bypassed.
      numbers: JSON.parse(
        '[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]',
      ) as number[],
      string: parsedString,
      literals: [null, true, false],
    };

    expect(canonicalize(sample)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' +
        [
          String.fromCodePoint(0x20ac),
          '$',
          `${BACKSLASH}u000f`,
          `${BACKSLASH}n`,
          "A'B",
          `${BACKSLASH}"`,
          BACKSLASH.repeat(4),
          `${BACKSLASH}"`,
          '/',
        ].join('') +
        '"}',
    );
  });

  it('sorts property names by UTF-16 code unit, as RFC 8785 §3.2.3 requires', () => {
    const sample = Object.fromEntries([
      [String.fromCodePoint(0x20ac), 'Euro Sign'],
      [String.fromCharCode(13), 'Carriage Return'],
      [String.fromCodePoint(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
      ['1', 'One'],
      [String.fromCodePoint(0x1f600), 'Emoji: Grinning Face'],
      [String.fromCodePoint(0x80), 'Control'],
      [String.fromCodePoint(0xf6), 'Latin Small Letter O With Diaeresis'],
    ]);

    const values = [...canonicalize(sample).matchAll(/:"([^"]*)"/g)].map((match) => match[1]);

    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  describe('number serialization (RFC 8785 Appendix B)', () => {
    const asNumber = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

    it.each([
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ])('writes IEEE 754 %s as %s', (hex, expected) => {
      expect(canonicalize(asNumber(hex))).toBe(expected);
    });

    it.each([
      ['NaN', '7fffffffffffffff'],
      ['Infinity', '7ff0000000000000'],
    ])('refuses %s, which JSON cannot hold (RFC 8785 §3.2.2.3)', (_name, hex) => {
      expect(() => canonicalize(asNumber(hex))).toThrow(JcsError);
    });
  });

  it('does not depend on the order the members were written in', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects, including those inside arrays, and keeps array order', () => {
    expect(canonicalize({ z: [{ b: 1, a: 2 }, 'x', null], a: { d: true, c: false } })).toBe(
      '{"a":{"c":false,"d":true},"z":[{"a":2,"b":1},"x",null]}',
    );
  });

  it('keeps integer-like names in string order, not numeric order', () => {
    expect(canonicalize({ '10': 'a', '9': 'b', '1': 'c' })).toBe('{"1":"c","10":"a","9":"b"}');
  });

  it('writes no whitespace and escapes control characters in lower-case hex', () => {
    const value = { k: `a${String.fromCharCode(1, 0x1f)} b` };

    expect(canonicalize(value)).toBe(`{"k":"a${BACKSLASH}u0001${BACKSLASH}u001f b"}`);
  });

  it('leaves characters outside the control range, including DEL, unescaped', () => {
    expect(canonicalize({ k: String.fromCharCode(0x7f) })).toBe(`{"k":"${String.fromCharCode(0x7f)}"}`);
  });

  describe('refuses what has no JSON form instead of dropping it', () => {
    class Custom {
      readonly value = 1;
    }

    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    const sparse = [1, 2, 3];
    delete sparse[1];

    it.each([
      ['undefined member', { a: undefined }],
      ['undefined item', [undefined]],
      ['function', { a: () => 1 }],
      ['bigint', { a: 1n }],
      ['symbol', { a: Symbol('x') }],
      ['Date', { a: new Date(0) }],
      ['Map', { a: new Map() }],
      ['class instance', { a: new Custom() }],
      ['sparse array', sparse],
      ['unpaired high surrogate', { a: high }],
      ['unpaired low surrogate', { a: low }],
      ['high surrogate followed by a letter', { a: `${high}x` }],
      ['unpaired surrogate in a name', { [high]: 1 }],
    ])('%s', (_name, value) => {
      expect(() => canonicalize(value)).toThrow(JcsError);
    });

    it('accepts a surrogate pair', () => {
      const pair = String.fromCodePoint(0x1f600);

      expect(canonicalize({ a: pair })).toBe(`{"a":"${pair}"}`);
    });

    it('stops at 64 levels of nesting', () => {
      const nest = (levels: number): unknown => (levels === 0 ? 1 : [nest(levels - 1)]);

      expect(() => canonicalize(nest(64))).not.toThrow();
      expect(() => canonicalize(nest(66))).toThrow(JcsError);
    });
  });
});
