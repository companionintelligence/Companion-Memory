import { didMethod, isDid } from './did';
import { type DidDocument, type DidResolver, parseDidDocument } from './didDocument';
import { didKeyResolver } from './didKey';
import { didPeerResolver } from './didPeer';
import { createDidWebResolver, type DidWebOptions } from './didWeb';
import { DidcommError } from './errors';

export type { DidResolver } from './didDocument';

/**
 * DID resolution for DIDComm: a router from DID method to resolver.
 *
 * Built in and network-free: `did:key`, `did:peer` (numalgo 2). Opt-in: `did:web`, through a
 * caller-supplied `fetchJson` that carries the deployment's egress policy. Anything else is
 * pluggable by method name, which is where a conformant KERI resolver (`did:webs`, or `did:keri`
 * backed by a real key event log) would go.
 *
 * ═══ did:keri IS REFUSED ═══
 *
 * Not for lack of a resolver slot but on purpose. Companion Memory's `did:keri:D<x>` is its own
 * spelling of an Ed25519 key, not CESR, with no key event log behind it, and the Hub's KERI module
 * is frozen as non-interoperable. A DIDComm sender that "resolved" such an identifier would be
 * encrypting to a string that looks like a KERI AID and proves nothing a `did:key` does not.
 * ADR-0013 (KERI) and ADR-0018 (this domain) keep the two apart: plug a real resolver in through
 * `methods`, do not widen this one.
 */

export interface DidResolverOptions {
  /** Enables `did:web`. Omit to refuse it. */
  web?: DidWebOptions;
  /** Extra or overriding resolvers by DID method name, e.g. `{ webs: myKeriBackedResolver }`. */
  methods?: Record<string, DidResolver>;
}

const KERI_REFUSAL =
  'did:keri is not resolvable here: Companion Memory has no conformant KERI resolver (see ADR-0013 and ADR-0018). Use did:key or did:peer, or register a did:webs/did:keri resolver through `methods`.';

export function createDidResolver(options: DidResolverOptions = {}): DidResolver {
  const methods = new Map<string, DidResolver>([
    ['key', didKeyResolver],
    ['peer', didPeerResolver],
  ]);

  if (options.web) {
    methods.set('web', createDidWebResolver(options.web));
  }

  for (const [method, resolver] of Object.entries(options.methods ?? {})) {
    if (method === 'keri') {
      throw new DidcommError('invalid-argument', KERI_REFUSAL);
    }

    methods.set(method, resolver);
  }

  return {
    async resolve(did: string): Promise<DidDocument> {
      if (!isDid(did)) {
        throw new DidcommError('invalid-argument', 'resolve() takes a DID, not a DID URL or other text');
      }

      const method = didMethod(did);

      if (method === 'keri') {
        throw new DidcommError('unsupported-did-method', KERI_REFUSAL);
      }

      const resolver = methods.get(method);

      if (!resolver) {
        throw new DidcommError('unsupported-did-method', `did:${method} is not supported`);
      }

      let document: unknown;

      try {
        document = await resolver.resolve(did);
      } catch (error) {
        if (error instanceof DidcommError) {
          throw error;
        }

        throw new DidcommError('did-resolution-failed', `could not resolve ${did}`);
      }

      return parseDidDocument(document, did);
    },
  };
}

/** Resolves from a fixed table. Used by tests and by agents that pin a counterparty's document. */
export class StaticDidResolver implements DidResolver {
  private readonly documents: Map<string, DidDocument>;

  constructor(documents: DidDocument[]) {
    this.documents = new Map(documents.map((document) => [document.id, document]));
  }

  async resolve(did: string): Promise<DidDocument> {
    const document = this.documents.get(did);

    if (!document) {
      throw new DidcommError('did-resolution-failed', `no document for ${did}`);
    }

    return document;
  }
}

/** Tries each resolver in order; the first that does not fail wins. Lets a pinned table sit in front of the network. */
export function firstOf(...resolvers: DidResolver[]): DidResolver {
  return {
    async resolve(did: string): Promise<DidDocument> {
      let last: unknown;

      for (const resolver of resolvers) {
        try {
          return await resolver.resolve(did);
        } catch (error) {
          last = error;
        }
      }

      throw last instanceof DidcommError
        ? last
        : new DidcommError('did-resolution-failed', `could not resolve ${did}`);
    },
  };
}
