import { createHash, timingSafeEqual } from 'node:crypto';

import { multibaseDecode, multibaseEncode, sha256Multihash } from './multibase';

/**
 * The request-body integrity header of the Portable Web Spaces authorization profile (PWS-AUTHZ, "Request
 * Body Integrity"): `Digest: mh=<multibase base64url of the sha2-256 multihash of the body>`.
 *
 * It is the legacy `Digest` header of RFC 3230 carrying a multihash instead of `SHA-256=<base64>`. Only that
 * form is accepted. `digest.spec.ts` pins the value to published SHA-256 digests (FIPS 180-2) and the shape to the
 * PWS-AUTHZ example (`mh=uEiC...`); the headers `@interop/http-digest-header` produces for fixed bodies are
 * checked in `referenceVectors.spec.ts` against the vectors that stack generated.
 */

const MULTIHASH_PREFIX = 'mh=';

/** `mh=u...` for `body`. */
export function digestHeaderValue(body: Uint8Array): string {
  return `${MULTIHASH_PREFIX}${multibaseEncode('u', sha256Multihash(body))}`;
}

/**
 * Whether `value` is a well-formed `mh=` digest of exactly `body`. A list of digests, another algorithm, another
 * multibase and anything malformed are all `false`; this never throws.
 */
export function verifyDigestHeader(value: string, body: Uint8Array): boolean {
  if (!value.startsWith(MULTIHASH_PREFIX)) {
    return false;
  }

  try {
    const { prefix, bytes } = multibaseDecode(value.slice(MULTIHASH_PREFIX.length));
    if (prefix !== 'u' || bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
      return false;
    }

    return timingSafeEqual(bytes.subarray(2), createHash('sha256').update(body).digest());
  } catch {
    return false;
  }
}
