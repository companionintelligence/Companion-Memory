import { createPrivateKey } from 'node:crypto';

import { didcommEndpoints, relationshipKeys } from './didDocument';
import { jwkFromDidKey } from './didKey';
import { DidcommError } from './errors';
import {
  didKeyIdentityFromEd25519Seed,
  generateDidKeyIdentity,
  generateDidPeerIdentity,
  secretsOf,
} from './identity';
import { generateKeyPair } from './jwk';
import { createDidResolver } from './resolver';
import { InMemorySecretsResolver } from './secrets';

const resolver = createDidResolver();

describe('did:key identities', () => {
  it('derives a did:key whose signing key is the seed and whose agreement key is its X25519 image', async () => {
    const seed = Buffer.alloc(32, 7);
    const identity = didKeyIdentityFromEd25519Seed(seed);
    const document = await resolver.resolve(identity.did);

    const [signing] = relationshipKeys(document, 'authentication');
    const [agreement] = relationshipKeys(document, 'keyAgreement');

    expect(identity.signingKid).toBe(signing.id);
    expect(identity.agreementKid).toBe(agreement.id);
    expect(jwkFromDidKey(identity.did).x).toBe(signing.jwk.x);
    expect(identity.secrets.map((secret) => secret.kid)).toEqual([signing.id, agreement.id]);

    // The Ed25519 secret really is the seed.
    const seedKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'jwk' });
    expect(identity.secrets[0].d).toBe(seedKey.d);
  });

  it('is deterministic in the seed and distinct across seeds', () => {
    const a = didKeyIdentityFromEd25519Seed(Buffer.alloc(32, 1));
    const b = didKeyIdentityFromEd25519Seed(Buffer.alloc(32, 1));
    const c = didKeyIdentityFromEd25519Seed(Buffer.alloc(32, 2));

    expect(a.did).toBe(b.did);
    expect(a.did).not.toBe(c.did);
    expect(generateDidKeyIdentity().did).not.toBe(generateDidKeyIdentity().did);
  });

  it('rejects a seed of the wrong size', () => {
    expect(() => didKeyIdentityFromEd25519Seed(Buffer.alloc(31))).toThrow(DidcommError);
  });
});

describe('did:peer identities', () => {
  it('builds #key-1 (agreement), #key-2 (authentication) and a service', async () => {
    const identity = generateDidPeerIdentity({ uri: 'https://box.example/didcomm', accept: ['didcomm/v2'] });
    const document = await resolver.resolve(identity.did);

    expect(identity.agreementKid).toBe(`${identity.did}#key-1`);
    expect(identity.signingKid).toBe(`${identity.did}#key-2`);
    expect(relationshipKeys(document, 'keyAgreement')[0].jwk.crv).toBe('X25519');
    expect(relationshipKeys(document, 'authentication')[0].jwk.crv).toBe('Ed25519');
    expect(didcommEndpoints(document)).toEqual([
      {
        id: `${identity.did}#service`,
        uri: 'https://box.example/didcomm',
        accept: ['didcomm/v2'],
        routingKeys: [],
      },
    ]);
  });

  it('works without a service, as a pure pairwise identifier', async () => {
    const identity = generateDidPeerIdentity();

    expect(didcommEndpoints(await resolver.resolve(identity.did))).toEqual([]);
  });
});

describe('InMemorySecretsResolver', () => {
  it('returns a key by exact kid and nothing for another', async () => {
    const identity = generateDidKeyIdentity();
    const secrets = secretsOf(identity);

    await expect(secrets.getSecret(identity.agreementKid)).resolves.toMatchObject({
      crv: 'X25519',
      kid: identity.agreementKid,
    });
    await expect(secrets.getSecret(`${identity.did}#other`)).resolves.toBeUndefined();
    expect(secrets.kids()).toEqual(identity.secrets.map((secret) => secret.kid));
  });

  it('refuses a secret without a kid, a duplicate kid, and a key that does not match itself', () => {
    const { privateJwk } = generateKeyPair('X25519');

    expect(() => new InMemorySecretsResolver([privateJwk])).toThrow(/needs a "kid"/);
    expect(
      () =>
        new InMemorySecretsResolver([
          { ...privateJwk, kid: 'did:example:a#k' },
          { ...privateJwk, kid: 'did:example:a#k' },
        ]),
    ).toThrow(/duplicate/);
    expect(
      () =>
        new InMemorySecretsResolver([
          { ...privateJwk, kid: 'did:example:a#k', d: generateKeyPair('X25519').privateJwk.d },
        ]),
    ).toThrow(DidcommError);
  });
});
