import { didMethod, didOf, fragmentOf, hasDidUrlParts, isDid, isDidUrl, isPartyIdentifier } from './did';
import { base58btcEncode, base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import { generateKeyPair, type KeyCurve } from './jwk';
import { jwkFromMultikey, multikeyFromJwk } from './multikey';

describe('DID syntax', () => {
  it.each([
    'did:example:alice',
    'did:key:z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V',
    'did:web:example.com%3A8443:user:alice',
    'did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc.Vz6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V',
  ])('accepts the DID %s', (did) => {
    expect(isDid(did)).toBe(true);
    expect(isDidUrl(did)).toBe(true);
    expect(isPartyIdentifier(did)).toBe(true);
    expect(hasDidUrlParts(did)).toBe(false);
  });

  it.each([
    '',
    'did:',
    'did:example',
    'did:Example:alice',
    'did:example:',
    'did:example:al ice',
    'did:example:alice#key-1',
    'example:alice',
    'did:example:ali\nce',
    42,
    null,
  ])('rejects %p as a DID', (value) => {
    expect(isDid(value)).toBe(false);
  });

  it('splits DID URLs', () => {
    const url = 'did:example:alice#key-x25519-1';

    expect(isDidUrl(url)).toBe(true);
    expect(isDid(url)).toBe(false);
    expect(didOf(url)).toBe('did:example:alice');
    expect(fragmentOf(url)).toBe('key-x25519-1');
    expect(fragmentOf('did:example:alice')).toBeUndefined();
    expect(hasDidUrlParts(url)).toBe(true);
    expect(didOf('did:example:alice/path?query=1#frag')).toBe('did:example:alice');
    expect(didMethod('did:peer:2.abc')).toBe('peer');
    expect(didMethod(url)).toBe('example');
  });

  it('treats from/to entries as parties: a DID or DID URL without a fragment', () => {
    expect(isPartyIdentifier('did:example:alice')).toBe(true);
    expect(isPartyIdentifier('did:example:alice/svc?x=1')).toBe(true);
    expect(isPartyIdentifier('did:example:alice#key-1')).toBe(false);
  });

  it('refuses over-long input', () => {
    expect(isDid(`did:example:${'a'.repeat(5000)}`)).toBe(false);
  });

  it('throws on didOf for text that is not a DID URL', () => {
    expect(() => didOf('not a did')).toThrow(DidcommError);
  });
});

describe('multikey', () => {
  const ALL: KeyCurve[] = ['Ed25519', 'X25519', 'P-256', 'P-384', 'P-521', 'secp256k1'];

  it.each(ALL)('round-trips a %s key', (curve) => {
    const { publicJwk } = generateKeyPair(curve);
    const multikey = multikeyFromJwk(publicJwk);

    expect(multikey.startsWith('z')).toBe(true);
    expect(jwkFromMultikey(multikey)).toEqual(publicJwk);
  });

  it('uses the published prefixes: z6Mk for Ed25519, z6LS for X25519, zDn for P-256, z82 for P-384', () => {
    expect(multikeyFromJwk(generateKeyPair('Ed25519').publicJwk).startsWith('z6Mk')).toBe(true);
    expect(multikeyFromJwk(generateKeyPair('X25519').publicJwk).startsWith('z6LS')).toBe(true);
    expect(multikeyFromJwk(generateKeyPair('P-256').publicJwk).startsWith('zDn')).toBe(true);
    expect(multikeyFromJwk(generateKeyPair('P-384').publicJwk).startsWith('z82')).toBe(true);
    expect(multikeyFromJwk(generateKeyPair('secp256k1').publicJwk).startsWith('zQ3s')).toBe(true);
  });

  it('decodes independently published keys', () => {
    expect(jwkFromMultikey('z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V')).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA',
    });
    expect(jwkFromMultikey('z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc')).toEqual({
      kty: 'OKP',
      crv: 'X25519',
      x: 'BIiFcQEn3dfvB2pjlhOQQour6jXy9d5s2FKEJNTOJik',
    });
  });

  it('rejects unknown multicodecs, wrong lengths and bad compressed points', () => {
    const ed = jwkFromMultikey(multikeyFromJwk(generateKeyPair('Ed25519').publicJwk));
    const raw = Buffer.from(ed.x, 'base64url');

    // 0x1205 is not a multicodec this domain knows.
    const unknown = Buffer.concat([Buffer.from([0x85, 0x24]), raw]);
    expect(() => jwkFromMultikey(`z${base58btcEncode(unknown)}`)).toThrow(/unsupported multicodec/);

    const short = Buffer.concat([Buffer.from([0xed, 0x01]), raw.subarray(1)]);
    expect(() => jwkFromMultikey(`z${base58btcEncode(short)}`)).toThrow(/32 bytes/);

    // A P-256 header with an uncompressed-looking prefix byte.
    const p256 = Buffer.concat([Buffer.from([0x80, 0x24, 0x04]), Buffer.alloc(32, 1)]);
    expect(() => jwkFromMultikey(`z${base58btcEncode(p256)}`)).toThrow(DidcommError);

    // About half of all x values have no y on P-256; some small x must be refused as off-curve.
    const refused = Array.from({ length: 40 }, (_, index) => index + 1).filter((x) => {
      const compressed = Buffer.concat([Buffer.from([0x80, 0x24, 0x02]), Buffer.alloc(31), Buffer.from([x])]);

      try {
        jwkFromMultikey(`z${base58btcEncode(compressed)}`);
        return false;
      } catch (error) {
        return error instanceof DidcommError && /not on the curve/.test(error.message);
      }
    });
    expect(refused.length).toBeGreaterThan(5);

    expect(() => jwkFromMultikey('6MkqRYq')).toThrow(DidcommError);
    expect(base64urlEncode(raw)).toBe(ed.x);
  });
});
