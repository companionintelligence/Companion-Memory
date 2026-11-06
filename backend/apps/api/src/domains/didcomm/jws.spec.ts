import { sign } from 'node:crypto';

import { base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import {
  createCompactJws,
  createJws,
  parseCompactJws,
  parseJws,
  signatureAlgorithmFor,
  verifyCompactJws,
  verifyJws,
  verifyJwsSignature,
} from './jws';
import { generateKeyPair, parsePrivateJwk, parsePublicJwk, privateKeyObject, publicJwkOf } from './jwk';
import {
  RUST_FROM_PRIOR_JWT,
  RUST_SIGNED_MSG_ALICE_KEY_1,
  RUST_SIGNED_MSG_ALICE_KEY_2,
  RUST_SIGNED_MSG_ALICE_KEY_3,
} from './__tests__/rustVectors';
import { ALICE_DID_DOC, ALICE_SECRETS, SIGNED_ES256, SIGNED_ES256K, SIGNED_EDDSA } from './__tests__/vectors';

const alicePublic = (kid: string) => {
  const method = (ALICE_DID_DOC.authentication as Array<{ id: string; publicKeyJwk: unknown }>).find(
    (m) => m.id === kid,
  );

  return parsePublicJwk(method?.publicKeyJwk);
};
const aliceSecret = (kid: string) => parsePrivateJwk(ALICE_SECRETS.find((secret) => secret.kid === kid));

describe('signature algorithms', () => {
  it('maps the curves DIDComm signs with', () => {
    expect(signatureAlgorithmFor('Ed25519')).toBe('EdDSA');
    expect(signatureAlgorithmFor('P-256')).toBe('ES256');
    expect(signatureAlgorithmFor('secp256k1')).toBe('ES256K');
    expect(signatureAlgorithmFor('P-384')).toBeUndefined();
    expect(signatureAlgorithmFor('X25519')).toBeUndefined();
  });
});

describe('DIDComm signed messages, specification Appendix C.2', () => {
  it.each([
    ['EdDSA', SIGNED_EDDSA, 'did:example:alice#key-1'],
    ['ES256', SIGNED_ES256, 'did:example:alice#key-2'],
    ['ES256K', SIGNED_ES256K, 'did:example:alice#key-3'],
    ['EdDSA (reference implementation)', RUST_SIGNED_MSG_ALICE_KEY_1, 'did:example:alice#key-1'],
    ['ES256 (reference implementation)', RUST_SIGNED_MSG_ALICE_KEY_2, 'did:example:alice#key-2'],
    ['ES256K (reference implementation)', RUST_SIGNED_MSG_ALICE_KEY_3, 'did:example:alice#key-3'],
  ])('verifies the %s vector with the key its kid names', (_name, vector, kid) => {
    const parsed = parseJws(vector);

    expect(parsed.kid).toBe(kid);
    expect(verifyJwsSignature(parsed, alicePublic(kid))).toBe(true);
    expect(JSON.parse(parsed.payload.toString()).id).toBe('1234567890');
  });

  it('reproduces the Ed25519 vector byte for byte (Ed25519 is deterministic)', () => {
    const payload = Buffer.from(SIGNED_EDDSA.payload as string, 'base64url');

    expect(createJws(payload, aliceSecret('did:example:alice#key-1'))).toEqual(SIGNED_EDDSA);
  });

  it.each(['did:example:alice#key-2', 'did:example:alice#key-3'])(
    'signs with %s and verifies with its public key',
    (kid) => {
      const signed = createJws(Buffer.from('{"id":"1"}'), aliceSecret(kid));
      const parsed = parseJws({ ...signed });

      expect(verifyJwsSignature(parsed, alicePublic(kid))).toBe(true);
      expect(signed.signatures[0].header.kid).toBe(kid);
    },
  );

  it('writes the DIDComm media type and algorithm into the protected header, in that order', () => {
    const signed = createJws(Buffer.from('x'), aliceSecret('did:example:alice#key-1'));

    expect(Buffer.from(signed.signatures[0].protected, 'base64url').toString()).toBe(
      '{"typ":"application/didcomm-signed+json","alg":"EdDSA"}',
    );
  });
});

describe('signature checks', () => {
  const kid = 'did:example:alice#key-1';
  const valid = () => parseJws(SIGNED_EDDSA);

  it('fails when the payload, protected header or signature changes', () => {
    const base = { ...SIGNED_EDDSA } as Record<string, unknown> & {
      signatures: Array<Record<string, unknown>>;
    };
    const other = base.payload as string;
    const changedPayload = { ...base, payload: `${other.slice(0, -2)}AA` };
    const changedSignature = {
      ...base,
      signatures: [
        { ...base.signatures[0], signature: `A${(base.signatures[0].signature as string).slice(1)}` },
      ],
    };

    expect(verifyJwsSignature(parseJws(changedPayload), alicePublic(kid))).toBe(false);
    expect(verifyJwsSignature(parseJws(changedSignature), alicePublic(kid))).toBe(false);
  });

  it('fails with a different key of the same type, and with a key of another curve', () => {
    expect(verifyJwsSignature(valid(), publicJwkOf(generateKeyPair('Ed25519').publicJwk))).toBe(false);
    expect(verifyJwsSignature(valid(), alicePublic('did:example:alice#key-2'))).toBe(false);
    expect(verifyJwsSignature(valid(), generateKeyPair('X25519').publicJwk)).toBe(false);
  });

  it('fails when the header names an algorithm for a different curve than the key, even if the bytes would verify', () => {
    // An ES256K signature (secp256k1 + SHA-256) relabelled ES256: the same signature scheme over a
    // different curve name. The key is fixed by the DID document, so the label must agree with it.
    const key = generateKeyPair('secp256k1');
    const protectedText = base64urlEncode(
      Buffer.from(JSON.stringify({ typ: 'application/didcomm-signed+json', alg: 'ES256' })),
    );
    const payload = base64urlEncode(Buffer.from('{"id":"1"}'));
    const signature = sign('sha256', Buffer.from(`${protectedText}.${payload}`), {
      key: privateKeyObject({ ...key.privateJwk, kid: 'did:example:a#k' }),
      dsaEncoding: 'ieee-p1363',
    });
    const parsed = parseJws({
      payload,
      signatures: [
        {
          protected: protectedText,
          signature: base64urlEncode(signature),
          header: { kid: 'did:example:a#k' },
        },
      ],
    });

    expect(parsed.alg).toBe('ES256');
    expect(verifyJwsSignature(parsed, key.publicJwk)).toBe(false);
  });

  it('fails for a signature of the wrong length instead of throwing', () => {
    const parsed = valid();

    expect(verifyJwsSignature({ ...parsed, signature: parsed.signature.subarray(1) }, alicePublic(kid))).toBe(
      false,
    );
  });

  it('verifyJws combines parse and check', () => {
    expect(verifyJws(SIGNED_EDDSA, alicePublic(kid))).toBe(true);
    expect(verifyJws(SIGNED_ES256, alicePublic(kid))).toBe(false);
  });
});

describe('parseJws', () => {
  const entry = (SIGNED_EDDSA.signatures as Array<Record<string, unknown>>)[0];
  const protectedWith = (header: Record<string, unknown>) =>
    base64urlEncode(Buffer.from(JSON.stringify(header)));
  const withProtected = (header: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    payload: SIGNED_EDDSA.payload,
    signatures: [{ ...entry, protected: protectedWith(header), ...extra }],
  });

  it('accepts the flattened form', () => {
    const flattened = { payload: SIGNED_EDDSA.payload, ...entry };

    expect(parseJws(flattened).kid).toBe('did:example:alice#key-1');
  });

  it('accepts the kid in the protected header', () => {
    const parsed = parseJws(
      withProtected(
        { typ: 'application/didcomm-signed+json', alg: 'EdDSA', kid: 'did:example:alice#key-1' },
        { header: undefined },
      ),
    );

    expect(parsed.kid).toBe('did:example:alice#key-1');
  });

  it.each([
    ['two signatures', { payload: SIGNED_EDDSA.payload, signatures: [entry, entry] }],
    ['no signatures', { payload: SIGNED_EDDSA.payload, signatures: [] }],
    ['a payload with padding', { ...SIGNED_EDDSA, payload: `${SIGNED_EDDSA.payload as string}=` }],
    ['an unknown algorithm', withProtected({ typ: 'application/didcomm-signed+json', alg: 'RS256' })],
    ['alg none', withProtected({ alg: 'none' })],
    ['the wrong typ', withProtected({ typ: 'JWT', alg: 'EdDSA' })],
    ['a crit header', withProtected({ alg: 'EdDSA', crit: ['b64'], b64: false })],
    ['no kid anywhere', withProtected({ alg: 'EdDSA' }, { header: {} })],
    ['disagreeing kids', withProtected({ alg: 'EdDSA', kid: 'did:example:alice#key-9' })],
    ['an unparsable protected header', { ...SIGNED_EDDSA, signatures: [{ ...entry, protected: 'AAAA' }] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseJws(value as Record<string, unknown>)).toThrow(DidcommError);
  });
});

describe('compact JWS (from_prior)', () => {
  const charlie = parsePrivateJwk({
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'VDXDwuGKVq91zxU6q7__jLDUq8_C5cuxECgd-1feFTE',
    d: 'T2azVap7CYD_kB8ilbnFYqwwYb5N-GcD6yjGEvquZXg',
    kid: 'did:example:charlie#key-1',
  });
  const claims = {
    iss: 'did:example:charlie',
    sub: 'did:example:alice',
    aud: '123',
    exp: 1234,
    nbf: 12345,
    iat: 123456,
    jti: 'dfg',
  };

  it('reproduces the reference implementation JWT byte for byte', () => {
    expect(createCompactJws({ typ: 'JWT', kid: charlie.kid }, claims, charlie)).toBe(
      RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL,
    );
  });

  it('verifies it, and fails once the signature changes', () => {
    const parsed = parseCompactJws(RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL);

    expect(parsed.payload).toEqual(claims);
    expect(parsed.header).toEqual({ typ: 'JWT', alg: 'EdDSA', kid: 'did:example:charlie#key-1' });
    expect(verifyCompactJws(parsed, publicJwkOf(charlie))).toBe(true);

    // The invalid-signature vector changes the last character, which makes the base64url
    // non-canonical; the reference implementation rejects it while decoding, and so does this.
    expect(() => parseCompactJws(RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_INVALID_SIGNATURE)).toThrow(/canonical/);

    const [header, payload, signature] = RUST_FROM_PRIOR_JWT.FROM_PRIOR_JWT_FULL.split('.');
    const flipped = Buffer.from(signature, 'base64url');
    flipped[0] ^= 1;
    expect(
      verifyCompactJws(
        parseCompactJws(`${header}.${payload}.${flipped.toString('base64url')}`),
        publicJwkOf(charlie),
      ),
    ).toBe(false);
  });

  it.each(['invalid', 'a.b', 'a.b.c.d', '', 'e30.e30.AAAA'])('rejects the malformed token %p', (token) => {
    expect(() => parseCompactJws(token)).toThrow(DidcommError);
  });
});
