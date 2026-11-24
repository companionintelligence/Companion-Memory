import {
  DidKeyError,
  didKeyFromPublicKey,
  didKeyVerificationMethod,
  multikeyFromPublicKey,
  publicKeyFromDidKey,
  publicKeyFromMultikey,
} from './didKey';
import { privateKeyFromSeed, rawPublicKey, verifyEd25519 } from './ed25519';
import { decodeMultibaseBase58btc } from './multibase';

/**
 * The key pair published in W3C "Data Integrity EdDSA Cryptosuites v1.0", Appendix B.3
 * (https://www.w3.org/TR/vc-di-eddsa/). Decoding the secret key and deriving the public key from it
 * must give the published public key: that ties the base58btc reader, the multicodec prefixes and
 * Ed25519 itself to one external source.
 */
const PUBLISHED_PUBLIC = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const PUBLISHED_SECRET = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';

describe('did:key (Ed25519)', () => {
  it('reads the published public multikey as 0xed01 + a 32-byte key', () => {
    const raw = decodeMultibaseBase58btc(PUBLISHED_PUBLIC);

    expect(raw).toHaveLength(34);
    expect(Array.from(raw.subarray(0, 2))).toEqual([0xed, 0x01]);
    expect(publicKeyFromMultikey(PUBLISHED_PUBLIC)).toHaveLength(32);
  });

  it('derives the published public key from the published secret key', () => {
    const secret = decodeMultibaseBase58btc(PUBLISHED_SECRET);
    // 0x8026 is the Ed25519 private-key multicodec prefix.
    expect(Array.from(secret.subarray(0, 2))).toEqual([0x80, 0x26]);

    const derived = rawPublicKey(privateKeyFromSeed(secret.subarray(2)));

    expect(Array.from(derived)).toEqual(Array.from(publicKeyFromMultikey(PUBLISHED_PUBLIC)));
    expect(multikeyFromPublicKey(derived)).toBe(PUBLISHED_PUBLIC);
  });

  it('builds the published verification method URL', () => {
    const did = didKeyFromPublicKey(publicKeyFromMultikey(PUBLISHED_PUBLIC));

    expect(did).toBe(`did:key:${PUBLISHED_PUBLIC}`);
    expect(didKeyVerificationMethod(did)).toBe(`did:key:${PUBLISHED_PUBLIC}#${PUBLISHED_PUBLIC}`);
    expect(Array.from(publicKeyFromDidKey(did))).toEqual(Array.from(publicKeyFromMultikey(PUBLISHED_PUBLIC)));
  });

  it('refuses an all-zero signature, one of the wrong length, and a key of the wrong length', () => {
    const publicKey = publicKeyFromMultikey(PUBLISHED_PUBLIC);
    const message = Buffer.from('message');

    expect(verifyEd25519(publicKey, message, new Uint8Array(64))).toBe(false);
    expect(verifyEd25519(publicKey, message, new Uint8Array(63))).toBe(false);
    expect(verifyEd25519(new Uint8Array(31), message, new Uint8Array(64))).toBe(false);
  });

  describe('refuses what is not an Ed25519 did:key', () => {
    it.each([
      ['an Ed25519 secret key multikey', PUBLISHED_SECRET],
      ['an X25519 key', 'z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
      ['a secp256k1 key', 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
      ['text that is not base58btc', 'z6Mk0OIl'],
      ['a missing z prefix', PUBLISHED_PUBLIC.slice(1)],
      ['an empty value', ''],
    ])('%s', (_name, multikey) => {
      expect(() => publicKeyFromMultikey(multikey)).toThrow(DidKeyError);
    });

    it('a key of the wrong length', () => {
      expect(() => multikeyFromPublicKey(new Uint8Array(31))).toThrow(DidKeyError);
    });

    it.each([`01${'00'.repeat(31)}`, '00'.repeat(32), `ec${'ff'.repeat(30)}7f`])(
      'a small-order key, which signs anything (%s)',
      (hexKey) => {
        const did = didKeyFromPublicKey(Uint8Array.from(Buffer.from(hexKey, 'hex')));

        expect(() => publicKeyFromDidKey(did)).toThrow('small-order');
        expect(() => publicKeyFromMultikey(did.slice('did:key:'.length))).toThrow(DidKeyError);
      },
    );

    it.each([
      'did:web:example.com',
      'did:keri:DAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg',
      'did:peer:2.Ez6LS',
      PUBLISHED_PUBLIC,
      '',
    ])('the identifier %j', (did) => {
      expect(() => publicKeyFromDidKey(did)).toThrow(DidKeyError);
    });
  });
});
