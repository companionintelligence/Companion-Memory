import {
  base58btcDecode,
  base58btcEncode,
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  isRecord,
  lengthPrefixed,
  multibaseDecodeBase58btc,
  multibaseEncodeBase58btc,
  parseJsonObject,
  uint32be,
  utf8Decode,
  utf8Encode,
  varintDecode,
  varintEncode,
} from './encoding';
import { DidcommError } from './errors';

describe('base64url', () => {
  it('round-trips without padding', () => {
    for (const hex of ['', '00', 'ff', 'fffe', 'fffefd', '00112233445566778899']) {
      const bytes = Buffer.from(hex, 'hex');
      const text = base64urlEncode(bytes);

      expect(text).not.toContain('=');
      expect(base64urlDecode(text, 'x').equals(bytes)).toBe(true);
    }
  });

  it('uses the URL alphabet', () => {
    expect(base64urlEncode(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });

  it.each([
    ['padding', 'AA=='],
    ['the standard alphabet', 'a+b/'],
    ['whitespace', 'AA AA'],
    ['a length that cannot occur', 'AAAAA'],
    ['non-zero trailing bits', 'AB'],
    ['a non-string', 42],
  ])('rejects %s', (_name, value) => {
    expect(() => base64urlDecode(value, 'x')).toThrow(DidcommError);
  });

  it('names what it was decoding and uses the requested error code', () => {
    try {
      base64urlDecode('a+', 'the "iv" member', 'invalid-key');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DidcommError);
      expect((error as DidcommError).code).toBe('invalid-key');
      expect((error as DidcommError).message).toContain('the "iv" member');
    }
  });
});

describe('utf8 and JSON helpers', () => {
  it('round-trips text and refuses invalid UTF-8', () => {
    expect(utf8Decode(utf8Encode('héllo ✓'), 'x')).toBe('héllo ✓');
    expect(() => utf8Decode(Uint8Array.from([0xff, 0xfe]), 'x')).toThrow(DidcommError);
  });

  it('parses a JSON object and nothing else', () => {
    expect(parseJsonObject('{"a":1}', 'x')).toEqual({ a: 1 });

    for (const bad of ['[]', '1', 'null', '"s"', '{', '']) {
      expect(() => parseJsonObject(bad, 'x')).toThrow(DidcommError);
    }
  });

  it('refuses an own "__proto__" member', () => {
    expect(() => parseJsonObject('{"__proto__":{"polluted":true}}', 'x')).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('isRecord excludes arrays and null', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('encodes big-endian lengths for Concat KDF', () => {
    expect(uint32be(256).toString('hex')).toBe('00000100');
    expect(lengthPrefixed(Buffer.from('ab')).toString('hex')).toBe('000000026162');
  });

  it('compares in constant time and tolerates unequal lengths', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('ab'))).toBe(false);
  });
});

describe('base58btc', () => {
  /** The Bitcoin Core base58 vectors (src/test/data/base58_encode_decode.json). */
  const VECTORS: Array<[string, string]> = [
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
  ];

  it.each(VECTORS)('encodes and decodes %s', (hex, text) => {
    expect(base58btcEncode(Buffer.from(hex, 'hex'))).toBe(text);
    expect(base58btcDecode(text).toString('hex')).toBe(hex);
  });

  it.each(['0', 'O', 'I', 'l', 'ab c', 'ab+c'])('rejects the invalid input %p', (text) => {
    expect(() => base58btcDecode(text)).toThrow(DidcommError);
  });

  it('refuses very long input instead of grinding through it', () => {
    expect(() => base58btcDecode('2'.repeat(5000))).toThrow(DidcommError);
  });

  it('maps independent published keys to the JWK x they stand for', () => {
    // From the DIF reference implementation's tests: the same Ed25519 key spelled as base58 (2018
    // suites) and as multibase (2020 suites), and an X25519 key as multibase.
    const ed25519X = 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA';
    const x25519X = 'BIiFcQEn3dfvB2pjlhOQQour6jXy9d5s2FKEJNTOJik';

    expect(base64urlEncode(base58btcDecode('ByHnpUCFb1vAfh9CFZ8ZkmUZguURW8nSw889hy6rD8L7'))).toBe(ed25519X);

    const ed = multibaseDecodeBase58btc('z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V');
    expect(Array.from(ed.subarray(0, 2))).toEqual([0xed, 0x01]);
    expect(base64urlEncode(ed.subarray(2))).toBe(ed25519X);

    const x = multibaseDecodeBase58btc('z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc');
    expect(Array.from(x.subarray(0, 2))).toEqual([0xec, 0x01]);
    expect(base64urlEncode(x.subarray(2))).toBe(x25519X);
  });
});

describe('multibase and multicodec', () => {
  it('prefixes base58btc with z and requires it back', () => {
    const bytes = Buffer.from('0102030405', 'hex');
    const text = multibaseEncodeBase58btc(bytes);

    expect(text.startsWith('z')).toBe(true);
    expect(multibaseDecodeBase58btc(text).equals(bytes)).toBe(true);
    expect(() => multibaseDecodeBase58btc(text.slice(1))).toThrow(/start with "z"/);
    expect(() => multibaseDecodeBase58btc('f0102')).toThrow(DidcommError);
  });

  it.each([
    [0xed, 'ed01'],
    [0xec, 'ec01'],
    [0xe7, 'e701'],
    [0x1200, '8024'],
    [0x1201, '8124'],
    [0x1202, '8224'],
    [0x7f, '7f'],
    [0, '00'],
  ])('encodes the multicodec code %p as the varint %s', (code, hex) => {
    expect(varintEncode(code).toString('hex')).toBe(hex);
    expect(varintDecode(Buffer.from(`${hex}ffff`, 'hex'))).toEqual({
      value: code,
      length: hex.length / 2,
    });
  });

  it('refuses a non-minimal, truncated or out-of-range varint', () => {
    expect(() => varintDecode(Buffer.from('8000', 'hex'))).toThrow(DidcommError);
    expect(() => varintDecode(Buffer.from('80', 'hex'))).toThrow(DidcommError);
    expect(() => varintDecode(Buffer.alloc(0))).toThrow(DidcommError);
    expect(() => varintEncode(-1)).toThrow(DidcommError);
    expect(() => varintEncode(0x200000)).toThrow(DidcommError);
  });
});
