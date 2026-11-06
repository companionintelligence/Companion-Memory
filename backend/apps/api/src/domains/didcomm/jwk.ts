import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

import { base64urlDecode, isRecord } from './encoding';
import { DidcommError } from './errors';

/**
 * JWK handling for the six key types DIDComm Messaging v2.1 names: Ed25519 (signing), X25519 and
 * the NIST curves P-256, P-384, P-521 (key agreement), and secp256k1 (signing, `ES256K`).
 *
 * Parsing is strict about shape and length and returns a normalized copy that carries only the
 * members this domain uses. A DID document is remote input: a JWK that smuggles a private
 * member (`d`), names a curve it does not match, or has a short coordinate is refused here, not
 * discovered later inside a crypto call.
 */

export type EcCurve = 'P-256' | 'P-384' | 'P-521' | 'secp256k1';
export type KeyCurve = 'Ed25519' | 'X25519' | EcCurve;

export interface PublicJwk {
  kty: 'OKP' | 'EC';
  crv: KeyCurve;
  x: string;
  y?: string;
  /** Full DID URL of the key when it came from a DID document or a secrets store. Informational. */
  kid?: string;
}

export interface PrivateJwk extends PublicJwk {
  d: string;
}

/** Curves usable for ECDH, in the order a sender prefers them when both sides offer several. */
export const KEY_AGREEMENT_CURVES: readonly KeyCurve[] = ['X25519', 'P-256', 'P-384', 'P-521'];

const EC_COORDINATE_BYTES: Record<EcCurve, number> = {
  'P-256': 32,
  'P-384': 48,
  'P-521': 66,
  secp256k1: 32,
};

const NODE_NAMED_CURVE: Record<EcCurve, string> = {
  'P-256': 'prime256v1',
  'P-384': 'secp384r1',
  'P-521': 'secp521r1',
  secp256k1: 'secp256k1',
};

export function isEcCurve(value: unknown): value is EcCurve {
  return value === 'P-256' || value === 'P-384' || value === 'P-521' || value === 'secp256k1';
}

export function isKeyAgreementCurve(curve: KeyCurve): boolean {
  return KEY_AGREEMENT_CURVES.includes(curve);
}

function fixedLength(value: unknown, bytes: number, member: string): string {
  const decoded = base64urlDecode(value, `JWK "${member}"`, 'invalid-key');

  if (decoded.length !== bytes) {
    throw new DidcommError('invalid-key', `JWK "${member}" must be ${bytes} bytes`);
  }

  return value as string;
}

function parseShape(value: unknown, withPrivate: boolean): PublicJwk | PrivateJwk {
  if (!isRecord(value)) {
    throw new DidcommError('invalid-key', 'a JWK must be a JSON object');
  }

  if (!withPrivate && 'd' in value) {
    throw new DidcommError('invalid-key', 'a public JWK must not contain private key material ("d")');
  }

  const { kty, crv } = value;
  let jwk: PublicJwk;
  let privateBytes: number;

  if (kty === 'OKP' && (crv === 'Ed25519' || crv === 'X25519')) {
    if ('y' in value) {
      throw new DidcommError('invalid-key', 'an OKP JWK has no "y"');
    }

    jwk = { kty, crv, x: fixedLength(value.x, 32, 'x') };
    privateBytes = 32;
  } else if (kty === 'EC' && isEcCurve(crv)) {
    const size = EC_COORDINATE_BYTES[crv];

    jwk = { kty, crv, x: fixedLength(value.x, size, 'x'), y: fixedLength(value.y, size, 'y') };
    privateBytes = size;
  } else {
    throw new DidcommError('invalid-key', `unsupported JWK type (kty=${String(kty)}, crv=${String(crv)})`);
  }

  if (typeof value.kid === 'string' && value.kid.length > 0 && value.kid.length <= 2048) {
    jwk.kid = value.kid;
  }

  if (!withPrivate) {
    return jwk;
  }

  return { ...jwk, d: fixedLength(value.d, privateBytes, 'd') };
}

/** Creates the Node key object. Throws `invalid-key` for a point that is not on the curve. */
export function publicKeyObject(jwk: PublicJwk): KeyObject {
  try {
    return createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.y ? { y: jwk.y } : {}) },
      format: 'jwk',
    });
  } catch {
    throw new DidcommError('invalid-key', `JWK is not a valid ${jwk.crv} public key`);
  }
}

export function privateKeyObject(jwk: PrivateJwk): KeyObject {
  try {
    return createPrivateKey({
      key: {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        ...(jwk.y ? { y: jwk.y } : {}),
        d: jwk.d,
      },
      format: 'jwk',
    });
  } catch {
    throw new DidcommError('invalid-key', `JWK is not a valid ${jwk.crv} private key`);
  }
}

/**
 * Validates a public JWK taken from untrusted input (a DID document, a JWE `epk`): shape, lengths,
 * no private member, and, for the NIST and secp256k1 curves, that the point is on the curve. The
 * on-curve check is the "invalid curve attack" defence DIDComm Messaging v2.1 makes mandatory
 * when decrypting.
 */
export function parsePublicJwk(value: unknown): PublicJwk {
  const jwk = parseShape(value, false) as PublicJwk;
  publicKeyObject(jwk);
  return jwk;
}

/**
 * Validates a private JWK and checks that its public half is the one its `d` produces, so a store
 * holding a mismatched `x`/`d` pair fails at load, not as an inexplicable decryption failure.
 */
export function parsePrivateJwk(value: unknown): PrivateJwk {
  const jwk = parseShape(value, true) as PrivateJwk;
  const derived = derivePublicCoordinates(jwk);

  if (
    !derived.x.equals(Buffer.from(jwk.x, 'base64url')) ||
    (jwk.y !== undefined && !derived.y?.equals(Buffer.from(jwk.y, 'base64url')))
  ) {
    throw new DidcommError('invalid-key', 'private JWK does not match its public members');
  }

  return jwk;
}

/**
 * The public coordinates `d` actually produces. Node builds an EC key object from whatever `x`/`y`
 * it is handed and never checks them against `d`, so the EC branch multiplies the base point
 * itself (through ECDH); the OKP branch lets OpenSSL derive the public half from the seed.
 */
function derivePublicCoordinates(jwk: PrivateJwk): { x: Buffer; y?: Buffer } {
  if (jwk.kty === 'OKP') {
    const derived = createPublicKey(privateKeyObject(jwk)).export({ format: 'jwk' });

    return { x: Buffer.from(derived.x as string, 'base64url') };
  }

  const ecdh = createECDH(NODE_NAMED_CURVE[jwk.crv as EcCurve]);

  try {
    ecdh.setPrivateKey(Buffer.from(jwk.d, 'base64url'));
  } catch {
    throw new DidcommError('invalid-key', `JWK is not a valid ${jwk.crv} private key`);
  }

  const point = ecdh.getPublicKey(null, 'uncompressed');
  const size = (point.length - 1) / 2;

  return { x: point.subarray(1, 1 + size), y: point.subarray(1 + size) };
}

export function publicJwkOf(jwk: PublicJwk): PublicJwk {
  const { kty, crv, x, y, kid } = jwk;

  return { kty, crv, x, ...(y ? { y } : {}), ...(kid ? { kid } : {}) };
}

export function generateKeyPair(curve: KeyCurve): { publicJwk: PublicJwk; privateJwk: PrivateJwk } {
  const pair =
    curve === 'Ed25519'
      ? generateKeyPairSync('ed25519')
      : curve === 'X25519'
        ? generateKeyPairSync('x25519')
        : generateKeyPairSync('ec', { namedCurve: NODE_NAMED_CURVE[curve] });

  const privateJwk = parsePrivateJwk(pair.privateKey.export({ format: 'jwk' }));

  return { publicJwk: publicJwkOf(privateJwk), privateJwk };
}
