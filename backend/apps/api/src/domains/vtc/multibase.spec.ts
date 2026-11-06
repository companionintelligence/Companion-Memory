import {
  base58btcDecode,
  base58btcEncode,
  decodeMultibaseBase58btc,
  decodeMultibaseBase64url,
  encodeMultibaseBase58btc,
  encodeMultibaseBase64url,
  MultibaseError,
} from './multibase';

describe('base58btc', () => {
  // The Bitcoin Core base58 vectors, re-checked against an independent big-integer encoder when
  // this file was written. Leading zero bytes become leading '1's.
  it.each([
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
  ])('encodes %s as %s and decodes it back', (hex, text) => {
    const bytes = Buffer.from(hex, 'hex');

    expect(base58btcEncode(bytes)).toBe(text);
    expect(Buffer.from(base58btcDecode(text)).toString('hex')).toBe(hex);
  });

  it.each(['0', 'O', 'I', 'l', 'abc+', 'a b', 'é', '😀'])(
    'refuses %j, which is outside the alphabet',
    (text) => {
      expect(() => base58btcDecode(text)).toThrow(MultibaseError);
    },
  );

  it('refuses text longer than anything this module decodes', () => {
    expect(() => base58btcDecode('2'.repeat(513))).toThrow(MultibaseError);
    expect(() => base58btcDecode('2'.repeat(512))).not.toThrow();
  });

  it('round-trips data of every small length, from a fixed formula and with a leading zero byte for some', () => {
    for (let length = 0; length < 80; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + length) % 256);
      bytes[0] = length % 3 === 0 ? 0 : bytes[0];

      expect(Array.from(base58btcDecode(base58btcEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('multibase prefixes', () => {
  it('writes and reads z + base58btc', () => {
    expect(encodeMultibaseBase58btc(Buffer.from('61', 'hex'))).toBe('z2g');
    expect(Buffer.from(decodeMultibaseBase58btc('z2g')).toString('hex')).toBe('61');
  });

  it('refuses a base58btc value under another prefix', () => {
    for (const text of ['2g', 'u2g', 'f61', 'm', '']) {
      expect(() => decodeMultibaseBase58btc(text)).toThrow(MultibaseError);
    }
  });

  it('writes and reads u + base64url without padding', () => {
    expect(encodeMultibaseBase64url(Buffer.from([0xfb, 0xff]))).toBe('u-_8');
    expect(Array.from(decodeMultibaseBase64url('u-_8'))).toEqual([0xfb, 0xff]);
    expect(Array.from(decodeMultibaseBase64url('u'))).toEqual([]);
  });

  it.each([
    ['standard alphabet', 'u+/8'],
    ['padding', 'u-_8='],
    ['wrong prefix', 'z-_8'],
    ['no prefix', '-_8'],
    ['length of 1 mod 4', 'uA'],
    ['non-zero trailing bits', 'uAB'],
    ['whitespace', 'u-_ 8'],
  ])('refuses base64url with %s', (_name, text) => {
    expect(() => decodeMultibaseBase64url(text)).toThrow(MultibaseError);
  });
});
