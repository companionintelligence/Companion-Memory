import { canonicalize, JcsError } from './jcs';

/**
 * Every expected string below is copied from RFC 8785 (§3.2.2 sample, §3.2.3 sorting example, Appendix B number
 * table), not produced by the code under test.
 *
 * Inputs the RFC writes with \u escapes are built from code points here, so the test source holds no escape
 * sequence that an editor or tool could rewrite on the way to disk.
 */

const BACKSLASH = String.fromCharCode(92);
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

/** The IEEE-754 double whose big-endian hex form is `hex`, as Appendix B prints them. */
const doubleFromHex = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));

  return view.getFloat64(0);
};

describe('canonicalize (RFC 8785)', () => {
  it('turns the RFC 8785 §3.2.2 sample into its canonical form', () => {
    // The string member of the RFC sample once parsed: U+20AC, "$", U+000F, U+000A, "A", "'", "B", a quote,
    // two backslashes, a quote and a slash.
    const parsedString = cp(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f);
    const sample = {
      // The RFC's own number text, run through JSON.parse so that number parsing is exercised, not bypassed.
      numbers: JSON.parse(
        '[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]',
      ) as number[],
      string: parsedString,
      literals: [null, true, false],
    };

    expect(canonicalize(sample)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' +
        [
          cp(0x20ac),
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
      [cp(0x20ac), 'Euro Sign'],
      [cp(0x0d), 'Carriage Return'],
      [cp(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
      ['1', 'One'],
      [cp(0x1f600), 'Emoji: Grinning Face'],
      [cp(0x80), 'Control'],
      [cp(0xf6), 'Latin Small Letter O With Diaeresis'],
    ]);

    // RFC order of the values: Carriage Return, One, Control, Latin Small Letter O With Diaeresis, Euro Sign,
    // Emoji, Hebrew Letter Dalet With Dagesh. The emoji is a surrogate pair (D83D DE00), so it sorts before
    // U+FB33 even though its code point is larger.
    expect(canonicalize(sample)).toBe(
      '{' +
        [
          `"${BACKSLASH}r":"Carriage Return"`,
          '"1":"One"',
          `"${cp(0x80)}":"Control"`,
          `"${cp(0xf6)}":"Latin Small Letter O With Diaeresis"`,
          `"${cp(0x20ac)}":"Euro Sign"`,
          `"${cp(0x1f600)}":"Emoji: Grinning Face"`,
          `"${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"`,
        ].join(',') +
        '}',
    );
  });

  describe('ECMAScript number serialization (RFC 8785 Appendix B)', () => {
    const rows: Array<[string, string]> = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'], // minus zero
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
    ];

    it.each(rows)('writes the double %s as %s', (hex, expected) => {
      expect(canonicalize(doubleFromHex(hex))).toBe(expected);
    });
  });

  describe('strings', () => {
    it('escapes only what RFC 8785 §3.2.2.2 escapes, in lowercase hex', () => {
      const controls = Array.from({ length: 32 }, (_, i) => cp(i)).join('');
      const expected = [
        'u0000',
        'u0001',
        'u0002',
        'u0003',
        'u0004',
        'u0005',
        'u0006',
        'u0007',
        'b',
        't',
        'n',
        'u000b',
        'f',
        'r',
        'u000e',
        'u000f',
        'u0010',
        'u0011',
        'u0012',
        'u0013',
        'u0014',
        'u0015',
        'u0016',
        'u0017',
        'u0018',
        'u0019',
        'u001a',
        'u001b',
        'u001c',
        'u001d',
        'u001e',
        'u001f',
      ]
        .map((escape) => `${BACKSLASH}${escape}`)
        .join('');

      expect(canonicalize(controls)).toBe(`"${expected}"`);
    });

    it('leaves DEL, U+2028 and astral characters literal, and escapes the quote and the backslash', () => {
      const text = cp(0x7f, 0x2028, 0x2029, 0x1f600, 0x22, 0x5c);

      expect(canonicalize(text)).toBe(
        `"${cp(0x7f, 0x2028, 0x2029, 0x1f600)}${BACKSLASH}"${BACKSLASH}${BACKSLASH}"`,
      );
    });

    it('refuses an unpaired surrogate in a string and in a property name', () => {
      const highAlone = String.fromCharCode(0xd83d);
      const lowAlone = String.fromCharCode(0xde00);

      expect(() => canonicalize(highAlone)).toThrow(JcsError);
      expect(() => canonicalize(`a${lowAlone}`)).toThrow(JcsError);
      expect(() => canonicalize(`${highAlone}a`)).toThrow(JcsError);
      expect(() => canonicalize({ [highAlone]: 1 })).toThrow(JcsError);
      expect(canonicalize(cp(0x1f600))).toBe(`"${cp(0x1f600)}"`);
    });
  });

  describe('values that have no JSON form are refused, not silently dropped', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['undefined', undefined],
      ['a bigint', 10n],
      ['a function', () => 1],
      ['a symbol', Symbol('s')],
      ['a Date', new Date(0)],
      ['a Map', new Map()],
      ['a class instance', new (class Thing {})()],
    ])('refuses %s', (_name, value) => {
      expect(() => canonicalize(value)).toThrow(JcsError);
    });

    it('refuses an undefined member where JSON.stringify would drop it', () => {
      expect(() => canonicalize({ a: 1, b: undefined })).toThrow(JcsError);
      expect(JSON.stringify({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it('refuses an array hole and an undefined element where JSON.stringify would write null', () => {
      // eslint-disable-next-line no-sparse-arrays
      expect(() => canonicalize([1, , 3])).toThrow(JcsError);
      expect(() => canonicalize([1, undefined])).toThrow(JcsError);
    });

    it('accepts an object with a null prototype', () => {
      const bare = Object.assign(Object.create(null) as Record<string, number>, { b: 2, a: 1 });

      expect(canonicalize(bare)).toBe('{"a":1,"b":2}');
    });
  });

  describe('structure', () => {
    it('writes minus zero as 0 and keeps array order', () => {
      expect(canonicalize([-0, 3, 1, 2])).toBe('[0,3,1,2]');
    });

    it('sorts recursively and drops all insignificant whitespace', () => {
      expect(canonicalize({ b: { d: 1, c: [{ z: 1, y: 2 }] }, a: null })).toBe(
        '{"a":null,"b":{"c":[{"y":2,"z":1}],"d":1}}',
      );
    });

    it('stops at 64 levels of nesting', () => {
      const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);

      expect(canonicalize(nest(64))).toBe(`${'['.repeat(64)}1${']'.repeat(64)}`);
      expect(() => canonicalize(nest(65))).toThrow(JcsError);
    });

    it('is idempotent: re-canonicalizing its own output changes nothing', () => {
      const value = { z: [1, 2.5, { y: 'x', a: [true, null] }], a: 'é', m: { 10: 1, 9: 2, b: 3 } };
      const once = canonicalize(value);

      expect(canonicalize(JSON.parse(once))).toBe(once);
    });
  });
});
