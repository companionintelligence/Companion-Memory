import * as didcomm from './index';

/**
 * The barrel is the only way other domains may reach this one (dependency-cruiser:
 * no-cross-domain-internals), and `docs/didcomm.md` shows callers importing these names. A name
 * dropped from the barrel breaks them without breaking any test inside the domain.
 */
describe('the public barrel', () => {
  it.each([
    'DidcommAgent',
    'DidcommError',
    'InMemoryReplayGuard',
    'InMemorySecretsResolver',
    'StaticDidResolver',
    'buildInvitation',
    'buildPing',
    'buildProblemReport',
    'buildQueries',
    'createDidResolver',
    'createFromPrior',
    'createMessage',
    'decodeInvitationUrl',
    'didKeyIdentityFromEd25519Seed',
    'encodeInvitationUrl',
    'generateDidKeyIdentity',
    'generateDidPeerIdentity',
    'packEncrypted',
    'packPlaintext',
    'packSigned',
    'parseMessage',
    'prepareDelivery',
    'problemCodeFor',
    'resolveDidKey',
    'resolveDidPeer',
    'secretsOf',
    'unpack',
    'verifyFromPrior',
  ])('exports %s', (name) => {
    expect(didcomm).toHaveProperty(name);
    expect((didcomm as Record<string, unknown>)[name]).toBeDefined();
  });

  it('does not export the low-level crypto, which has no business outside the domain', () => {
    for (const internal of [
      'encryptJwe',
      'decryptJwe',
      'aesKeyWrap',
      'concatKdfSha256',
      'hchacha20',
      'privateKeyObject',
    ]) {
      expect(didcomm).not.toHaveProperty(internal);
    }
  });

  it('names only the secrets seam as secret-related: no function that hands out private key material', () => {
    expect(
      Object.keys(didcomm)
        .filter((name) => /secret|private/i.test(name))
        .sort(),
    ).toEqual(['InMemorySecretsResolver', 'secretsOf']);
  });
});
