/**
 * DID methods this server understands, and the one question the authorization profile asks of
 * them: "is this verification method, today, authorized for this verification relationship?"
 *
 * PWS "Space Controller DID Method Registry" makes `did:key` (Ed25519, Multikey) the mandatory
 * floor and every other method optional, and says a server refuses a controller whose method it
 * does not support with `invalid-request-body` (400). That refusal is how `did:keri` is handled
 * here: it is not in the registry the specification defines, the Hub's in-tree KERI module is frozen, and
 * Memory's own `did:keri:D<jwk-x>` is not CESR (see `docs/pws.md`), so no `DidMethodSupport` for it exists. When a
 * conformant KERI resolver does, it plugs in below and nothing else in this domain changes.
 *
 * The current-key-set rule (PWS-AUTHZ): the key that verifies an invocation or a delegation is
 * the one in the signer's DID document *as resolved at verification time*, under the relationship
 * the operation needs (`capabilityInvocation`, `capabilityDelegation`). A `did:key` document never
 * changes; a method with a mutable, verified history does, and removing a key there withdraws
 * everything that key delegated, with no revocation list involved. That is the property KERI's
 * rotation gives, and the reason this seam resolves per request instead of caching a key.
 */
import { didMethodOf, resolveDidKey } from './didKey';
import type { DidDocument } from './didKey';
import { multibaseDecode } from './multibase';

export type VerificationRelationship = 'capabilityInvocation' | 'capabilityDelegation';

export interface DidMethodSupport {
  /** The method name: `key` for `did:key`. */
  readonly method: string;
  /** The DID document for `did`, verified as the method requires, or undefined. Never throws. */
  resolve(did: string): Promise<DidDocument | undefined>;
}

/** `did:key`, Ed25519 Multikey. The document is derived from the identifier alone. */
export const didKeyMethod: DidMethodSupport = {
  method: 'key',
  resolve: async (did) => {
    try {
      return resolveDidKey(did);
    } catch {
      return undefined;
    }
  },
};

const DID = /^did:([a-z0-9]+):[A-Za-z0-9._:%-]+$/;

export function isDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && DID.test(value);
}

/** The DID part of a DID URL (everything before `#`). */
export function didOf(didUrl: string): string {
  const hash = didUrl.indexOf('#');

  return hash === -1 ? didUrl : didUrl.slice(0, hash);
}

export interface ResolvedKey {
  /** The DID that controls the key (the signer's identity). */
  did: string;
  publicKey: Uint8Array;
}

/** Ed25519 Multikey: multibase base58btc of `0xed 0x01 || key`. */
export function publicKeyFromEd25519Multikey(publicKeyMultibase: string): Uint8Array | undefined {
  try {
    const { prefix, bytes } = multibaseDecode(publicKeyMultibase);
    if (prefix !== 'z' || bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
      return undefined;
    }

    return bytes.slice(2);
  } catch {
    return undefined;
  }
}

export class DidRegistry {
  private readonly methods = new Map<string, DidMethodSupport>();

  constructor(methods: readonly DidMethodSupport[] = [didKeyMethod]) {
    for (const method of methods) {
      this.methods.set(method.method, method);
    }
  }

  /** The method names this registry resolves, for error messages and the docs. */
  supportedMethods(): string[] {
    return [...this.methods.keys()];
  }

  supports(did: string): boolean {
    const method = didMethodOf(did);

    return method !== undefined && this.methods.has(method);
  }

  async resolveDocument(did: string): Promise<DidDocument | undefined> {
    const method = didMethodOf(did);
    const support = method === undefined ? undefined : this.methods.get(method);

    return support ? support.resolve(did) : undefined;
  }

  /**
   * The key behind a verification-method DID URL, only if the *current* DID document lists that
   * method under `relationship`. Anything else (unsupported method, no document, method absent or
   * in another relationship, not an Ed25519 Multikey) is undefined: the caller cannot tell which,
   * and does not need to.
   */
  async resolveKey(
    verificationMethod: string,
    relationship: VerificationRelationship,
  ): Promise<ResolvedKey | undefined> {
    if (!verificationMethod.includes('#') || verificationMethod.length > 2048) {
      return undefined;
    }

    const did = didOf(verificationMethod);
    const document = await this.resolveDocument(did);
    if (!document || document.id !== did) {
      return undefined;
    }

    const listed = document[relationship].some((entry) => entry === verificationMethod);
    if (!listed) {
      return undefined;
    }

    const method = document.verificationMethod.find((candidate) => candidate.id === verificationMethod);
    if (!method || method.controller !== did) {
      return undefined;
    }

    const publicKey = publicKeyFromEd25519Multikey(method.publicKeyMultibase);

    return publicKey ? { did, publicKey } : undefined;
  }
}
