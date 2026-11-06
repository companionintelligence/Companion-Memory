import { generateKeyPairSync } from 'node:crypto';

import { didKeyIdFor } from './didKeyId';
import {
  DID_KEY_ISSUER,
  SOVEREIGN_ISSUER,
  isSelfCertifyingIssuer,
  selfCertifyingIssuerOf,
  selfCertifyingPublicJwk,
} from './selfCertifyingKeyId';
import { isSovereignKeyId, sovereignKeyIdFor, sovereignPublicJwk } from './sovereignKeyId';

const jwk = () =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

/** A real KERI prefix for a 32-byte Ed25519 key, by the published pre-pad rule, with code `D`. */
const cesrD = (key: Buffer) =>
  `D${Buffer.concat([Buffer.alloc(1), key])
    .toString('base64url')
    .slice(1)}`;

// The key of the CESR example recorded in Companion-Hub's FROZEN.md. Its last byte ends in the bits 11.
const KERI_KEY = Buffer.from('694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423', 'hex');

describe('selfCertifyingKeyId', () => {
  it('names the issuer of each self-certifying form', () => {
    const key = jwk();
    const sovereign = sovereignKeyIdFor(key) as string;
    const didKey = didKeyIdFor(key) as string;

    expect(selfCertifyingIssuerOf(sovereign)).toBe(SOVEREIGN_ISSUER);
    expect(selfCertifyingIssuerOf(didKey)).toBe(DID_KEY_ISSUER);
    expect(SOVEREIGN_ISSUER).toBe('did:keri');
    expect(DID_KEY_ISSUER).toBe('did:key');
  });

  it('reads the same key out of both spellings of it', () => {
    const key = jwk();
    const expected = { kty: 'OKP', crv: 'Ed25519', x: key.x };

    expect(selfCertifyingPublicJwk(sovereignKeyIdFor(key) as string)).toEqual(expected);
    expect(selfCertifyingPublicJwk(didKeyIdFor(key) as string)).toEqual(expected);
  });

  it.each([
    ['a JWK thumbprint', 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'],
    ['an E AID (the digest of an inception event, prefix E)', `did:keri:E${cesrD(KERI_KEY).slice(1)}`],
    ['did:web', 'did:web:local.pub'],
    ['did:webvh', 'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example'],
    ['did:scid:vh', 'did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth'],
    ['an empty string', ''],
  ])('does not treat %s as self-certifying', (_name, keyid) => {
    expect(selfCertifyingIssuerOf(keyid)).toBeNull();
    expect(selfCertifyingPublicJwk(keyid)).toBeNull();
  });

  it('knows exactly two issuers', () => {
    expect(isSelfCertifyingIssuer('did:keri')).toBe(true);
    expect(isSelfCertifyingIssuer('did:key')).toBe(true);
    expect(isSelfCertifyingIssuer('did:web')).toBe(false);
    expect(isSelfCertifyingIssuer('https://portal.example')).toBe(false);
    expect(isSelfCertifyingIssuer(undefined)).toBe(false);
  });
});

/**
 * ═══ MEMORY'S did:keri:D<x> IS NOT CESR, AND THE TWO CAN BE CONFUSED ═══
 *
 * A real KERI `D` prefix carries the key shifted right by two bits (the pre-pad rule puts two zero
 * bits in front of it), so its tail is not the JWK `x` of the key. Whether `sovereignKeyId` reads such
 * a tail depends on the last two bits of the key: they have to be zero for the tail to be a canonical
 * `x`. So about one real prefix in four is READ, as a different key, and three in four are refused.
 * Neither outcome verifies a signature made by the real key, so both fail closed; but "a real CESR
 * prefix is refused" is not true, and these two tests keep the documents from saying it.
 */
describe("a real CESR D prefix, read by Memory's did:keri:D convention", () => {
  it('is refused when the key ends in the bits 11, as three real prefixes in four do', () => {
    expect(KERI_KEY[31] & 0b11).toBe(0b11);
    expect(isSovereignKeyId(`did:keri:${cesrD(KERI_KEY)}`)).toBe(false);
  });

  it('is READ, as a different key, when the key ends in the bits 00, as one real prefix in four does', () => {
    const key = Buffer.from(KERI_KEY);
    key[31] &= 0b11111100;
    const keyid = `did:keri:${cesrD(key)}`;

    expect(isSovereignKeyId(keyid)).toBe(true);
    const read = Buffer.from(sovereignPublicJwk(keyid)?.x as string, 'base64url');

    expect(read.equals(key)).toBe(false);
    // The tail is the key shifted right by two bits: that shifted value is the "key" it is read as.
    expect(BigInt(`0x${read.toString('hex')}`)).toBe(BigInt(`0x${key.toString('hex')}`) >> 2n);
  });
});
