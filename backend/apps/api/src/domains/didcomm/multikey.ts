import { ECDH } from 'node:crypto';

import {
  base64urlDecode,
  base64urlEncode,
  multibaseDecodeBase58btc,
  multibaseEncodeBase58btc,
  varintDecode,
  varintEncode,
} from './encoding';
import { DidcommError } from './errors';
import { type EcCurve, isEcCurve, type KeyCurve, parsePublicJwk, type PublicJwk } from './jwk';

/**
 * Multikey: a multibase (`z`, base58btc) string holding a multicodec varint and the raw public key.
 * It is how `did:key` and `did:peer` spell keys, and how DID documents carry `publicKeyMultibase`.
 *
 * | multicodec | curve     | raw key                                  |
 * | ---------- | --------- | ---------------------------------------- |
 * | `0xed`     | Ed25519   | 32 bytes                                 |
 * | `0xec`     | X25519    | 32 bytes                                 |
 * | `0xe7`     | secp256k1 | 33 bytes, SEC1 compressed point          |
 * | `0x1200`   | P-256     | 33 bytes, SEC1 compressed point          |
 * | `0x1201`   | P-384     | 49 bytes, SEC1 compressed point          |
 * | `0x1202`   | P-521     | 67 bytes, SEC1 compressed point          |
 */

const CODE_TO_CURVE = new Map<number, KeyCurve>([
  [0xed, 'Ed25519'],
  [0xec, 'X25519'],
  [0xe7, 'secp256k1'],
  [0x1200, 'P-256'],
  [0x1201, 'P-384'],
  [0x1202, 'P-521'],
]);

const CURVE_TO_CODE = new Map<KeyCurve, number>([...CODE_TO_CURVE].map(([code, curve]) => [curve, code]));

const NODE_CURVE: Record<EcCurve, string> = {
  'P-256': 'prime256v1',
  'P-384': 'secp384r1',
  'P-521': 'secp521r1',
  secp256k1: 'secp256k1',
};

const COORDINATE_BYTES: Record<EcCurve, number> = {
  'P-256': 32,
  'P-384': 48,
  'P-521': 66,
  secp256k1: 32,
};

/** The raw public key bytes (Edwards/Montgomery u, or a SEC1 compressed point) for a JWK. */
function rawPublicKey(jwk: PublicJwk): Buffer {
  const x = base64urlDecode(jwk.x, 'JWK "x"', 'invalid-key');

  if (jwk.kty === 'OKP') {
    return x;
  }

  const y = base64urlDecode(jwk.y, 'JWK "y"', 'invalid-key');

  return Buffer.concat([Buffer.from([y[y.length - 1] & 1 ? 0x03 : 0x02]), x]);
}

export function multikeyFromJwk(jwk: PublicJwk): string {
  const code = CURVE_TO_CODE.get(jwk.crv);

  if (code === undefined) {
    throw new DidcommError('invalid-key', `no multicodec for ${jwk.crv}`);
  }

  return multibaseEncodeBase58btc(Buffer.concat([varintEncode(code), rawPublicKey(jwk)]));
}

/** Decodes a `publicKeyMultibase` / `did:key` value into a validated public JWK. */
export function jwkFromMultikey(multikey: string): PublicJwk {
  const bytes = multibaseDecodeBase58btc(multikey, 'multikey');
  const { value: code, length } = varintDecode(bytes);
  const curve = CODE_TO_CURVE.get(code);

  if (curve === undefined) {
    throw new DidcommError('invalid-key', `unsupported multicodec 0x${code.toString(16)}`);
  }

  const raw = bytes.subarray(length);

  if (curve === 'Ed25519' || curve === 'X25519') {
    if (raw.length !== 32) {
      throw new DidcommError('invalid-key', `a ${curve} key is 32 bytes`);
    }

    return parsePublicJwk({ kty: 'OKP', crv: curve, x: base64urlEncode(raw) });
  }

  if (!isEcCurve(curve)) {
    throw new DidcommError('invalid-key', `unsupported curve ${curve}`);
  }

  const size = COORDINATE_BYTES[curve];

  if (raw.length !== size + 1 || (raw[0] !== 0x02 && raw[0] !== 0x03)) {
    throw new DidcommError('invalid-key', `a ${curve} multikey holds a ${size + 1}-byte compressed point`);
  }

  let uncompressed: Buffer;

  try {
    // Throws for an x with no point on the curve: the point-validity check for compressed keys.
    uncompressed = ECDH.convertKey(raw, NODE_CURVE[curve], undefined, undefined, 'uncompressed') as Buffer;
  } catch {
    throw new DidcommError('invalid-key', `compressed ${curve} point is not on the curve`);
  }

  return parsePublicJwk({
    kty: 'EC',
    crv: curve,
    x: base64urlEncode(uncompressed.subarray(1, 1 + size)),
    y: base64urlEncode(uncompressed.subarray(1 + size)),
  });
}
