import { generateKeyPairSync } from 'node:crypto';

import { didKeyFromPublicKey, didKeyVerificationMethod, multikeyFromPublicKey } from './didKey';
import { rawPublicKey } from './ed25519';
import { createKeyResolver, KeyResolverConfigError } from './keyResolver';

const newKey = (): Uint8Array => rawPublicKey(generateKeyPairSync('ed25519').publicKey);

describe('createKeyResolver', () => {
  describe('did:key issuers', () => {
    const key = newKey();
    const did = didKeyFromPublicKey(key);

    it('authorizes the DID’s own verification method and returns its key', async () => {
      const resolved = await createKeyResolver()({
        issuer: did,
        verificationMethod: didKeyVerificationMethod(did),
      });

      expect(Array.from(resolved ?? [])).toEqual(Array.from(key));
    });

    it('does not authorize another did:key’s verification method for this issuer', async () => {
      const other = didKeyFromPublicKey(newKey());

      expect(
        await createKeyResolver()({ issuer: did, verificationMethod: didKeyVerificationMethod(other) }),
      ).toBeNull();
    });

    it.each(['', '#key-0', 'did:key:other', 'did:example:x#y'])(
      'does not authorize the method %j',
      async (method) => {
        expect(await createKeyResolver()({ issuer: did, verificationMethod: method })).toBeNull();
      },
    );

    it('can be switched off', async () => {
      const resolver = createKeyResolver({ allowDidKey: false });

      expect(await resolver({ issuer: did, verificationMethod: didKeyVerificationMethod(did) })).toBeNull();
    });

    it('returns null, not an error, for a malformed did:key issuer', async () => {
      expect(
        await createKeyResolver()({
          issuer: 'did:key:zNotAKey',
          verificationMethod: 'did:key:zNotAKey#zNotAKey',
        }),
      ).toBeNull();
    });
  });

  describe('pinned communities', () => {
    const key = newKey();
    const did = 'did:webvh:community.example.com:abc';
    const method = `${did}#key-0`;
    const pinned = [
      { did, verificationMethods: [{ id: method, publicKeyMultibase: multikeyFromPublicKey(key) }] },
    ];

    it('returns the pinned key for exactly the pinned verification method', async () => {
      const resolved = await createKeyResolver({ pinned })({ issuer: did, verificationMethod: method });

      expect(Array.from(resolved ?? [])).toEqual(Array.from(key));
    });

    it.each([
      ['an unpinned method of the same DID', { issuer: did, verificationMethod: `${did}#key-1` }],
      [
        'the pinned method claimed by another issuer',
        { issuer: 'did:webvh:evil.example:abc', verificationMethod: method },
      ],
      [
        'an unknown issuer',
        { issuer: 'did:web:example.com', verificationMethod: 'did:web:example.com#key-0' },
      ],
      ['an empty issuer', { issuer: '', verificationMethod: method }],
    ])('answers null for %s', async (_name, request) => {
      expect(await createKeyResolver({ pinned })(request)).toBeNull();
    });
  });

  describe('is not a KERI resolver', () => {
    const sovereignKeyId = `did:keri:D${'A'.repeat(43)}`;

    it('answers null for Companion Memory’s did:keri key id, whatever the verification method says', async () => {
      const resolver = createKeyResolver();

      for (const verificationMethod of [
        sovereignKeyId,
        `${sovereignKeyId}#key-0`,
        `${sovereignKeyId}#${'A'.repeat(43)}`,
      ]) {
        expect(await resolver({ issuer: sovereignKeyId, verificationMethod })).toBeNull();
      }
    });

    it('refuses at configuration time to pin a did:keri community', () => {
      expect(() =>
        createKeyResolver({
          pinned: [
            {
              did: sovereignKeyId,
              verificationMethods: [
                { id: `${sovereignKeyId}#k`, publicKeyMultibase: multikeyFromPublicKey(newKey()) },
              ],
            },
          ],
        }),
      ).toThrow(KeyResolverConfigError);
    });
  });

  describe('rejects a bad configuration when it is built, not when it is used', () => {
    const good = multikeyFromPublicKey(newKey());
    const did = 'did:webvh:community.example.com:abc';

    it.each([
      ['a pinned value that is not a DID', { did: 'community', verificationMethods: [] }],
      ['a pinned did:key', { did: didKeyFromPublicKey(newKey()), verificationMethods: [] }],
      [
        'a method that belongs to another DID',
        { did, verificationMethods: [{ id: 'did:webvh:other.example:abc#key-0', publicKeyMultibase: good }] },
      ],
      ['a method id with no fragment', { did, verificationMethods: [{ id: did, publicKeyMultibase: good }] }],
      [
        'a key that is not an Ed25519 multikey',
        {
          did,
          verificationMethods: [
            { id: `${did}#key-0`, publicKeyMultibase: 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq' },
          ],
        },
      ],
      [
        'a key that is not multibase',
        { did, verificationMethods: [{ id: `${did}#key-0`, publicKeyMultibase: 'not a key' }] },
      ],
      [
        'the same verification method twice, which would silently keep the last key',
        {
          did,
          verificationMethods: [
            { id: `${did}#key-0`, publicKeyMultibase: good },
            { id: `${did}#key-0`, publicKeyMultibase: multikeyFromPublicKey(newKey()) },
          ],
        },
      ],
    ])('%s', (_name, community) => {
      expect(() => createKeyResolver({ pinned: [community] })).toThrow(KeyResolverConfigError);
    });

    it('the same community pinned twice, which would silently drop the first entry’s keys', () => {
      const entry = (keyId: string) => ({
        did,
        verificationMethods: [{ id: `${did}#${keyId}`, publicKeyMultibase: multikeyFromPublicKey(newKey()) }],
      });

      expect(() => createKeyResolver({ pinned: [entry('old'), entry('new')] })).toThrow('pinned twice');
    });
  });
});
