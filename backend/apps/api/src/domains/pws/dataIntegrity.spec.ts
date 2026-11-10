import { createHash } from 'node:crypto';

import {
  createEddsaJcs2022Proof,
  DataIntegrityError,
  verifyEddsaJcs2022Proof,
  type DataIntegrityProof,
  type JsonObject,
} from './dataIntegrity';
import { publicKeyFromDidKey } from './didKey';
import { LocalEd25519Signer, publicKeyFromSeed } from './ed25519';
import { canonicalize } from './jcs';
import { base58btcDecode } from './multibase';

/**
 * W3C "Data Integrity EdDSA Cryptosuites v1.0" Appendix B.3, "Representation: eddsa-jcs-2022"
 * (https://www.w3.org/TR/vc-di-eddsa/#representation-eddsa-jcs-2022), Examples 29-39.
 *
 * The key pair, the created date, the two SHA-256 hashes and the signature are the values the specification
 * prints; the credential is Example 30. The credential text is not taken on trust: its hash below must equal the
 * published one, so a wrong character in it fails the test. Ed25519 is deterministic, so signing with the published
 * secret key must reproduce the published signature byte for byte.
 */
const W3C_PUBLIC = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const W3C_SECRET = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';
const W3C_VM = `did:key:${W3C_PUBLIC}#${W3C_PUBLIC}`;
const W3C_CONTEXT = ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'];

const W3C_DOCUMENT: JsonObject = {
  '@context': W3C_CONTEXT,
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
};
const W3C_DOCUMENT_HASH = '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19';
const W3C_PROOF_OPTIONS_HASH = '66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db';
const W3C_PROOF_VALUE =
  'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX';
const W3C_SIGNATURE_HEX =
  '407cd12654b33d718ecbb99179a1506daaa849450bf3fc523cce3e1c96f8b80351da3f253d725c6f00b07c9e5448d50b3ef78012b9ab54255116d069c6dd2808';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const w3cSeed = (): Uint8Array => base58btcDecode(W3C_SECRET.slice(1)).subarray(2);
const w3cSigner = (): LocalEd25519Signer => new LocalEd25519Signer(W3C_VM, w3cSeed());
const w3cPublicKey = (): Uint8Array => publicKeyFromDidKey(`did:key:${W3C_PUBLIC}`);

const w3cProofOptions = {
  verificationMethod: W3C_VM,
  created: '2023-02-24T23:36:38Z',
  proofPurpose: 'assertionMethod',
};

describe('eddsa-jcs-2022 against the W3C Appendix B.3 test vector', () => {
  it('uses the published key pair', () => {
    expect(Buffer.from(publicKeyFromSeed(w3cSeed())).equals(Buffer.from(w3cPublicKey()))).toBe(true);
  });

  it('hashes the credential and the proof options to the published values', () => {
    expect(sha256Hex(canonicalize(W3C_DOCUMENT))).toBe(W3C_DOCUMENT_HASH);
    expect(
      sha256Hex(
        canonicalize({
          '@context': W3C_CONTEXT,
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          ...w3cProofOptions,
        }),
      ),
    ).toBe(W3C_PROOF_OPTIONS_HASH);
  });

  it('publishes the signature in base58btc and in hex consistently', () => {
    expect(Buffer.from(base58btcDecode(W3C_PROOF_VALUE.slice(1))).toString('hex')).toBe(W3C_SIGNATURE_HEX);
  });

  it('signs to the published proofValue, byte for byte, and emits the published proof', async () => {
    const proof = await createEddsaJcs2022Proof({
      document: W3C_DOCUMENT,
      proofOptions: w3cProofOptions,
      signer: w3cSigner(),
    });

    expect(proof).toEqual({
      '@context': W3C_CONTEXT,
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2023-02-24T23:36:38Z',
      verificationMethod: W3C_VM,
      proofPurpose: 'assertionMethod',
      proofValue: W3C_PROOF_VALUE,
    });
  });

  it('verifies the published proof', () => {
    const proof = {
      '@context': W3C_CONTEXT,
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2023-02-24T23:36:38Z',
      verificationMethod: W3C_VM,
      proofPurpose: 'assertionMethod',
      proofValue: W3C_PROOF_VALUE,
    } as const;

    expect(verifyEddsaJcs2022Proof({ document: W3C_DOCUMENT, proof, publicKey: w3cPublicKey() })).toBe(true);
  });
});

describe('verifyEddsaJcs2022Proof refuses anything that was not signed', () => {
  const published = (): DataIntegrityProof => ({
    '@context': W3C_CONTEXT,
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2023-02-24T23:36:38Z',
    verificationMethod: W3C_VM,
    proofPurpose: 'assertionMethod',
    proofValue: W3C_PROOF_VALUE,
  });
  const verify = (document: JsonObject, proof: DataIntegrityProof, publicKey = w3cPublicKey()): boolean =>
    verifyEddsaJcs2022Proof({ document, proof, publicKey });

  it('rejects a changed document member, an added member and a removed member', () => {
    expect(verify({ ...W3C_DOCUMENT, name: 'Alumni Credential 2' }, published())).toBe(false);
    expect(verify({ ...W3C_DOCUMENT, extra: true }, published())).toBe(false);
    const { description: _description, ...without } = W3C_DOCUMENT;
    expect(verify(without, published())).toBe(false);
  });

  it('rejects a changed proof option', () => {
    expect(verify(W3C_DOCUMENT, { ...published(), created: '2023-02-24T23:36:39Z' })).toBe(false);
    expect(verify(W3C_DOCUMENT, { ...published(), proofPurpose: 'authentication' })).toBe(false);
    expect(verify(W3C_DOCUMENT, { ...published(), verificationMethod: `${W3C_VM}x` })).toBe(false);
    expect(verify(W3C_DOCUMENT, { ...published(), extra: 'member added to the proof' })).toBe(false);
  });

  it('rejects another key, a mangled proofValue and the wrong suite', () => {
    const other = publicKeyFromSeed(new Uint8Array(32).fill(7));
    expect(verify(W3C_DOCUMENT, published(), other)).toBe(false);

    for (const proofValue of [
      '',
      'z',
      'zzzz',
      `u${W3C_PROOF_VALUE.slice(1)}`,
      W3C_PROOF_VALUE.slice(1),
      `${W3C_PROOF_VALUE}2`,
    ]) {
      expect(verify(W3C_DOCUMENT, { ...published(), proofValue })).toBe(false);
    }

    expect(
      verify(W3C_DOCUMENT, {
        ...published(),
        cryptosuite: 'eddsa-rdfc-2022',
      } as unknown as DataIntegrityProof),
    ).toBe(false);
    expect(
      verify(W3C_DOCUMENT, { ...published(), type: 'Ed25519Signature2020' } as unknown as DataIntegrityProof),
    ).toBe(false);
  });

  it('rejects a document that still carries a proof member', () => {
    expect(verify({ ...W3C_DOCUMENT, proof: published() }, published())).toBe(false);
  });

  it('applies the @context rule: a proof context must be a prefix of the document context', () => {
    // Not a prefix: the proof names a different first entry.
    expect(verify(W3C_DOCUMENT, { ...published(), '@context': ['https://example.com/other'] })).toBe(false);
    // Longer than the document's context.
    expect(
      verify(W3C_DOCUMENT, { ...published(), '@context': [...W3C_CONTEXT, 'https://example.com/x'] }),
    ).toBe(false);
    // The proof has a context but the document has none.
    const { '@context': _context, ...bare } = W3C_DOCUMENT;
    expect(verify(bare, published())).toBe(false);
    // The proof has no context while the document does: hashed as it stands, which does not match the signature.
    const { '@context': _proofContext, ...noContext } = published();
    expect(verify(W3C_DOCUMENT, noContext as DataIntegrityProof)).toBe(false);
  });
});

describe('createEddsaJcs2022Proof guards its inputs', () => {
  it('refuses a document that already has a proof, a proofValue in the options, and a signer that is not the verification method', async () => {
    const signer = w3cSigner();

    await expect(
      createEddsaJcs2022Proof({
        document: { ...W3C_DOCUMENT, proof: {} },
        proofOptions: w3cProofOptions,
        signer,
      }),
    ).rejects.toThrow(DataIntegrityError);
    await expect(
      createEddsaJcs2022Proof({
        document: W3C_DOCUMENT,
        proofOptions: { ...w3cProofOptions, proofValue: 'z1' },
        signer,
      }),
    ).rejects.toThrow(DataIntegrityError);
    await expect(
      createEddsaJcs2022Proof({
        document: W3C_DOCUMENT,
        proofOptions: { ...w3cProofOptions, verificationMethod: 'did:key:z6MkOther#z6MkOther' },
        signer,
      }),
    ).rejects.toThrow(DataIntegrityError);
  });

  it('refuses a signer that does not return a 64-byte signature', async () => {
    await expect(
      createEddsaJcs2022Proof({
        document: W3C_DOCUMENT,
        proofOptions: w3cProofOptions,
        signer: { id: W3C_VM, sign: () => Promise.resolve(new Uint8Array(10)) },
      }),
    ).rejects.toThrow(DataIntegrityError);
  });
});

/**
 * The shape a PWS capability-delegation proof takes: a zcap whose proof carries `proofPurpose:
 * capabilityDelegation` and a `capabilityChain`, and whose `@context` lists the zcap context first and the Data
 * Integrity context last (the signing library adds the latter). Everything in the proof, `capabilityChain`
 * included, is part of what is signed. The reference-stack bytes for this shape are pinned in
 * `referenceVectors.spec.ts`; this block checks the property that matters for authorization.
 */
describe('a capability-delegation proof signs the capability chain too', () => {
  const alice = new LocalEd25519Signer('did:key:z6MkAlice#z6MkAlice', new Uint8Array(32).fill(1));
  const ROOT = 'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F';
  const zcap: JsonObject = {
    '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
    id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    controller: 'did:key:z6MkApp',
    parentCapability: ROOT,
    invocationTarget: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/',
    expires: '2027-01-01T00:00:00Z',
    allowedAction: ['GET', 'HEAD'],
  };
  const options = {
    verificationMethod: alice.id,
    created: '2026-11-05T11:00:00Z',
    proofPurpose: 'capabilityDelegation',
    capabilityChain: [ROOT],
  };

  it('is deterministic, carries the document context, and verifies', async () => {
    const first = await createEddsaJcs2022Proof({ document: zcap, proofOptions: options, signer: alice });
    const second = await createEddsaJcs2022Proof({ document: zcap, proofOptions: options, signer: alice });

    expect(first).toEqual(second);
    expect(first['@context']).toEqual(zcap['@context']);
    expect(first.proofPurpose).toBe('capabilityDelegation');
    expect(first['capabilityChain']).toEqual([ROOT]);
    expect(verifyEddsaJcs2022Proof({ document: zcap, proof: first, publicKey: alice.publicKey })).toBe(true);
  });

  it('stops verifying when the chain, the target, the actions or the expiry are altered', async () => {
    const proof = await createEddsaJcs2022Proof({ document: zcap, proofOptions: options, signer: alice });
    const verify = (document: JsonObject, candidate: DataIntegrityProof): boolean =>
      verifyEddsaJcs2022Proof({ document, proof: candidate, publicKey: alice.publicKey });

    expect(verify(zcap, { ...proof, capabilityChain: [`${ROOT}x`] })).toBe(false);
    expect(verify({ ...zcap, invocationTarget: 'https://example.com/space/other/' }, proof)).toBe(false);
    expect(verify({ ...zcap, allowedAction: ['GET', 'HEAD', 'DELETE'] }, proof)).toBe(false);
    expect(verify({ ...zcap, expires: '2099-01-01T00:00:00Z' }, proof)).toBe(false);
    expect(verify({ ...zcap, controller: 'did:key:z6MkEve' }, proof)).toBe(false);
  });
});
