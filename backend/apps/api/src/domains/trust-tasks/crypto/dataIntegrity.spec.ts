import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

import {
  createEddsaJcs2022Proof,
  documentDigest,
  ed25519PublicKeyFromRaw,
  taskDigest,
  verifyEddsaJcs2022Proof,
  withoutProof,
} from './dataIntegrity';
import { canonicalize } from './jcs';
import { base58btcDecode, base64urlEncode, decodeEd25519Multikey, multibaseEncode } from './multibase';

/**
 * The W3C vc-di-eddsa worked example for `eddsa-jcs-2022` (Appendix B.3, Examples 29–38). Every
 * intermediate value is checked, not just the signature, so a failure points at the step that drifted.
 */
const W3C_PUBLIC_KEY = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const W3C_SECRET_KEY = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';
const W3C_VERIFICATION_METHOD = `did:key:${W3C_PUBLIC_KEY}#${W3C_PUBLIC_KEY}`;

const W3C_CREDENTIAL = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
  id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
  type: ['VerifiableCredential', 'AlumniCredential'],
  name: 'Alumni Credential',
  description: 'A minimum viable example of an Alumni Credential.',
  issuer: 'https://vc.example/issuers/5678',
  validFrom: '2023-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
};

const W3C_CANONICAL_CREDENTIAL =
  '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],' +
  '"credentialSubject":{"alumniOf":"The School of Examples","id":"did:example:abcdefgh"},' +
  '"description":"A minimum viable example of an Alumni Credential.","id":"urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33",' +
  '"issuer":"https://vc.example/issuers/5678","name":"Alumni Credential","type":["VerifiableCredential","AlumniCredential"],' +
  '"validFrom":"2023-01-01T00:00:00Z"}';

const W3C_CANONICAL_PROOF_OPTIONS =
  '{"@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"],' +
  '"created":"2023-02-24T23:36:38Z","cryptosuite":"eddsa-jcs-2022","proofPurpose":"assertionMethod","type":"DataIntegrityProof",' +
  `"verificationMethod":"${W3C_VERIFICATION_METHOD}"}`;

const W3C_PROOF_VALUE =
  'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX';

/** Example 39, "Signed Credential": the proof carries the `@context` it was signed with. */
const W3C_SECURED_CREDENTIAL = {
  ...W3C_CREDENTIAL,
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2023-02-24T23:36:38Z',
    verificationMethod: W3C_VERIFICATION_METHOD,
    proofPurpose: 'assertionMethod',
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
    proofValue: W3C_PROOF_VALUE,
  },
};

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function w3cPrivateKey(): KeyObject {
  const secret = base58btcDecode(W3C_SECRET_KEY.slice(1)) as Uint8Array;
  const publicKey = decodeEd25519Multikey(W3C_PUBLIC_KEY) as Uint8Array;

  // multicodec `ed25519-priv` is the two-byte varint 0x8026, then the 32-byte seed.
  expect(Array.from(secret.slice(0, 2))).toEqual([0x80, 0x26]);

  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: base64urlEncode(secret.slice(2)), x: base64urlEncode(publicKey) },
    format: 'jwk',
  });
}

describe('eddsa-jcs-2022 — the W3C worked example', () => {
  it('canonicalizes the credential and the proof options to the published strings, and hashes them to the published digests', () => {
    expect(canonicalize(W3C_CREDENTIAL)).toBe(W3C_CANONICAL_CREDENTIAL);
    expect(sha256Hex(W3C_CANONICAL_CREDENTIAL)).toBe(
      '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19',
    );
    expect(sha256Hex(W3C_CANONICAL_PROOF_OPTIONS)).toBe(
      '66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db',
    );
  });

  it('produces the published proof, @context included, and with it the published secured credential', () => {
    const proof = createEddsaJcs2022Proof(W3C_CREDENTIAL, {
      verificationMethod: W3C_VERIFICATION_METHOD,
      proofPurpose: 'assertionMethod',
      created: '2023-02-24T23:36:38Z',
      privateKey: w3cPrivateKey(),
    });

    expect(proof.proofValue).toBe(W3C_PROOF_VALUE);
    expect(proof).toEqual(W3C_SECURED_CREDENTIAL.proof);
    expect({ ...W3C_CREDENTIAL, proof }).toEqual(W3C_SECURED_CREDENTIAL);
  });

  it('verifies the published secured credential with the published key', () => {
    const key = decodeEd25519Multikey(W3C_PUBLIC_KEY) as Uint8Array;

    expect(verifyEddsaJcs2022Proof(W3C_SECURED_CREDENTIAL, key)).toBe(true);
    // Through JSON text, as a consumer would receive it.
    expect(verifyEddsaJcs2022Proof(JSON.parse(JSON.stringify(W3C_SECURED_CREDENTIAL)), key)).toBe(true);
  });

  it('does not verify the published credential once anything it signed has changed', () => {
    const key = decodeEd25519Multikey(W3C_PUBLIC_KEY) as Uint8Array;
    const withoutContext: Record<string, unknown> = { ...W3C_SECURED_CREDENTIAL.proof };
    delete withoutContext['@context'];

    expect(verifyEddsaJcs2022Proof({ ...W3C_SECURED_CREDENTIAL, name: 'Alumni Credentials' }, key)).toBe(
      false,
    );
    // The proof was signed WITH its @context, so a copy that lost it is a different statement.
    expect(verifyEddsaJcs2022Proof({ ...W3C_SECURED_CREDENTIAL, proof: withoutContext }, key)).toBe(false);
  });
});

describe('eddsa-jcs-2022 — behaviour', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const unsecured = {
    id: 'urn:uuid:1',
    type: 'https://example.com/spec/x/0.1',
    payload: { n: 1, list: ['a', 'b'] },
  };

  const sign = (document: Record<string, unknown>) => ({
    ...document,
    proof: createEddsaJcs2022Proof(document, {
      verificationMethod: 'did:example:alice#key-1',
      privateKey,
      created: '2026-11-05T12:00:00Z',
    }),
  });

  /** What another implementation does: sign over EXACTLY the options it chooses, whatever they hold. */
  const handSigned = (document: Record<string, unknown>, options: Record<string, unknown>) => {
    const sha256 = (value: unknown) => createHash('sha256').update(canonicalize(value), 'utf8').digest();
    const hash = Buffer.concat([sha256(options), sha256(document)]);

    return {
      ...document,
      proof: { ...options, proofValue: multibaseEncode('z', cryptoSign(null, hash, privateKey)) },
    };
  };

  const OPTIONS = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-11-05T12:00:00Z',
    verificationMethod: 'did:example:alice#key-1',
    proofPurpose: 'authentication',
  };

  it('round-trips, defaulting the purpose to authentication', () => {
    const secured = sign(unsecured);

    expect(secured.proof.proofPurpose).toBe('authentication');
    expect(verifyEddsaJcs2022Proof(secured, publicKey)).toBe(true);
  });

  it('does not depend on member order or on whitespace in the source text', () => {
    // Reverse the member order at EVERY level (a replacer array would filter nested members instead).
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, member]) => [key, reversed(member)]),
            )
          : value;

    const secured = sign(unsecured);
    const reparsed = JSON.parse(`  ${JSON.stringify(reversed(secured), null, 4)}  `);

    expect(Object.keys(reparsed)).toEqual(Object.keys(secured).reverse());
    expect(verifyEddsaJcs2022Proof(reparsed, publicKey)).toBe(true);
  });

  it('fails when any signed member changes', () => {
    const secured = sign(unsecured);

    expect(verifyEddsaJcs2022Proof({ ...secured, payload: { n: 2, list: ['a', 'b'] } }, publicKey)).toBe(
      false,
    );
    expect(verifyEddsaJcs2022Proof({ ...secured, recipient: 'did:example:eve' }, publicKey)).toBe(false);
    expect(
      verifyEddsaJcs2022Proof(
        { ...secured, proof: { ...secured.proof, proofPurpose: 'assertionMethod' } },
        publicKey,
      ),
    ).toBe(false);
    expect(
      verifyEddsaJcs2022Proof(
        { ...secured, proof: { ...secured.proof, verificationMethod: 'did:example:eve#k' } },
        publicKey,
      ),
    ).toBe(false);
    expect(
      verifyEddsaJcs2022Proof(
        { ...secured, proof: { ...secured.proof, created: '2026-11-05T12:00:01Z' } },
        publicKey,
      ),
    ).toBe(false);
  });

  it('signs and checks the document @context together with the proof options', () => {
    const withContext = sign({ ...unsecured, '@context': ['https://www.w3.org/ns/credentials/v2'] });

    expect(verifyEddsaJcs2022Proof(withContext, publicKey)).toBe(true);
    expect(
      verifyEddsaJcs2022Proof({ ...withContext, '@context': ['https://example.com/other'] }, publicKey),
    ).toBe(false);
  });

  it('verifies a proof whose options carry no @context, which is what another implementation may emit for a document that has one', () => {
    const document = { ...unsecured, '@context': ['https://www.w3.org/ns/credentials/v2'] };

    expect(verifyEddsaJcs2022Proof(handSigned(document, OPTIONS), publicKey)).toBe(true);
  });

  it('accepts a document whose @context extends the proof’s, hashing it with the proof’s context alone (W3C §3.3.2)', () => {
    const base = ['https://www.w3.org/ns/credentials/v2'];
    const signed = sign({ ...unsecured, '@context': base });

    expect(signed.proof['@context']).toEqual(base);
    expect(
      verifyEddsaJcs2022Proof({ ...signed, '@context': [...base, 'https://example.com/ctx/v1'] }, publicKey),
    ).toBe(true);
    // The values the proof names must lead the document's, in order.
    expect(
      verifyEddsaJcs2022Proof({ ...signed, '@context': ['https://example.com/ctx/v1', ...base] }, publicKey),
    ).toBe(false);
    expect(
      verifyEddsaJcs2022Proof({ ...signed, '@context': ['https://example.com/ctx/v1'] }, publicKey),
    ).toBe(false);
  });

  it('refuses a proof that names a @context the document no longer carries', () => {
    const signed = sign({ ...unsecured, '@context': ['https://www.w3.org/ns/credentials/v2'] });
    const stripped: Record<string, unknown> = { ...signed };
    delete stripped['@context'];

    expect(verifyEddsaJcs2022Proof(stripped, publicKey)).toBe(false);
  });

  it('treats a lone-string @context as a one-element list', () => {
    const signed = sign({ ...unsecured, '@context': 'https://www.w3.org/ns/credentials/v2' });

    expect(verifyEddsaJcs2022Proof(signed, publicKey)).toBe(true);
    expect(
      verifyEddsaJcs2022Proof(
        { ...signed, '@context': ['https://www.w3.org/ns/credentials/v2', 'https://example.com/ctx/v1'] },
        publicKey,
      ),
    ).toBe(true);
  });

  it('refuses a `created` that is not an RFC 3339 date-time — on signing, and on a proof signed over one anyway', () => {
    expect(() =>
      createEddsaJcs2022Proof(unsecured, {
        verificationMethod: 'did:example:alice#key-1',
        privateKey,
        created: 'yesterday',
      }),
    ).toThrow(/created/);

    expect(verifyEddsaJcs2022Proof(handSigned(unsecured, OPTIONS), publicKey)).toBe(true);
    expect(
      verifyEddsaJcs2022Proof(handSigned(unsecured, { ...OPTIONS, created: 'yesterday' }), publicKey),
    ).toBe(false);
  });

  it('fails under a different key', () => {
    const other = generateKeyPairSync('ed25519').publicKey;

    expect(verifyEddsaJcs2022Proof(sign(unsecured), other)).toBe(false);
  });

  it('accepts a raw 32-byte public key as well as a KeyObject', () => {
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'));

    expect(verifyEddsaJcs2022Proof(sign(unsecured), raw)).toBe(true);
    expect(ed25519PublicKeyFromRaw(raw).export({ format: 'jwk' }).x).toBe(jwk.x);
  });

  it('never throws on a proof it cannot verify', () => {
    const secured = sign(unsecured);
    const broken: unknown[] = [
      { ...unsecured },
      { ...unsecured, proof: 'nope' },
      { ...unsecured, proof: [] },
      { ...secured, proof: { ...secured.proof, cryptosuite: 'ecdsa-jcs-2019' } },
      { ...secured, proof: { ...secured.proof, type: 'Ed25519Signature2020' } },
      { ...secured, proof: { ...secured.proof, proofValue: 42 } },
      { ...secured, proof: { ...secured.proof, proofValue: `u${secured.proof.proofValue.slice(1)}` } },
      { ...secured, proof: { ...secured.proof, proofValue: 'z0OIl' } },
      { ...secured, proof: { ...secured.proof, proofValue: 'z11' } },
      { ...secured, payload: { n: Number.NaN } },
      { ...secured, payload: { when: new Date(0) } },
    ];

    for (const candidate of broken) {
      expect(verifyEddsaJcs2022Proof(candidate as Record<string, unknown>, publicKey)).toBe(false);
    }
  });

  it('refuses to sign a document that already has a proof', () => {
    expect(() =>
      createEddsaJcs2022Proof(sign(unsecured), { verificationMethod: 'did:example:alice#key-1', privateKey }),
    ).toThrow(/already carries a proof/);
  });

  it('omits `created` from the proof when none is given', () => {
    const proof = createEddsaJcs2022Proof(unsecured, {
      verificationMethod: 'did:example:alice#key-1',
      privateKey,
    });

    expect('created' in proof).toBe(false);
    expect(verifyEddsaJcs2022Proof({ ...unsecured, proof }, publicKey)).toBe(true);
  });
});

describe('digests', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const unsecured = { id: 'urn:uuid:1', type: 'https://example.com/spec/x/0.1', payload: { n: 1 } };
  const proofA = createEddsaJcs2022Proof(unsecured, {
    verificationMethod: 'did:example:a#k',
    privateKey,
    created: '2026-11-05T12:00:00Z',
  });
  const proofB = createEddsaJcs2022Proof(unsecured, {
    verificationMethod: 'did:example:a#k',
    privateKey,
    created: '2026-11-05T12:00:01Z',
  });

  it('a task digest is one value for a document signed, unsigned or re-signed', () => {
    expect(taskDigest(unsecured)).toBe(taskDigest({ ...unsecured, proof: proofA }));
    expect(taskDigest({ ...unsecured, proof: proofA })).toBe(taskDigest({ ...unsecured, proof: proofB }));
  });

  it('a task digest changes with the content, and is a multibase SHA-256 multihash', () => {
    expect(taskDigest(unsecured)).not.toBe(taskDigest({ ...unsecured, payload: { n: 2 } }));
    // `u` + base64url(0x12 0x20 ‖ 32 bytes): 34 bytes → 46 characters, always beginning "uEi".
    expect(taskDigest(unsecured)).toMatch(/^uEi[A-Za-z0-9_-]{44}$/);
    expect(taskDigest(unsecured, 'z')).toMatch(/^zQm[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('a task digest does not strip a `proof` nested inside the payload', () => {
    expect(taskDigest({ ...unsecured, payload: { proof: 'x' } })).not.toBe(
      taskDigest({ ...unsecured, payload: {} }),
    );
  });

  it('a document digest includes the proof: a re-signed copy is a different document', () => {
    expect(documentDigest({ ...unsecured, proof: proofA })).not.toBe(
      documentDigest({ ...unsecured, proof: proofB }),
    );
    expect(documentDigest({ ...unsecured, proof: proofA })).toBe(
      documentDigest(JSON.parse(JSON.stringify({ ...unsecured, proof: proofA }))),
    );
  });

  it('withoutProof removes only the top-level proof', () => {
    expect(withoutProof({ ...unsecured, proof: proofA })).toEqual(unsecured);
    expect(withoutProof({ ...unsecured, payload: { proof: 1 } })).toEqual({
      ...unsecured,
      payload: { proof: 1 },
    });
  });
});
