import { JcsError, canonicalize } from './jcs';

/** The IEEE-754 double whose bit pattern is `hex`: RFC 8785 Appendix B specifies its inputs that way. */
function doubleFromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));

  return view.getFloat64(0);
}

describe('canonicalize (RFC 8785)', () => {
  it('orders keys by UTF-16 code unit — RFC 8785 §3.2.3', () => {
    // Every key is built from a code point number. Typing the characters (or backslash-u escapes for them)
    // is not safe: editors and tooling normalize or rewrite them, and this test is about exact code units.
    const char = (codePoint: number): string => String.fromCodePoint(codePoint);
    const euro = char(0x20ac);
    const hebrewDaletDagesh = char(0xfb33);
    const grinningFace = char(0x1f600); // two UTF-16 units: D83D DE00
    const control = char(0x80);
    const oDiaeresis = char(0xf6);

    const input: Record<string, string> = {
      [euro]: 'Euro Sign',
      [char(0x0d)]: 'Carriage Return',
      [hebrewDaletDagesh]: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      [grinningFace]: 'Emoji: Grinning Face',
      [control]: 'Control',
      [oDiaeresis]: 'Latin Small Letter O With Diaeresis',
    };

    // Code-unit order: CR, "1", U+0080, U+00F6, U+20AC, U+D83D.., U+FB33. The emoji sorts BEFORE the
    // Hebrew letter, which a code-point sort would get backwards. CR is escaped; nothing else is.
    expect(canonicalize(input)).toBe(
      `{"${char(0x5c)}r":"Carriage Return","1":"One","${control}":"Control","${oDiaeresis}":"Latin Small Letter O With Diaeresis",` +
        `"${euro}":"Euro Sign","${grinningFace}":"Emoji: Grinning Face","${hebrewDaletDagesh}":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  it('sorts nested objects and leaves array order alone', () => {
    expect(canonicalize({ b: [3, 1, 2], a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1},"b":[3,1,2]}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize(JSON.parse('{ "a" : [ 1 , 2 ] , "b" : null }'))).toBe('{"a":[1,2],"b":null}');
  });

  describe('numbers — RFC 8785 Appendix B', () => {
    const table: [string, string][] = [
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
    ];

    for (const [hex, expected] of table) {
      it(`${hex} → ${expected}`, () => {
        expect(canonicalize(doubleFromHex(hex))).toBe(expected);
      });
    }
  });

  it('escapes exactly what RFC 8785 §3.2.2.2 prescribes', () => {
    const input = '\u0000\u001f\b\t\n\f\r"\\/\u007f é€';

    expect(canonicalize(input)).toBe('"\\u0000\\u001f\\b\\t\\n\\f\\r\\"\\\\/\u007f é€"');
  });

  it('omits members whose value is undefined, as JSON.stringify does', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  describe('refuses what has no canonical form', () => {
    const refused: [string, unknown][] = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a lone high surrogate', '\ud800'],
      ['a lone low surrogate in a key', { '\udc00': 1 }],
      ['a Date', new Date(0)],
      ['a Map', new Map()],
      ['a class instance', new (class Foo {})()],
      ['undefined inside an array', [1, undefined]],
      ['a bigint', 1n],
      ['a function', () => 1],
      ['a symbol', Symbol('x')],
    ];

    for (const [label, input] of refused) {
      it(label, () => {
        expect(() => canonicalize(input)).toThrow(JcsError);
      });
    }

    it('nesting deeper than the bound', () => {
      let nested: unknown = 1;
      for (let depth = 0; depth < 200; depth += 1) {
        nested = [nested];
      }

      expect(() => canonicalize(nested)).toThrow(/deeper than 128/);
      expect(() => canonicalize(nested, 500)).not.toThrow();
    });
  });
});
