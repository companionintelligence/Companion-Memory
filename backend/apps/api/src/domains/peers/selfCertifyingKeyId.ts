import { wellFormedDidKeyJwk } from './didKeyId';
import { isSovereignKeyId, sovereignPublicJwk } from './sovereignKeyId';

/**
 * Every `keyid` form in which the IDENTIFIER IS THE KEY, so that a signature can be checked
 * against the key the identifier spells out, with no log, no ledger and no Portal.
 *
 * There are two, and each keeps its own file and its own rules:
 *
 *   - `did:keri:D<jwk-x>`  Companion Memory's own convention, see `sovereignKeyId.ts`.
 *   - `did:key:z6Mk…`      the published W3C CCG method, see `didKeyId.ts`.
 *
 * This file only answers "which kind is this, and what key does it spell out", so the call sites
 * that treat a self-certifying peer differently from a Portal peer (the controller, the link
 * lookup, the signature check) ask one question in one place and cannot disagree about it.
 *
 * ═══ READING, NOT ADMITTING ═══
 *
 * These functions answer for a keyid that arrived on a request or sits on a stored link, so they accept
 * a WELL-FORMED `did:key` and do not run the curve test (`didKeyId.ts` explains the two levels, and why:
 * about 0.2 ms each, several times per unauthenticated request). Whether a key may be LINKED is decided
 * where the link is written (`PeerLinkService.upsert` asks `isDidKeyId`, the full test). A key that is
 * not a point passes here and then fails the signature check, which no off-curve key can pass.
 *
 * Adding a form here is a design decision. A form that can rotate its key (KERI `E` AIDs,
 * `did:webvh`, `did:scid:vh`) does NOT belong: reading one means resolving a log, and a verifier
 * that skipped that would accept a key the controller had already retired.
 */

/** The issuer a `did:keri:D<x>` peer link carries; its subject is the keyid. */
export const SOVEREIGN_ISSUER = 'did:keri';

/** The issuer a `did:key` peer link carries; its subject is the keyid. */
export const DID_KEY_ISSUER = 'did:key';

export type SelfCertifyingIssuer = typeof SOVEREIGN_ISSUER | typeof DID_KEY_ISSUER;

/** Whether `issuer` is the issuer of a self-certifying peer link. */
export function isSelfCertifyingIssuer(issuer: unknown): issuer is SelfCertifyingIssuer {
  return issuer === SOVEREIGN_ISSUER || issuer === DID_KEY_ISSUER;
}

/** The issuer a peer link for this keyid carries, or null when the keyid is not self-certifying. */
export function selfCertifyingIssuerOf(keyid: string): SelfCertifyingIssuer | null {
  if (isSovereignKeyId(keyid)) {
    return SOVEREIGN_ISSUER;
  }

  return wellFormedDidKeyJwk(keyid) != null ? DID_KEY_ISSUER : null;
}

/** The Ed25519 public JWK a self-certifying keyid spells out, or null for anything else. */
export function selfCertifyingPublicJwk(keyid: string): Record<string, unknown> | null {
  return sovereignPublicJwk(keyid) ?? wellFormedDidKeyJwk(keyid);
}
