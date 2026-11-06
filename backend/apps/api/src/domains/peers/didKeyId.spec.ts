import { generateKeyPairSync } from 'node:crypto';

import {
  base58btcDecode,
  base58btcEncode,
  didKeyFromPublicKey,
  didKeyIdFor,
  didKeyPublicJwk,
  isDidKeyId,
} from './didKeyId';

/**
 * Every constant below was produced by an INDEPENDENT encoder (a ten-line Python base58btc written
 * from the table, not from `didKeyId.ts`), so a bug shared by the code and its test cannot make
 * them agree. The `local.pub` row is the service's own key, published at
 * `https://local.pub/.well-known/did.json` (`did:web:local.pub#key-1`): a public key, not a secret.
 * The all-zero and all-0xff keys are NOT here: they are weak keys, refused (see `ed25519Weak.spec.ts`).
 */
const VECTORS: Array<{ name: string; keyHex: string; did: string }> = [
  {
    name: 'RFC 8032 section 7.1, test 1',
    keyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    did: 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw',
  },
  {
    name: 'did:key method specification example',
    keyHex: '2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6',
    did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  },
  {
    // The key of the published CESR example recorded in Companion-Hub's FROZEN.md
    // (`BGlOiUdp5sMmfotHfCWQKEzWR91C72AH0lT84c0um-Qj`): one key, two encodings.
    name: 'the KERI reference-vector key',
    keyHex: '694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423',
    did: 'did:key:z6MkmYLK2UFfWhxhZRkoD6Fq6aeWZXP4CQBkbLknM8syqH4v',
  },
  {
    name: 'local.pub did:web:local.pub#key-1',
    keyHex: 'b7e39ebf66bef1392c106cfa632bfecf4e5edbfe9060b9ed8f51955c04738233',
    did: 'did:key:z6Mkrq5xnGB7Q7ctdzzkFdubpm4Y2pQUEmN8peXGPh2Mf4TL',
  },
];

const b64u = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');

describe('didKeyId', () => {
  describe.each(VECTORS)('$name', ({ keyHex, did }) => {
    it('encodes the key to the vector', () => {
      expect(didKeyFromPublicKey(Buffer.from(keyHex, 'hex'))).toBe(did);
      expect(didKeyIdFor({ kty: 'OKP', crv: 'Ed25519', x: b64u(keyHex) })).toBe(did);
    });

    it('decodes the vector back to the same JWK', () => {
      expect(didKeyPublicJwk(did)).toEqual({ kty: 'OKP', crv: 'Ed25519', x: b64u(keyHex) });
      expect(isDidKeyId(did)).toBe(true);
    });
  });

  it('round-trips freshly generated keys', () => {
    for (let i = 0; i < 25; i += 1) {
      const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<
        string,
        unknown
      >;
      const did = didKeyIdFor(jwk);

      expect(did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(didKeyPublicJwk(did as string)).toEqual({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    }
  });

  describe('refuses anything that is not one canonical Ed25519 did:key', () => {
    const valid = VECTORS[0].did;

    it.each([
      ['an empty string', ''],
      ['the wrong method', valid.replace('did:key:', 'did:web:')],
      ['a DID URL with the key as fragment', `${valid}#${valid.slice('did:key:'.length)}`],
      ['a query', `${valid}?versionId=1`],
      ['a path', `${valid}/x`],
      ['a missing multibase code', valid.replace('did:key:z', 'did:key:')],
      // Same length as the original (47 characters after the z), so the alphabet is what refuses it.
      ['base58btc digits outside the alphabet (0, O, I)', valid.replace('6Mk', '0OI')],
      ['a truncated key', valid.slice(0, -1)],
      ['a key with an extra character', `${valid}1`],
      ['uppercase method', valid.replace('did:key:', 'DID:KEY:')],
      ['surrounding whitespace', ` ${valid} `],
      [
        'an X25519 key (z6LS…, multicodec 0xec01)',
        'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
      ],
      ['a secp256k1 key (zQ3s…)', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
      ['a P-256 key (zDn…)', 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
      ['a did:keri keyid', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
    ])('%s', (_name, candidate) => {
      expect(isDidKeyId(candidate)).toBe(false);
      expect(didKeyPublicJwk(candidate)).toBeNull();
    });

    it('refuses a non-string without throwing', () => {
      expect(didKeyPublicJwk(undefined as unknown as string)).toBeNull();
      expect(didKeyPublicJwk(null as unknown as string)).toBeNull();
      expect(didKeyPublicJwk(42 as unknown as string)).toBeNull();
    });
  });

  describe('refuses a JWK that is not one canonical Ed25519 public key', () => {
    const x = b64u(VECTORS[0].keyHex);

    // 32 bytes are 43 base64url characters whose last one carries 4 meaningful bits and 2 padding
    // bits that must be zero. Setting a padding bit decodes to the SAME bytes, so it would be a
    // second spelling of one key unless it is refused.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const stray = `${x.slice(0, -1)}${alphabet[(alphabet.indexOf(x.slice(-1)) & ~0b11) | 0b01]}`;

    it.each([
      ['an RSA key', { kty: 'RSA', n: 'AQAB', e: 'AQAB' }],
      ['an X25519 key', { kty: 'OKP', crv: 'X25519', x }],
      // Right curve and x, wrong key type: only the kty check refuses this one.
      ['an EC key that claims the Ed25519 curve', { kty: 'EC', crv: 'Ed25519', x }],
      ['a missing x', { kty: 'OKP', crv: 'Ed25519' }],
      ['a short x', { kty: 'OKP', crv: 'Ed25519', x: x.slice(0, -4) }],
      ['a long x', { kty: 'OKP', crv: 'Ed25519', x: `${x}AAAA` }],
      ['non-canonical base64url (stray padding bits)', { kty: 'OKP', crv: 'Ed25519', x: stray }],
      ['padding', { kty: 'OKP', crv: 'Ed25519', x: `${x}=` }],
    ])('%s', (_name, jwk) => {
      expect(didKeyIdFor(jwk)).toBeNull();
    });
  });

  describe('a key that is not a point on the curve has no did:key', () => {
    // y = 2 is not weak (see `ed25519Weak.ts`) and is not a point (RFC 8032 decoding fails), so only the
    // curve rule can refuse it. y = 3 is a point: the control.
    const offCurve = Uint8Array.from(Buffer.from(`02${'00'.repeat(31)}`, 'hex'));
    const onCurve = Uint8Array.from(Buffer.from(`03${'00'.repeat(31)}`, 'hex'));

    // The DID such a key WOULD have had, built by hand so only the readers are under test.
    const spell = (key: Uint8Array) => `did:key:z${base58btcEncode(Uint8Array.of(0xed, 0x01, ...key))}`;

    it('is not minted from the raw key or from its JWK', () => {
      expect(didKeyFromPublicKey(offCurve)).toBeNull();
      expect(
        didKeyIdFor({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(offCurve).toString('base64url') }),
      ).toBeNull();
    });

    it('is not read from a string that spells it out', () => {
      expect(isDidKeyId(spell(offCurve))).toBe(false);
      expect(didKeyPublicJwk(spell(offCurve))).toBeNull();
    });

    it('is told apart from a point by the curve rule alone', () => {
      expect(didKeyFromPublicKey(onCurve)).toBe(spell(onCurve));
      expect(isDidKeyId(spell(onCurve))).toBe(true);
    });

    it('catches most single-character typos of a real did:key, which are almost never another key', () => {
      const valid = VECTORS[0].did;
      const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let accepted = 0;
      let total = 0;

      for (let i = 'did:key:z'.length; i < valid.length; i += 1) {
        for (const char of alphabet) {
          if (char === valid[i]) {
            continue;
          }

          total += 1;
          accepted += isDidKeyId(`${valid.slice(0, i)}${char}${valid.slice(i + 1)}`) ? 1 : 0;
        }
      }

      // Half of all 32-byte strings are points, so about half of the typos that keep the multicodec
      // prefix survive (1,230 of 2,679 for this key), and a typo in the first characters breaks the
      // prefix. Without the curve rule nearly all the typos past the prefix would survive.
      expect(total).toBe(47 * 57);
      expect(accepted / total).toBeGreaterThan(0.4);
      expect(accepted / total).toBeLessThan(0.5);
    });
  });

  it('refuses a key of the wrong length', () => {
    expect(didKeyFromPublicKey(new Uint8Array(31))).toBeNull();
    expect(didKeyFromPublicKey(new Uint8Array(33))).toBeNull();
    expect(didKeyFromPublicKey(new Uint8Array(0))).toBeNull();
  });

  it('answers null, and never throws, for input of the wrong type', () => {
    expect(didKeyIdFor(null as unknown as Record<string, unknown>)).toBeNull();
    expect(didKeyIdFor(undefined as unknown as Record<string, unknown>)).toBeNull();
    expect(didKeyIdFor('x' as unknown as Record<string, unknown>)).toBeNull();
    expect(didKeyFromPublicKey(null as unknown as Uint8Array)).toBeNull();
    expect(didKeyFromPublicKey('d75a98' as unknown as Uint8Array)).toBeNull();
    expect(didKeyFromPublicKey([1, 2, 3] as unknown as Uint8Array)).toBeNull();
  });

  describe('base58btc', () => {
    it.each([
      ['', ''],
      ['00', '1'],
      ['0000', '11'],
      // A value whose hex form has an ODD number of digits (`1`, `123`): decoding pads it to whole bytes.
      ['01', '2'],
      ['0123', '62'],
      ['61', '2g'],
      ['626262', 'a3gV'],
      ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ])('encodes %s and decodes it back', (hex, text) => {
      const bytes = Buffer.from(hex, 'hex');

      expect(base58btcEncode(bytes)).toBe(text);
      expect(Buffer.from(base58btcDecode(text) as Uint8Array).toString('hex')).toBe(hex);
    });

    it('refuses a character outside the alphabet', () => {
      expect(base58btcDecode('0')).toBeNull();
      expect(base58btcDecode('O')).toBeNull();
      expect(base58btcDecode('I')).toBeNull();
      expect(base58btcDecode('l')).toBeNull();
      expect(base58btcDecode('+')).toBeNull();
    });
  });
});
