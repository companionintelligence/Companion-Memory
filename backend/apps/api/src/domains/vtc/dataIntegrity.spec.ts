import { createHash, generateKeyPairSync } from 'node:crypto';

import { createProof, secureDocument, verifyProof, type DataIntegrityProof } from './dataIntegrity';
import { didKeyFromPublicKey, didKeyVerificationMethod, publicKeyFromMultikey } from './didKey';
import { LocalSigner, privateKeyFromSeed, rawPublicKey } from './ed25519';
import { canonicalize } from './jcs';
import { createKeyResolver, type KeyResolver } from './keyResolver';
import { decodeMultibaseBase58btc, encodeMultibaseBase58btc } from './multibase';

/**
 * W3C "Data Integrity EdDSA Cryptosuites v1.0", Appendix B.3, "Representation: eddsa-jcs-2022"
 * (https://www.w3.org/TR/vc-di-eddsa/#representation-eddsa-jcs-2022). Every constant in this block
 * is copied from the specification. Ed25519 is deterministic, so signing with the published secret
 * key must give the published signature byte for byte.
 */
const PUBLISHED_PUBLIC = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const PUBLISHED_SECRET = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';
const PUBLISHED_VM = `did:key:${PUBLISHED_PUBLIC}#${PUBLISHED_PUBLIC}`;
const PUBLISHED_CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://www.w3.org/ns/credentials/examples/v2',
];

const PUBLISHED_DOCUMENT = {
  '@context': PUBLISHED_CONTEXT,
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
};

const PUBLISHED_CANONICAL_DOCUMENT =
  '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],"credentialSubject":{"alumniOf":"The School of Examples","id":"did:example:abcdefgh"},"description":"A minimum viable example of an Alumni Credential.","id":"urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33","issuer":"https://vc.example/issuers/5678","name":"Alumni Credential","type":["VerifiableCredential","AlumniCredential"],"validFrom":"2023-01-01T00:00:00Z"}';
const PUBLISHED_DOCUMENT_HASH = '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19';

const PUBLISHED_PROOF_OPTIONS = {
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: '2023-02-24T23:36:38Z',
  verificationMethod: PUBLISHED_VM,
  proofPurpose: 'assertionMethod',
  '@context': PUBLISHED_CONTEXT,
};

const PUBLISHED_CANONICAL_PROOF_OPTIONS = `{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],"created":"2023-02-24T23:36:38Z","cryptosuite":"eddsa-jcs-2022","proofPurpose":"assertionMethod","type":"DataIntegrityProof","verificationMethod":"${PUBLISHED_VM}"}`;
const PUBLISHED_PROOF_OPTIONS_HASH = '66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db';

const PUBLISHED_SIGNATURE_HEX =
  '407cd12654b33d718ecbb99179a1506daaa849450bf3fc523cce3e1c96f8b80351da3f253d725c6f00b07c9e5448d50b3ef78012b9ab54255116d069c6dd2808';
const PUBLISHED_PROOF_VALUE =
  'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const publishedSigner = (): LocalSigner =>
  new LocalSigner(PUBLISHED_VM, privateKeyFromSeed(decodeMultibaseBase58btc(PUBLISHED_SECRET).subarray(2)));

/** The vector's issuer is a URL, so the key is handed over directly rather than resolved by DID. */
const publishedKey: KeyResolver = (request) =>
  Promise.resolve(
    request.verificationMethod === PUBLISHED_VM ? publicKeyFromMultikey(PUBLISHED_PUBLIC) : null,
  );

const publishedSecured = (): Record<string, unknown> => ({
  ...PUBLISHED_DOCUMENT,
  proof: { ...PUBLISHED_PROOF_OPTIONS, proofValue: PUBLISHED_PROOF_VALUE },
});

describe('eddsa-jcs-2022 against the W3C Appendix B.3 test vector', () => {
  it('canonicalizes and hashes the credential as published', () => {
    expect(canonicalize(PUBLISHED_DOCUMENT)).toBe(PUBLISHED_CANONICAL_DOCUMENT);
    expect(sha256Hex(canonicalize(PUBLISHED_DOCUMENT))).toBe(PUBLISHED_DOCUMENT_HASH);
  });

  it('canonicalizes and hashes the proof options as published', () => {
    expect(canonicalize(PUBLISHED_PROOF_OPTIONS)).toBe(PUBLISHED_CANONICAL_PROOF_OPTIONS);
    expect(sha256Hex(canonicalize(PUBLISHED_PROOF_OPTIONS))).toBe(PUBLISHED_PROOF_OPTIONS_HASH);
  });

  it('signs proof-options hash then document hash and reproduces the published signature', async () => {
    const signed = await publishedSigner().sign(
      Buffer.from(PUBLISHED_PROOF_OPTIONS_HASH + PUBLISHED_DOCUMENT_HASH, 'hex'),
    );

    expect(Buffer.from(signed).toString('hex')).toBe(PUBLISHED_SIGNATURE_HEX);
    expect(encodeMultibaseBase58btc(signed)).toBe(PUBLISHED_PROOF_VALUE);
  });

  it('createProof reproduces the whole published proof object', async () => {
    const proof = await createProof(PUBLISHED_DOCUMENT, publishedSigner(), {
      created: new Date('2023-02-24T23:36:38Z'),
    });

    expect(proof).toEqual({ ...PUBLISHED_PROOF_OPTIONS, proofValue: PUBLISHED_PROOF_VALUE });
  });

  it('verifies the published secured credential', async () => {
    const result = await verifyProof(publishedSecured(), { resolveKey: publishedKey });

    expect(result).toMatchObject({ ok: true, verificationMethod: PUBLISHED_VM });
  });

  it('hands the resolver the issuer and the verification method it must tie together', async () => {
    const resolveKey = jest.fn(publishedKey);

    await verifyProof(publishedSecured(), { resolveKey });

    expect(resolveKey).toHaveBeenCalledWith({
      issuer: 'https://vc.example/issuers/5678',
      verificationMethod: PUBLISHED_VM,
    });
  });

  it('the vector key is the did:key a did:key issuer would use', () => {
    const publicKey = publicKeyFromMultikey(PUBLISHED_PUBLIC);

    expect(didKeyVerificationMethod(didKeyFromPublicKey(publicKey))).toBe(PUBLISHED_VM);
  });
});

describe('verifyProof refuses', () => {
  const verify = (secured: unknown, resolveKey: KeyResolver = publishedKey) =>
    verifyProof(secured, { resolveKey });

  const withProof = (changes: Record<string, unknown>) => ({
    ...PUBLISHED_DOCUMENT,
    proof: { ...PUBLISHED_PROOF_OPTIONS, proofValue: PUBLISHED_PROOF_VALUE, ...changes },
  });

  it.each([
    ['a changed claim', { ...publishedSecured(), name: 'Alumni Credentiaal' }],
    [
      'a removed member',
      (() => {
        const { name: _name, ...rest } = publishedSecured();

        return rest;
      })(),
    ],
    ['an added member', { ...publishedSecured(), extra: true }],
    [
      'a changed nested claim',
      {
        ...publishedSecured(),
        credentialSubject: { id: 'did:example:other', alumniOf: 'The School of Examples' },
      },
    ],
    ['a changed created time', withProof({ created: '2023-02-24T23:36:39Z' })],
    [
      'a changed verification method (same key, another URL)',
      withProof({ verificationMethod: `${PUBLISHED_VM}x` }),
    ],
  ])('%s', async (_name, secured) => {
    const result = await verify(secured, () => Promise.resolve(publicKeyFromMultikey(PUBLISHED_PUBLIC)));

    expect(result).toMatchObject({ ok: false, code: 'PROOF_SIGNATURE_INVALID' });
  });

  it('a signature made by a different key, even when the resolver vouches for it', async () => {
    const stranger = generateKeyPairSync('ed25519').publicKey;

    const result = await verify(publishedSecured(), () => Promise.resolve(rawPublicKey(stranger)));

    expect(result).toMatchObject({ ok: false, code: 'PROOF_SIGNATURE_INVALID' });
  });

  it('a key the resolver will not tie to the issuer', async () => {
    expect(await verify(publishedSecured(), () => Promise.resolve(null))).toMatchObject({
      ok: false,
      code: 'PROOF_KEY_UNRESOLVED',
    });
  });

  it('a document with no proof', async () => {
    expect(await verify(PUBLISHED_DOCUMENT)).toMatchObject({ ok: false, code: 'PROOF_MISSING' });
  });

  it.each([
    ['a proof set', [publishedSecured().proof]],
    ['a string proof', 'proof'],
    ['a null proof', null],
  ])('%s', async (_name, proof) => {
    expect(await verify({ ...PUBLISHED_DOCUMENT, proof })).toMatchObject({
      ok: false,
      code: 'PROOF_MALFORMED',
    });
  });

  it.each([undefined, null, 'document', 7, []])('the non-object document %p', async (document) => {
    expect(await verify(document)).toMatchObject({ ok: false, code: 'PROOF_MALFORMED' });
  });

  it.each([
    ['another proof type', { type: 'Ed25519Signature2020' }],
    ['another cryptosuite', { cryptosuite: 'eddsa-rdfc-2022' }],
    ['a missing cryptosuite', { cryptosuite: undefined }],
  ])('%s', async (_name, changes) => {
    expect(await verify(withProof(changes))).toMatchObject({ ok: false, code: 'PROOF_UNSUPPORTED' });
  });

  it.each([
    ['a proofPurpose of authentication', { proofPurpose: 'authentication' }],
    ['no proofPurpose', { proofPurpose: undefined }],
  ])('%s', async (_name, changes) => {
    expect(await verify(withProof(changes))).toMatchObject({ ok: false, code: 'PROOF_PURPOSE_MISMATCH' });
  });

  // The W3C algorithm only needs the document's @context to START WITH the proof's; this module
  // deliberately wants them identical (see the header of dataIntegrity.ts).
  it('a proof @context that is only a prefix of the document’s, which is stricter than W3C on purpose', async () => {
    const result = await verify(withProof({ '@context': [PUBLISHED_CONTEXT[0]] }));

    expect(result).toMatchObject({ ok: false, code: 'PROOF_CONTEXT_MISMATCH' });
  });

  describe('a validly signed proof that puts a condition on itself which is not enforced here', () => {
    /** Signs with the published key, so the only thing wrong with the proof is the extra member. */
    const signedWith = async (extra: Record<string, unknown>) => {
      const options = { ...PUBLISHED_PROOF_OPTIONS, ...extra };
      const data = Buffer.concat(
        [options, PUBLISHED_DOCUMENT].map((part) =>
          createHash('sha256').update(canonicalize(part), 'utf8').digest(),
        ),
      );
      const signature = await publishedSigner().sign(data);

      return {
        ...PUBLISHED_DOCUMENT,
        proof: { ...options, proofValue: encodeMultibaseBase58btc(signature) },
      };
    };

    it('control: the same construction with nothing extra verifies', async () => {
      expect(await verify(await signedWith({}))).toMatchObject({ ok: true });
    });

    it.each([
      ['previousProof', 'urn:uuid:11111111-2222-4333-8444-555555555555'],
      ['domain', 'verifier.example.com'],
      ['challenge', '3a9f'],
      ['nonce', 'once'],
      ['expires', '2020-01-01T00:00:00Z'],
    ])('names %s', async (member, value) => {
      expect(await verify(await signedWith({ [member]: value }))).toMatchObject({
        ok: false,
        code: 'PROOF_UNSUPPORTED',
      });
    });
  });

  it.each([
    ['a non-string proofValue', { proofValue: 7 }],
    ['a non-string verificationMethod', { verificationMethod: { id: PUBLISHED_VM } }],
    ['a proofValue that is not base58btc', { proofValue: 'z0OIl' }],
    ['a proofValue without the z prefix', { proofValue: PUBLISHED_PROOF_VALUE.slice(1) }],
    ['a proofValue under the u prefix', { proofValue: `u${PUBLISHED_PROOF_VALUE.slice(1)}` }],
    ['a proofValue of the wrong length', { proofValue: encodeMultibaseBase58btc(new Uint8Array(63)) }],
    ['a created that is not a date-time', { created: '2023-02-30T00:00:00Z' }],
  ])('%s', async (_name, changes) => {
    expect(await verify(withProof(changes))).toMatchObject({ ok: false, code: 'PROOF_MALFORMED' });
  });

  it('a document that has no JSON form, instead of throwing', async () => {
    expect(await verify({ ...publishedSecured(), extra: undefined })).toMatchObject({
      ok: false,
      code: 'PROOF_MALFORMED',
    });
  });
});

describe('createProof and secureDocument', () => {
  it('round-trips through a did:key issuer using the module resolver', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const did = didKeyFromPublicKey(rawPublicKey(publicKey));
    const signer = new LocalSigner(didKeyVerificationMethod(did), privateKey);
    const unsecured = { '@context': PUBLISHED_CONTEXT, type: ['VerifiableCredential'], issuer: did, n: 1 };

    const secured = await secureDocument(unsecured, signer, {
      created: new Date('2026-11-05T12:34:56.789Z'),
    });

    expect((secured.proof as DataIntegrityProof).created).toBe('2026-11-05T12:34:56Z');
    expect(await verifyProof(secured, { resolveKey: createKeyResolver() })).toMatchObject({ ok: true });
    expect(await verifyProof({ ...secured, n: 2 }, { resolveKey: createKeyResolver() })).toMatchObject({
      ok: false,
      code: 'PROOF_SIGNATURE_INVALID',
    });
  });

  it('copies the document @context into the proof options, as the specification requires', async () => {
    const proof = await createProof(PUBLISHED_DOCUMENT, publishedSigner(), { created: new Date(0) });

    expect(proof['@context']).toEqual(PUBLISHED_CONTEXT);
  });

  it('omits the proof @context when the document has none', async () => {
    const proof = await createProof({ issuer: 'did:example:x' }, publishedSigner(), { created: new Date(0) });

    expect('@context' in proof).toBe(false);
  });

  it('refuses to sign a document that already carries a proof', async () => {
    await expect(
      createProof(publishedSecured(), publishedSigner(), { created: new Date(0) }),
    ).rejects.toThrow('already carries a proof');
  });

  it('refuses a signer that does not return 64 bytes', async () => {
    const broken = { verificationMethod: PUBLISHED_VM, sign: () => Promise.resolve(new Uint8Array(63)) };

    await expect(createProof(PUBLISHED_DOCUMENT, broken, { created: new Date(0) })).rejects.toThrow(
      '64-byte',
    );
  });
});
