import { generateKeyPairSync } from 'node:crypto';

// Counts every call to the curve test (about 0.2 ms of BigInt arithmetic) while still doing the real work.
jest.mock('./ed25519Curve', () => {
  const actual = jest.requireActual('./ed25519Curve');

  return { __esModule: true, ...actual, isEd25519CurvePoint: jest.fn(actual.isEd25519CurvePoint) };
});

import { base58btcEncode, didKeyIdFor, didKeyPublicJwk, isDidKeyId, wellFormedDidKeyJwk } from './didKeyId';
import { isEd25519CurvePoint } from './ed25519Curve';
import {
  BODY_COMPONENT,
  PEER_SIGNATURE_ALG,
  formatSignatureParams,
  parseSignatureHeaders,
} from './httpSignature';
import { candidateFromActor, parseLocalPubHandle } from './localPubProfile';
import { selfCertifyingIssuerOf, selfCertifyingPublicJwk } from './selfCertifyingKeyId';

/**
 * The curve test is what makes a `did:key` VALID, and it is needed where a key is ADMITTED. The inbound
 * request path reads the same keyid several times before any limiter, so reading must not pay for it:
 * round two made every read cost about a millisecond per unauthenticated request (four curve tests, seven
 * for a linked one). These pin where the test runs and where it does not.
 */
const curve = isEd25519CurvePoint as unknown as jest.Mock;

const spell = (key: Uint8Array) => `did:key:z${base58btcEncode(Uint8Array.of(0xed, 0x01, ...key))}`;
const point = (y: number) => Uint8Array.from([y, ...Array.from({ length: 31 }, () => 0)]);
const real = () =>
  didKeyIdFor(
    generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  ) as string;

beforeEach(() => curve.mockClear());

describe('reading a did:key keyid does not run the curve test', () => {
  it('selfCertifyingIssuerOf and selfCertifyingPublicJwk read a well-formed did:key without it', () => {
    const did = real();
    curve.mockClear();

    expect(selfCertifyingIssuerOf(did)).toBe('did:key');
    expect(selfCertifyingPublicJwk(did)).not.toBeNull();
    expect(wellFormedDidKeyJwk(did)).not.toBeNull();
    expect(curve).not.toHaveBeenCalled();
  });

  it('reading accepts an off-curve key that is well formed, which cannot verify anything and cannot be linked', () => {
    const offCurve = spell(point(2));

    expect(selfCertifyingIssuerOf(offCurve)).toBe('did:key');
    expect(wellFormedDidKeyJwk(offCurve)).not.toBeNull();
    expect(curve).not.toHaveBeenCalled();

    // ...and ADMISSION refuses it.
    expect(isDidKeyId(offCurve)).toBe(false);
    expect(didKeyPublicJwk(offCurve)).toBeNull();
    expect(curve).toHaveBeenCalled();
  });

  it('reading still refuses a weak key and a non-canonical string, which need no curve test', () => {
    const did = real();
    curve.mockClear();

    expect(wellFormedDidKeyJwk(spell(point(1)))).toBeNull();
    expect(wellFormedDidKeyJwk(`${did}1`)).toBeNull();
    expect(selfCertifyingIssuerOf(spell(point(1)))).toBeNull();
    expect(curve).not.toHaveBeenCalled();
  });

  it('parsing the signature headers of a did:key request does not run it', () => {
    const did = real();
    curve.mockClear();
    const rawParams = formatSignatureParams({
      components: ['@method', '@target-uri', BODY_COMPONENT],
      created: 1_800_000_000,
      expires: 1_800_000_060,
      keyid: did,
      alg: PEER_SIGNATURE_ALG,
      nonce: 'n'.repeat(22),
    });

    const parsed = parseSignatureHeaders(`ci=${rawParams}`, `ci=:${Buffer.alloc(64, 1).toString('base64')}:`);

    expect(parsed.params.keyid).toBe(did);
    expect(curve).not.toHaveBeenCalled();
  });

  it('admitting a key runs it once', () => {
    const did = real();
    curve.mockClear();

    expect(isDidKeyId(did)).toBe(true);
    expect(curve).toHaveBeenCalledTimes(1);
  });
});

describe('a hostile profile cannot make a lookup spend its time on the curve test', () => {
  it('stops after a handful of curve tests however many did:key candidates it carries', () => {
    const handle = parseLocalPubHandle('alice@alice.example') as NonNullable<
      ReturnType<typeof parseLocalPubHandle>
    >;
    const actorUrl = 'https://alice.example/actor';
    // Well-formed and not weak, but off the curve: each one is a candidate that costs a curve test.
    const offCurve: string[] = [];
    // 35 of them fill a field to 1,994 of the 2,048 characters it may have; 36 would be over the limit and
    // the field would be skipped whole, which proves nothing about the budget.
    for (let y = 2; offCurve.length < 35; y += 1) {
      const candidate = spell(point(y));
      if (wellFormedDidKeyJwk(candidate) != null && !isDidKeyId(candidate)) {
        offCurve.push(candidate);
      }
    }

    curve.mockClear();
    const actor = {
      id: actorUrl,
      type: 'Person',
      preferredUsername: 'alice',
      attachment: Array.from({ length: 32 }, () => ({
        type: 'PropertyValue',
        name: 'Companion',
        value: offCurve.join(' '),
      })),
    };

    const candidate = candidateFromActor(actor, handle, actorUrl);

    expect(candidate?.companionDidKey).toBeNull();
    // Looked at (the budget is spent) and then stopped: not zero, which would mean nothing was read.
    expect(curve.mock.calls.length).toBe(8);
  });

  it('still finds a genuine key that is one of the first candidates', () => {
    const handle = parseLocalPubHandle('alice@alice.example') as NonNullable<
      ReturnType<typeof parseLocalPubHandle>
    >;
    const actorUrl = 'https://alice.example/actor';
    const genuine = real();
    const actor = {
      id: actorUrl,
      type: 'Person',
      attachment: [{ type: 'PropertyValue', name: 'Companion', value: `${spell(point(2))} ${genuine}` }],
    };

    expect(candidateFromActor(actor, handle, actorUrl)?.companionDidKey).toBe(genuine);
  });
});
