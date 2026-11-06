import { didKeyVerificationMethod, publicKeyFromDidKey, publicKeyFromMultikey } from './didKey';

/**
 * Which public key may sign for an issuer.
 *
 * A Data Integrity proof names a `verificationMethod`; whether that key is allowed to speak for
 * the credential's `issuer` is decided here, not by the signature check. Two sources, nothing else:
 *
 *   - `did:key` issuers. The DID IS the key, so the only authorized verification method is the
 *     DID's own `did:key:z6Mk…#z6Mk…`.
 *   - Pinned communities. An operator lists a community's DID and the verification methods it may
 *     sign with. That is a trust decision made by a person, once, in configuration. Resolving a
 *     `did:webvh` log or a `did:web` document is not done here: it needs a network, a log
 *     verifier and a rotation story, and belongs in its own resolver behind this same signature.
 *
 * Everything else resolves to `null`, which the caller treats as "not verified". That includes
 * `did:keri:`: Companion Memory's own `did:keri:D<x>` key id is a local convention and the Hub's
 * KERI module is frozen, so neither is a DID this module can honestly resolve. A pinned entry for
 * a `did:keri:` DID is refused at configuration time for the same reason.
 */

export interface KeyRequest {
  /** The credential's `issuer`. */
  issuer: string;
  /** The proof's `verificationMethod`, a DID URL. */
  verificationMethod: string;
}

/** Resolves to the raw 32-byte Ed25519 public key, or `null` when this issuer may not use it. */
export type KeyResolver = (request: KeyRequest) => Promise<Uint8Array | null>;

export interface PinnedCommunity {
  /** The community's DID, e.g. `did:webvh:community.example.com:abc`. */
  did: string;
  /** The keys it may sign with, as DID URLs under `did` and their multikey values. */
  verificationMethods: ReadonlyArray<{ id: string; publicKeyMultibase: string }>;
}

export interface KeyResolverOptions {
  /** Accept `did:key` issuers signing with their own key. On by default. */
  allowDidKey?: boolean;
  pinned?: readonly PinnedCommunity[];
}

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._%:-]+$/;

export class KeyResolverConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyResolverConfigError';
  }
}

export function createKeyResolver(options: KeyResolverOptions = {}): KeyResolver {
  const allowDidKey = options.allowDidKey ?? true;
  const pinned = new Map<string, Map<string, Uint8Array>>();

  for (const community of options.pinned ?? []) {
    if (!DID.test(community.did)) {
      throw new KeyResolverConfigError(`pinned community ${JSON.stringify(community.did)} is not a DID`);
    }

    if (community.did.startsWith('did:key:') || community.did.startsWith('did:keri:')) {
      throw new KeyResolverConfigError(
        `${community.did.split(':').slice(0, 2).join(':')} cannot be pinned: did:key derives its own key and did:keri is not resolved here`,
      );
    }

    if (pinned.has(community.did)) {
      throw new KeyResolverConfigError(
        `${community.did} is pinned twice; list every key it may sign with in one entry`,
      );
    }

    const keys = new Map<string, Uint8Array>();
    for (const method of community.verificationMethods) {
      if (!method.id.startsWith(`${community.did}#`)) {
        throw new KeyResolverConfigError(`${method.id} is not a verification method of ${community.did}`);
      }

      if (keys.has(method.id)) {
        throw new KeyResolverConfigError(`${method.id} is listed twice`);
      }

      try {
        keys.set(method.id, publicKeyFromMultikey(method.publicKeyMultibase));
      } catch {
        throw new KeyResolverConfigError(`${method.id} does not hold an Ed25519 multikey`);
      }
    }

    pinned.set(community.did, keys);
  }

  return ({ issuer, verificationMethod }) => {
    if (issuer.startsWith('did:key:')) {
      return Promise.resolve(authorizeDidKey(allowDidKey, issuer, verificationMethod));
    }

    return Promise.resolve(pinned.get(issuer)?.get(verificationMethod) ?? null);
  };
}

function authorizeDidKey(allowed: boolean, issuer: string, verificationMethod: string): Uint8Array | null {
  if (!allowed) {
    return null;
  }

  try {
    return verificationMethod === didKeyVerificationMethod(issuer) ? publicKeyFromDidKey(issuer) : null;
  } catch {
    return null;
  }
}
