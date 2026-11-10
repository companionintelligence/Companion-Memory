import {
  DidKeyError,
  didKeyFromPublicKey,
  didMethodOf,
  isDidKey,
  keyIdFromDidKey,
  parseDidKeyUrl,
  publicKeyFromDidKey,
  resolveDidKey,
} from './didKey';
import { publicKeyFromSeed } from './ed25519';
import { base58btcDecode, base58btcEncode } from './multibase';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * W3C "Data Integrity EdDSA Cryptosuites v1.0" Appendix B key pair: the public key as a Multikey (which is exactly
 * the did:key fingerprint) and the secret as a Multikey private key (multicodec 0x8026 then the 32-byte seed).
 */
const W3C_PUBLIC = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const W3C_SECRET = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';

/** The example controller in the PWS specification's own requests. */
const PWS_EXAMPLE_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

describe('did:key (Ed25519)', () => {
  it('spells the W3C Appendix B public key the way the specification does', () => {
    const seed = base58btcDecode(W3C_SECRET.slice(1));
    expect(hex(seed.subarray(0, 2))).toBe('8026');
    const publicKey = publicKeyFromSeed(seed.subarray(2));

    expect(didKeyFromPublicKey(publicKey)).toBe(`did:key:${W3C_PUBLIC}`);
    expect(hex(publicKeyFromDidKey(`did:key:${W3C_PUBLIC}`))).toBe(hex(publicKey));
    expect(hex(base58btcDecode(W3C_PUBLIC.slice(1)).subarray(0, 2))).toBe('ed01');
  });

  it('round-trips the example DID from the PWS specification', () => {
    const publicKey = publicKeyFromDidKey(PWS_EXAMPLE_DID);

    expect(publicKey).toHaveLength(32);
    expect(didKeyFromPublicKey(publicKey)).toBe(PWS_EXAMPLE_DID);
    expect(isDidKey(PWS_EXAMPLE_DID)).toBe(true);
  });

  it('builds a key id from the DID and its own fingerprint', () => {
    expect(keyIdFromDidKey(PWS_EXAMPLE_DID)).toBe(
      `${PWS_EXAMPLE_DID}#${PWS_EXAMPLE_DID.slice('did:key:'.length)}`,
    );
    expect(() => keyIdFromDidKey('did:key:zNope')).toThrow(DidKeyError);
  });

  it('refuses every DID that is not an Ed25519 did:key', () => {
    const secp256k1 = `did:key:z${base58btcEncode(Uint8Array.from([0xe7, 0x01, ...new Uint8Array(33)]))}`;
    const x25519 = `did:key:z${base58btcEncode(Uint8Array.from([0xec, 0x01, ...new Uint8Array(32)]))}`;
    const short = `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...new Uint8Array(31)]))}`;
    const long = `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...new Uint8Array(33)]))}`;
    const wrongBase = `did:key:u${Buffer.from(Uint8Array.from([0xed, 0x01, ...new Uint8Array(32)])).toString('base64url')}`;

    for (const bad of [
      'did:keri:EAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      'did:web:example.com',
      'did:webvh:Qm:example.com',
      'did:key:',
      'did:key:z',
      'did:key:z0OIl',
      secp256k1,
      x25519,
      short,
      long,
      wrongBase,
      `${PWS_EXAMPLE_DID}#${PWS_EXAMPLE_DID.slice(8)}`,
      `${PWS_EXAMPLE_DID}/path`,
      ` ${PWS_EXAMPLE_DID}`,
      '',
    ]) {
      expect(isDidKey(bad)).toBe(false);
      expect(() => publicKeyFromDidKey(bad)).toThrow(DidKeyError);
    }

    expect(() => didKeyFromPublicKey(new Uint8Array(31))).toThrow(DidKeyError);
  });

  it('names the method of any DID-shaped string, which is how a registry can refuse did:keri', () => {
    expect(didMethodOf(PWS_EXAMPLE_DID)).toBe('key');
    expect(didMethodOf('did:keri:EAbc')).toBe('keri');
    expect(didMethodOf('did:webvh:Qm:example.com')).toBe('webvh');
    expect(didMethodOf('https://example.com')).toBeUndefined();
    expect(didMethodOf('did:key')).toBeUndefined();
    expect(didMethodOf('')).toBeUndefined();
  });
});

describe('parseDidKeyUrl', () => {
  it('splits the DID from its fragment', () => {
    expect(parseDidKeyUrl(PWS_EXAMPLE_DID)).toEqual({ did: PWS_EXAMPLE_DID });
    expect(parseDidKeyUrl(`${PWS_EXAMPLE_DID}#frag`)).toEqual({ did: PWS_EXAMPLE_DID, fragment: 'frag' });
  });

  it('refuses other methods, paths, queries and empty or repeated fragments', () => {
    for (const bad of [
      'did:web:example.com#key-1',
      `${PWS_EXAMPLE_DID}/path#a`,
      `${PWS_EXAMPLE_DID}?service=x#a`,
      `${PWS_EXAMPLE_DID}#`,
      `${PWS_EXAMPLE_DID}#a#b`,
    ]) {
      expect(() => parseDidKeyUrl(bad)).toThrow(DidKeyError);
    }
  });
});

describe('resolveDidKey', () => {
  const fingerprint = PWS_EXAMPLE_DID.slice('did:key:'.length);
  const keyId = `${PWS_EXAMPLE_DID}#${fingerprint}`;

  it('derives the DID document from the identifier alone and lists the key under every relationship', () => {
    const document = resolveDidKey(PWS_EXAMPLE_DID);

    expect(document).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: PWS_EXAMPLE_DID,
      verificationMethod: [
        { id: keyId, type: 'Multikey', controller: PWS_EXAMPLE_DID, publicKeyMultibase: fingerprint },
      ],
      authentication: [keyId],
      assertionMethod: [keyId],
      capabilityDelegation: [keyId],
      capabilityInvocation: [keyId],
    });
  });

  it('resolves a key id to the same document and refuses a fragment that is not the key itself', () => {
    expect(resolveDidKey(keyId)).toEqual(resolveDidKey(PWS_EXAMPLE_DID));
    expect(() => resolveDidKey(`${PWS_EXAMPLE_DID}#z6MkOther`)).toThrow(DidKeyError);
    expect(() => resolveDidKey(`${PWS_EXAMPLE_DID}#key-1`)).toThrow(DidKeyError);
  });

  it('refuses a malformed or non-Ed25519 identifier', () => {
    expect(() => resolveDidKey('did:keri:EAbc')).toThrow(DidKeyError);
    expect(() => resolveDidKey('did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme')).toThrow(
      DidKeyError,
    );
  });
});
