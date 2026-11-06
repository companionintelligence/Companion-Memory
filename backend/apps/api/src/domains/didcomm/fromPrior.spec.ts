import { DidcommError } from './errors';
import { createFromPrior, verifyFromPrior } from './fromPrior';
import { generateDidKeyIdentity, generateDidPeerIdentity, secretsOf } from './identity';
import { parsePrivateJwk } from './jwk';
import { createCompactJws } from './jws';
import { createDidResolver, firstOf, StaticDidResolver } from './resolver';
import { InMemorySecretsResolver } from './secrets';
import { RUST_FROM_PRIOR_JWT } from './__tests__/rustVectors';

const resolver = createDidResolver();

describe('verifyFromPrior', () => {
  const charlieDoc = {
    id: 'did:example:charlie',
    verificationMethod: [
      {
        id: 'did:example:charlie#key-1',
        type: 'JsonWebKey2020',
        controller: 'did:example:charlie',
        publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'VDXDwuGKVq91zxU6q7__jLDUq8_C5cuxECgd-1feFTE' },
      },
    ],
    authentication: ['did:example:charlie#key-1'],
  };

  it("verifies the reference implementation's JWT against Charlie's published key", async () => {
    const verified = await verifyFromPrior(RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL, {
      resolver: new StaticDidResolver([charlieDoc]),
    });

    expect(verified).toMatchObject({
      issuer: 'did:example:charlie',
      subject: 'did:example:alice',
      issuedAt: 123456,
      kid: 'did:example:charlie#key-1',
    });
    // Temporal claims are reported, not enforced: this JWT's exp (1234) is long past.
    expect(verified.claims).toMatchObject({ aud: '123', exp: 1234, nbf: 12345, jti: 'dfg' });
  });

  it('refuses it when the key is not under authentication, or the document is for another DID', async () => {
    const notAuthorized = { ...charlieDoc, authentication: [] };

    await expect(
      verifyFromPrior(RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL, {
        resolver: new StaticDidResolver([notAuthorized]),
      }),
    ).rejects.toMatchObject({ code: 'key-not-found' });
    await expect(
      verifyFromPrior(RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL, { resolver: new StaticDidResolver([]) }),
    ).rejects.toMatchObject({ code: 'did-resolution-failed' });
  });

  it.each([
    ['text that is not a JWT', RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_INVALID],
    ['a non-canonical signature', RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_INVALID_SIGNATURE],
  ])('refuses %s', async (_name, token) => {
    await expect(
      verifyFromPrior(token, { resolver: new StaticDidResolver([charlieDoc]) }),
    ).rejects.toBeInstanceOf(DidcommError);
  });
});

describe('createFromPrior', () => {
  it('moves a relationship from a did:key to a did:peer, and the result verifies', async () => {
    const prior = generateDidKeyIdentity();
    const next = generateDidPeerIdentity({ uri: 'https://pairwise.example/in' });
    const token = await createFromPrior({
      subject: next.did,
      issuerKid: prior.signingKid,
      secrets: secretsOf(prior),
      now: 1700000000,
    });

    const verified = await verifyFromPrior(token, { resolver });

    expect(verified).toMatchObject({
      issuer: prior.did,
      subject: next.did,
      issuedAt: 1700000000,
      kid: prior.signingKid,
    });
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'EdDSA',
      kid: prior.signingKid,
    });
  });

  it('ends a relationship by rotating to nothing (no "sub")', async () => {
    const prior = generateDidKeyIdentity();
    const token = await createFromPrior({ issuerKid: prior.signingKid, secrets: secretsOf(prior) });
    const verified = await verifyFromPrior(token, { resolver });

    expect(verified.subject).toBeUndefined();
    expect(verified.issuer).toBe(prior.did);
  });

  it('refuses to build a rotation that makes no sense', async () => {
    const prior = generateDidKeyIdentity();
    const secrets = secretsOf(prior);

    await expect(
      createFromPrior({ subject: prior.did, issuerKid: prior.signingKid, secrets }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      createFromPrior({ subject: 'not a did', issuerKid: prior.signingKid, secrets }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      createFromPrior({ subject: 'did:example:next', issuerKid: prior.did, secrets }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      createFromPrior({ subject: 'did:example:next', issuerKid: `${prior.did}#nope`, secrets }),
    ).rejects.toMatchObject({ code: 'secret-not-found' });
  });

  it('is only as good as the issuer key: a key the DID does not authorize for authentication does not verify', async () => {
    const prior = generateDidKeyIdentity();
    // Sign with the X25519 key-agreement secret relabelled as the signing key: wrong curve for EdDSA.
    const secrets = new InMemorySecretsResolver([prior.secrets[1]]);

    await expect(
      createFromPrior({ subject: 'did:example:next', issuerKid: prior.agreementKid, secrets }),
    ).rejects.toBeInstanceOf(DidcommError);

    const forged = createCompactJws(
      { typ: 'JWT', kid: prior.agreementKid },
      { iss: prior.did, sub: 'did:example:next', iat: 1 },
      parsePrivateJwk({ ...generateDidKeyIdentity().secrets[0], kid: prior.agreementKid }),
    );

    await expect(verifyFromPrior(forged, { resolver })).rejects.toBeInstanceOf(DidcommError);
  });
});

describe('verifyFromPrior rejects malformed claims', () => {
  const prior = generateDidKeyIdentity();
  const [signer] = prior.secrets;
  const token = (claims: Record<string, unknown>, kid: string | null = prior.signingKid) =>
    createCompactJws({ typ: 'JWT', ...(kid ? { kid } : {}) }, claims, signer);
  const good = { iss: prior.did, sub: 'did:example:next', iat: 1700000000 };

  it.each([
    ['an iss that is a key id', { ...good, iss: prior.signingKid }],
    ['an iss that is not a DID', { ...good, iss: 'prior' }],
    ['a sub that is a key id', { ...good, sub: 'did:example:next#k' }],
    ['an iss equal to the sub', { ...good, sub: prior.did }],
    ['no iat', { iss: good.iss, sub: good.sub }],
    ['a fractional iat', { ...good, iat: 1.5 }],
    ['a string iat', { ...good, iat: '1700000000' }],
  ])('%s', async (_name, claims) => {
    await expect(verifyFromPrior(token(claims), { resolver })).rejects.toBeInstanceOf(DidcommError);
  });

  it('rejects a kid that belongs to a different DID than iss, or names no key', async () => {
    const other = generateDidKeyIdentity();

    await expect(verifyFromPrior(token(good, other.signingKid), { resolver })).rejects.toBeInstanceOf(
      DidcommError,
    );
    await expect(verifyFromPrior(token(good, prior.did), { resolver })).rejects.toBeInstanceOf(DidcommError);
    await expect(verifyFromPrior(token(good, null), { resolver })).rejects.toBeInstanceOf(DidcommError);
    await expect(verifyFromPrior(token(good), { resolver: firstOf(resolver) })).resolves.toMatchObject({
      issuer: prior.did,
    });
  });
});
