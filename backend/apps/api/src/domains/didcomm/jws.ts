import { type KeyObject, sign, verify } from 'node:crypto';

import {
  base64urlDecode,
  base64urlEncode,
  isRecord,
  parseJsonObject,
  utf8Decode,
  utf8Encode,
} from './encoding';
import { DidcommError } from './errors';
import { type KeyCurve, type PrivateJwk, privateKeyObject, type PublicJwk, publicKeyObject } from './jwk';
import { MEDIA_TYPE, mediaTypeMatches } from './message';

/**
 * JWS for DIDComm signed messages (DIDComm Messaging v2.1, "Message Signing") and for the compact
 * `from_prior` JWT.
 *
 * | alg      | key       | notes                                          |
 * | -------- | --------- | ---------------------------------------------- |
 * | `EdDSA`  | Ed25519   | the default                                    |
 * | `ES256`  | P-256     | deprecated by the specification, still verified |
 * | `ES256K` | secp256k1 | verified and produced                          |
 *
 * Verification here is only the cryptographic half. Whether the signing key is *authorized* (listed
 * under `authentication` in the signer's DID document, for the DID in `from`) is checked by the
 * caller, in `pack.ts`, before it calls {@link verifyJwsSignature}: a valid signature from a key the
 * DID does not list is not a signature by that DID.
 */

export type SignatureAlgorithm = 'EdDSA' | 'ES256' | 'ES256K';

const ALGORITHM_CURVE: Record<SignatureAlgorithm, KeyCurve> = {
  EdDSA: 'Ed25519',
  ES256: 'P-256',
  ES256K: 'secp256k1',
};

export function isSignatureAlgorithm(value: unknown): value is SignatureAlgorithm {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALGORITHM_CURVE, value);
}

/** The JWS algorithm for a key's curve, or `undefined` when DIDComm signs with no algorithm for it. */
export function signatureAlgorithmFor(curve: KeyCurve): SignatureAlgorithm | undefined {
  return (Object.keys(ALGORITHM_CURVE) as SignatureAlgorithm[]).find((alg) => ALGORITHM_CURVE[alg] === curve);
}

function signBytes(alg: SignatureAlgorithm, key: KeyObject, data: Buffer): Buffer {
  return alg === 'EdDSA' ? sign(null, data, key) : sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
}

function verifyBytes(alg: SignatureAlgorithm, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    return alg === 'EdDSA'
      ? verify(null, data, key, signature)
      : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

export interface JwsSignature {
  protected: string;
  signature: string;
  header: { kid: string };
}

export interface GeneralJws {
  payload: string;
  signatures: JwsSignature[];
}

/** Signs `payload` with the key behind `signer` (which must carry its `kid`) as a general-serialization JWS. */
export function createJws(payload: Uint8Array, signer: PrivateJwk): GeneralJws {
  const alg = signatureAlgorithmFor(signer.crv);

  if (!alg || !signer.kid) {
    throw new DidcommError('unsupported-algorithm', `cannot sign with ${signer.crv} (or the key has no kid)`);
  }

  const protectedHeader = base64urlEncode(utf8Encode(JSON.stringify({ typ: MEDIA_TYPE.signed, alg })));
  const payloadText = base64urlEncode(payload);
  const signature = signBytes(
    alg,
    privateKeyObject(signer),
    Buffer.from(`${protectedHeader}.${payloadText}`, 'ascii'),
  );

  return {
    payload: payloadText,
    signatures: [
      { protected: protectedHeader, signature: base64urlEncode(signature), header: { kid: signer.kid } },
    ],
  };
}

export interface ParsedJws {
  payload: Buffer;
  payloadText: string;
  protectedText: string;
  alg: SignatureAlgorithm;
  kid: string;
  signature: Buffer;
}

/**
 * Reads a general or flattened JWS (both must be accepted) with exactly one signature, and checks
 * its protected header: a known `alg`, the DIDComm `typ` if any, and none of the extensions
 * (`crit`, `b64`) that change how the payload is processed.
 */
export function parseJws(value: Record<string, unknown>): ParsedJws {
  const entries = Array.isArray(value.signatures) ? value.signatures : [value];

  if (entries.length !== 1 || !isRecord(entries[0])) {
    throw new DidcommError('malformed-envelope', 'a signed DIDComm message has exactly one signature');
  }

  const entry = entries[0];
  const payload = base64urlDecode(value.payload, 'JWS payload');
  const protectedText = entry.protected;
  const header = parseJsonObject(
    utf8Decode(
      base64urlDecode(protectedText, 'JWS protected header'),
      'JWS protected header',
      'malformed-envelope',
    ),
    'JWS protected header',
    'malformed-envelope',
  );

  if (!isSignatureAlgorithm(header.alg)) {
    throw new DidcommError(
      'unsupported-algorithm',
      `JWS algorithm ${String(header.alg)} is not one DIDComm uses`,
    );
  }

  if (header.typ !== undefined && !mediaTypeMatches(header.typ, MEDIA_TYPE.signed)) {
    throw new DidcommError('malformed-envelope', `JWS "typ" must be ${MEDIA_TYPE.signed}`);
  }

  if ('crit' in header || 'b64' in header) {
    throw new DidcommError(
      'unsupported-algorithm',
      'JWS header extensions ("crit", "b64") are not supported',
    );
  }

  const unprotected = entry.header;
  const kidFromHeader = isRecord(unprotected) ? unprotected.kid : undefined;
  const kid = header.kid ?? kidFromHeader;

  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 2048) {
    throw new DidcommError('malformed-envelope', 'JWS signature has no "kid"');
  }

  if (header.kid !== undefined && kidFromHeader !== undefined && header.kid !== kidFromHeader) {
    throw new DidcommError(
      'malformed-envelope',
      'JWS "kid" differs between protected and unprotected headers',
    );
  }

  return {
    payload,
    payloadText: value.payload as string,
    protectedText: protectedText as string,
    alg: header.alg,
    kid,
    signature: base64urlDecode(entry.signature, 'JWS signature'),
  };
}

/** The signature check alone: the algorithm must match the key's curve, then the bytes must verify. */
export function verifyJwsSignature(parsed: ParsedJws, key: PublicJwk): boolean {
  if (ALGORITHM_CURVE[parsed.alg] !== key.crv || parsed.signature.length !== 64) {
    return false;
  }

  return verifyBytes(
    parsed.alg,
    publicKeyObject(key),
    Buffer.from(`${parsed.protectedText}.${parsed.payloadText}`, 'ascii'),
    parsed.signature,
  );
}

/** Parses a JWS and checks its one signature against `key`. */
export function verifyJws(value: Record<string, unknown>, key: PublicJwk): boolean {
  return verifyJwsSignature(parseJws(value), key);
}

// ─── compact serialization (JWT), for from_prior ─────────────────────────────────────────────

export function createCompactJws(
  protectedHeader: { typ: string; kid?: string },
  payload: Record<string, unknown>,
  signer: PrivateJwk,
): string {
  const alg = signatureAlgorithmFor(signer.crv);

  if (!alg) {
    throw new DidcommError('unsupported-algorithm', `cannot sign with ${signer.crv}`);
  }

  const header = {
    typ: protectedHeader.typ,
    alg,
    ...(protectedHeader.kid ? { kid: protectedHeader.kid } : {}),
  };
  const input = `${base64urlEncode(utf8Encode(JSON.stringify(header)))}.${base64urlEncode(utf8Encode(JSON.stringify(payload)))}`;

  return `${input}.${base64urlEncode(signBytes(alg, privateKeyObject(signer), Buffer.from(input, 'ascii')))}`;
}

export interface ParsedCompactJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  alg: SignatureAlgorithm;
  signingInput: string;
  signature: Buffer;
}

export function parseCompactJws(token: string): ParsedCompactJws {
  const parts = typeof token === 'string' ? token.split('.') : [];

  if (parts.length !== 3) {
    throw new DidcommError('malformed-message', 'not a compact JWS');
  }

  const decode = (text: string, what: string) =>
    parseJsonObject(
      utf8Decode(base64urlDecode(text, what, 'malformed-message'), what),
      what,
      'malformed-message',
    );
  const header = decode(parts[0], 'JWT header');
  const payload = decode(parts[1], 'JWT payload');

  if (!isSignatureAlgorithm(header.alg)) {
    throw new DidcommError('unsupported-algorithm', `JWT algorithm ${String(header.alg)} is not supported`);
  }

  if ('crit' in header || 'b64' in header) {
    throw new DidcommError('unsupported-algorithm', 'JWT header extensions are not supported');
  }

  return {
    header,
    payload,
    alg: header.alg,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64urlDecode(parts[2], 'JWT signature', 'malformed-message'),
  };
}

export function verifyCompactJws(parsed: ParsedCompactJws, key: PublicJwk): boolean {
  if (ALGORITHM_CURVE[parsed.alg] !== key.crv || parsed.signature.length !== 64) {
    return false;
  }

  return verifyBytes(
    parsed.alg,
    publicKeyObject(key),
    Buffer.from(parsed.signingInput, 'ascii'),
    parsed.signature,
  );
}
