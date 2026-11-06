import { isUsableEd25519PublicKey } from './crypto/ed25519';
import { base64urlDecode, base64urlEncode } from './crypto/multibase';

/**
 * Verifiable Identifiers (VIDs) and what a consumer can learn from one.
 *
 * SPEC §3 defines a VID as "a string identifier whose controller is verifiable under a trust
 * framework", and leaves the scheme to the consumer's trust framework. This box's trust framework
 * today knows exactly one scheme, and it is Companion Memory's own, not a standard one:
 *
 *   did:keri:D<x>   where <x> is an Ed25519 public key's 43 base64url characters (the JWK `x`)
 *
 * ═══ THIS IS NOT CESR, AND NOT A KEL ═══
 *
 * `peers/sovereignKeyId.ts` is the authority on this form and its header says it plainly: a real KERI
 * prefix is CESR qb64 (the key is padded before base64url, and `D` marks a TRANSFERABLE key a rotation
 * event can replace), and an `E` prefix is a digest of an inception event that can only be resolved
 * from a Key Event Log. This box decodes no CESR and resolves no KEL, so it accepts only the
 * self-certifying form where the identifier IS the key. A rotated key, a CESR prefix or an `E` AID
 * resolves to nothing here — it fails closed, as an unknown key.
 *
 * The parse below is a deliberate copy of that file's SHAPE test, not an import: the dependency rules
 * forbid reaching into another domain's internals, and its barrel does not export the helper. Keep the
 * shape test identical. The KEY is checked more strictly here than there (a small-order or non-canonical
 * key is refused, see `sovereignKeyBytes`), because an identifier spelling such a key is not an identity.
 *
 * ═══ THE CONTROLLER DOCUMENT IS SYNTHESIZED, NOT FETCHED ═══
 *
 * A self-certifying identifier needs no resolution I/O: its one verification method is computed from
 * the identifier itself, and every verification relationship that can sign is granted to it, which is
 * what SPEC §4.7.3 says of a `did:key`'s single signing key. `keyAgreement` is deliberately absent.
 */

/** The verification relationships a signature can carry; a `keyAgreement` key never authorizes one. */
export const PROOF_PURPOSES = [
  'authentication',
  'assertionMethod',
  'capabilityInvocation',
  'capabilityDelegation',
] as const;
export type ProofPurpose = (typeof PROOF_PURPOSES)[number];

export function isProofPurpose(value: unknown): value is ProofPurpose {
  return typeof value === 'string' && (PROOF_PURPOSES as readonly string[]).includes(value);
}

export interface VerificationMethod {
  /** Absolute id, e.g. `did:keri:D…#D…`. */
  readonly id: string;
  /** The identifier whose controller document lists this method. */
  readonly controller: string;
  /** The raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** The relationships this method is authorized for. */
  readonly relationships: ReadonlySet<ProofPurpose>;
}

export interface ControllerDocument {
  readonly id: string;
  readonly verificationMethods: readonly VerificationMethod[];
}

export interface VidResolver {
  /** The controller document for `vid`, or null when this resolver does not know the scheme or the id. */
  resolve(vid: string): Promise<ControllerDocument | null>;
}

const SOVEREIGN_PREFIX = 'did:keri:D';
const SOVEREIGN_PATTERN = /^did:keri:D[A-Za-z0-9_-]{43}$/;

/**
 * Whether `vid` has the SHAPE of a self-certifying identifier: a string test, no arithmetic. It is what a
 * caller uses to turn away obvious non-identifiers before spending a database look-up, let alone the
 * curve check below.
 */
export function isSovereignVidShape(vid: string): boolean {
  return SOVEREIGN_PATTERN.test(vid);
}

/**
 * The 32-byte Ed25519 key a self-certifying `did:keri:D<x>` spells out, or null for anything else.
 *
 * Stricter than `peers/sovereignKeyId.ts` in one way, on purpose: the key must be a usable one. A
 * small-order key (the all-zero string, the identity, and six more) lets anyone produce a signature
 * that verifies without a private key, so an identifier spelling one is not an identity; a non-canonical
 * or off-curve string is not a key. See `crypto/ed25519.ts`.
 */
export function sovereignKeyBytes(vid: string): Uint8Array | null {
  if (!SOVEREIGN_PATTERN.test(vid)) {
    return null;
  }

  const raw = base64urlDecode(vid.slice(SOVEREIGN_PREFIX.length));

  return raw != null && raw.length === 32 && isUsableEd25519PublicKey(raw) ? raw : null;
}

/** The public JWK a self-certifying VID spells out (`{ kty, crv, x }`), or null for anything else. */
export function sovereignJwk(vid: string): { kty: 'OKP'; crv: 'Ed25519'; x: string } | null {
  const raw = sovereignKeyBytes(vid);

  return raw == null ? null : { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(raw) };
}

/** The self-certifying VID of an Ed25519 public key. */
export function sovereignVidFor(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new RangeError('an Ed25519 public key is 32 bytes');
  }

  return `${SOVEREIGN_PREFIX}${base64urlEncode(publicKey)}`;
}

/** `did:keri:D<x>#D<x>`: the one verification method of a self-certifying identifier. */
export function sovereignVerificationMethodId(vid: string): string {
  return `${vid}#${vid.slice('did:keri:'.length)}`;
}

/** Resolves `did:keri:D<x>` by computation alone. */
export class SovereignKeriVidResolver implements VidResolver {
  async resolve(vid: string): Promise<ControllerDocument | null> {
    const publicKey = sovereignKeyBytes(vid);
    if (publicKey == null) {
      return null;
    }

    return {
      id: vid,
      verificationMethods: [
        {
          id: sovereignVerificationMethodId(vid),
          controller: vid,
          publicKey,
          relationships: new Set<ProofPurpose>(PROOF_PURPOSES),
        },
      ],
    };
  }
}

/** Asks each resolver in turn; the first that knows the identifier answers. */
export class CompositeVidResolver implements VidResolver {
  constructor(private readonly resolvers: readonly VidResolver[]) {}

  async resolve(vid: string): Promise<ControllerDocument | null> {
    for (const resolver of this.resolvers) {
      const document = await resolver.resolve(vid);
      if (document != null) {
        return document;
      }
    }

    return null;
  }
}
