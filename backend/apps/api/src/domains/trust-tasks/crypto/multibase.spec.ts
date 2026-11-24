import {
  base58btcDecode,
  base58btcEncode,
  base64urlDecode,
  decodeEd25519Multikey,
  encodeEd25519Multikey,
  multibaseDecode,
  multibaseEncode,
  sha256Multihash,
} from './multibase';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('base58btc', () => {
  it('encodes the standard vector', () => {
    expect(base58btcEncode(text('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58btcDecode('2NEpo7TZRRrLZSi2U')).toEqual(text('Hello World!'));
  });

  it('keeps leading zero bytes as leading "1"s, both ways', () => {
    const bytes = Uint8Array.of(0, 0, 0, 1, 2, 3);
    const encoded = base58btcEncode(bytes);

    expect(encoded.startsWith('111')).toBe(true);
    expect(base58btcDecode(encoded)).toEqual(bytes);
  });

  it('round-trips random bytes', () => {
    for (let length = 1; length <= 64; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + length * 11) % 256);

      expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes);
    }
  });

  it('refuses characters outside the alphabet, and empty or oversized input', () => {
    for (const bad of ['0', 'O', 'I', 'l', 'abc+', 'abc ', '', 'a'.repeat(513)]) {
      expect(base58btcDecode(bad)).toBeNull();
    }
  });
});

describe('base64url', () => {
  it('refuses a non-canonical spelling: stray bits in the last character', () => {
    // 'AB' decodes to one byte but 'AA' is its canonical form.
    expect(base64urlDecode('AA')).toEqual(Uint8Array.of(0));
    expect(base64urlDecode('AB')).toBeNull();
  });

  it('refuses padding and the standard alphabet', () => {
    expect(base64urlDecode('AA==')).toBeNull();
    expect(base64urlDecode('a+b/')).toBeNull();
  });
});

describe('multibase', () => {
  it('encodes and decodes both supported bases', () => {
    const bytes = text('trust');

    expect(multibaseDecode(multibaseEncode('z', bytes))).toEqual({ base: 'z', bytes });
    expect(multibaseDecode(multibaseEncode('u', bytes))).toEqual({ base: 'u', bytes });
  });

  it('refuses any other prefix', () => {
    expect(multibaseDecode('f6869')).toBeNull();
    expect(multibaseDecode('')).toBeNull();
  });
});

describe('Ed25519 Multikey', () => {
  // The public key of the W3C vc-di-eddsa worked example.
  const W3C_KEY = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';

  it('decodes the W3C example key to 32 bytes and re-encodes it identically', () => {
    const raw = decodeEd25519Multikey(W3C_KEY);

    expect(raw).toHaveLength(32);
    expect(encodeEd25519Multikey(raw as Uint8Array)).toBe(W3C_KEY);
  });

  it('refuses a key with another multicodec header or the wrong length', () => {
    expect(
      decodeEd25519Multikey(multibaseEncode('z', Uint8Array.of(0xec, 0x01, ...new Uint8Array(32)))),
    ).toBeNull();
    expect(
      decodeEd25519Multikey(multibaseEncode('z', Uint8Array.of(0xed, 0x01, ...new Uint8Array(31)))),
    ).toBeNull();
    expect(decodeEd25519Multikey('u1234')).toBeNull();
  });

  it('refuses to encode a key that is not 32 bytes', () => {
    expect(() => encodeEd25519Multikey(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe('sha256Multihash', () => {
  it('prefixes code 0x12 and length 0x20', () => {
    const multihash = sha256Multihash(new Uint8Array(32).fill(7));

    expect(Array.from(multihash.slice(0, 3))).toEqual([0x12, 0x20, 7]);
    expect(multihash).toHaveLength(34);
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => sha256Multihash(new Uint8Array(20))).toThrow(RangeError);
  });
});
