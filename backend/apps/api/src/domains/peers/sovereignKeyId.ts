/**
 * The one KERI-shaped `keyid` a peer signature may carry: `did:keri:D<x>`, where `<x>` is the
 * signer's Ed25519 public key exactly as the JWK `x` member holds it (43 base64url characters).
 *
 * ═══ THIS IS COMPANION MEMORY'S OWN CONVENTION, NOT CESR ═══
 *
 * A real KERI prefix is CESR qb64: the 32-byte key is left-padded before base64url, so its 43
 * characters after the code are NOT the JWK `x`, and `D` there marks a TRANSFERABLE key, one a
 * rotation event can replace. An `E` prefix is a digest of the inception event and names no key
 * at all: verifying it needs the KEL. This box resolves no KEL and decodes no CESR, so it accepts
 * neither. It accepts only this self-certifying form, where the identifier IS the key: a signature
 * verifies against the key the identifier spells out, and anything else (a real CESR prefix, an
 * `E` AID, a rotated key) fails closed, as an unknown key.
 *
 * Widening what is accepted (CESR decoding, KEL resolution) is a design change of its own; it
 * must not creep in through the patterns below.
 */

const SOVEREIGN_KEYID_PREFIX = 'did:keri:D';

/** `did:keri:D` and 43 base64url characters: the length of a 32-byte key without padding. */
const SOVEREIGN_KEYID_PATTERN = /^did:keri:D[A-Za-z0-9_-]{43}$/;

/** Whether `keyid` is the self-certifying form above, and spells out a 32-byte key. */
export function isSovereignKeyId(keyid: string): boolean {
  return SOVEREIGN_KEYID_PATTERN.test(keyid) && sovereignPublicJwk(keyid) != null;
}

/**
 * The Ed25519 public JWK a sovereign `keyid` spells out, or null for anything else.
 *
 * The round trip refuses an `x` whose last character carries stray bits: two spellings of one
 * key would be two identifiers for one peer.
 */
export function sovereignPublicJwk(keyid: string): Record<string, unknown> | null {
  if (!SOVEREIGN_KEYID_PATTERN.test(keyid)) {
    return null;
  }

  const x = keyid.slice(SOVEREIGN_KEYID_PREFIX.length);
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== x) {
    return null;
  }

  return { kty: 'OKP', crv: 'Ed25519', x };
}

/** The sovereign `keyid` for an Ed25519 public JWK, or null when it is not one. */
export function sovereignKeyIdFor(jwk: Record<string, unknown>): string | null {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    return null;
  }

  const keyid = `${SOVEREIGN_KEYID_PREFIX}${jwk.x}`;

  return sovereignPublicJwk(keyid) ? keyid : null;
}
