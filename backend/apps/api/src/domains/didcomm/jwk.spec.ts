import { createPublicKey } from 'node:crypto';

import { base64urlDecode, base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import {
  generateKeyPair,
  isEcCurve,
  isKeyAgreementCurve,
  type KeyCurve,
  parsePrivateJwk,
  parsePublicJwk,
  privateKeyObject,
  publicJwkOf,
  publicKeyObject,
} from './jwk';
import { ALICE_DID_DOC, ALICE_SECRETS, BOB_DID_DOC, BOB_SECRETS } from './__tests__/vectors';

const ALL_CURVES: KeyCurve[] = ['Ed25519', 'X25519', 'P-256', 'P-384', 'P-521', 'secp256k1'];

describe('JWK parsing', () => {
  it('accepts every private key the DIDComm specification publishes, so each x/y matches its d', () => {
    for (const secret of [...ALICE_SECRETS, ...BOB_SECRETS]) {
      const jwk = parsePrivateJwk(secret);

      expect(jwk.kid).toBe(secret.kid);
      expect(jwk.crv).toBe(secret.crv);
    }
  });

  it('accepts every public key in the specification DID documents', () => {
    const methods = [
      ...(ALICE_DID_DOC.authentication as Array<{ publicKeyJwk: unknown }>),
      ...(ALICE_DID_DOC.keyAgreement as Array<{ publicKeyJwk: unknown }>),
      ...(BOB_DID_DOC.keyAgreement as Array<{ publicKeyJwk: unknown }>),
    ];

    expect(methods).toHaveLength(3 + 3 + 9);

    for (const method of methods) {
      expect(() => parsePublicJwk(method.publicKeyJwk)).not.toThrow();
    }
  });

  it.each(ALL_CURVES)('generates and re-parses a %s key pair', (curve) => {
    const { publicJwk, privateJwk } = generateKeyPair(curve);

    expect(privateJwk.crv).toBe(curve);
    expect(parsePublicJwk(publicJwk)).toEqual(publicJwk);
    expect(parsePrivateJwk(privateJwk)).toEqual(privateJwk);
    expect('d' in publicJwk).toBe(false);
    expect(publicJwkOf(privateJwk)).toEqual(publicJwk);
  });

  it('classifies curves', () => {
    expect(isEcCurve('P-256')).toBe(true);
    expect(isEcCurve('X25519')).toBe(false);
    expect(isKeyAgreementCurve('X25519')).toBe(true);
    expect(isKeyAgreementCurve('Ed25519')).toBe(false);
    expect(isKeyAgreementCurve('secp256k1')).toBe(false);
  });

  it('refuses private key material in a public position', () => {
    const { privateJwk } = generateKeyPair('X25519');

    expect(() => parsePublicJwk(privateJwk)).toThrow(/private key material/);
  });

  it.each([
    ['a non-object', 'x'],
    ['an array', []],
    ['an unsupported key type', { kty: 'RSA', n: 'AQAB', e: 'AQAB' }],
    ['an unsupported curve', { kty: 'EC', crv: 'P-192', x: 'AA', y: 'AA' }],
    ['a mismatched key type and curve', { kty: 'EC', crv: 'X25519', x: 'AA', y: 'AA' }],
    ['an OKP key with a y', { kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43), y: 'A'.repeat(43) }],
    ['a short x', { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }],
    ['an EC key without y', { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43) }],
    ['an x with padding', { kty: 'OKP', crv: 'X25519', x: `${'A'.repeat(43)}=` }],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePublicJwk(value)).toThrow(DidcommError);
  });

  it('rejects an EC point that is not on the curve (invalid-curve attack)', () => {
    const { publicJwk } = generateKeyPair('P-256');
    const y = base64urlDecode(publicJwk.y, 'y');
    y[31] ^= 0x01;

    expect(() => parsePublicJwk({ ...publicJwk, y: base64urlEncode(y) })).toThrow(/valid P-256/);
  });

  it('rejects a private JWK whose d does not belong to its x', () => {
    const first = generateKeyPair('X25519').privateJwk;
    const second = generateKeyPair('X25519').privateJwk;

    expect(() => parsePrivateJwk({ ...first, d: second.d })).toThrow(/does not match/);

    const ec = generateKeyPair('P-384').privateJwk;
    const other = generateKeyPair('P-384').privateJwk;

    expect(() => parsePrivateJwk({ ...ec, d: other.d })).toThrow(DidcommError);
  });

  it('drops members it does not use and keeps a string kid', () => {
    const { publicJwk } = generateKeyPair('Ed25519');
    const parsed = parsePublicJwk({ ...publicJwk, use: 'sig', alg: 'EdDSA', kid: 'did:example:a#k' });

    expect(parsed).toEqual({ ...publicJwk, kid: 'did:example:a#k' });
    expect(Object.keys(parsed).sort()).toEqual(['crv', 'kid', 'kty', 'x']);
  });

  it('builds Node key objects whose public halves agree', () => {
    for (const curve of ALL_CURVES) {
      const { publicJwk, privateJwk } = generateKeyPair(curve);
      const fromPrivate = createPublicKey(privateKeyObject(privateJwk)).export({ format: 'jwk' });
      const fromPublic = publicKeyObject(publicJwk).export({ format: 'jwk' });

      expect(fromPrivate).toEqual(fromPublic);
    }
  });
});
