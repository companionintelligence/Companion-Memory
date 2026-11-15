/**
 * Portable Web Spaces (PWS), alongside — not on top of — the KERI code in `domains/peers`.
 *
 * A PWS server is a permissioned storage API: Spaces contain Collections contain Resources, every
 * Space has a DID `controller` as its root of trust, and access is by delegatable object
 * capabilities (zCaps) carried over HTTP Signatures. This domain implements the W3C Credentials
 * Community Group draft v0.5 (https://w3c-ccg.github.io/portable-web-spaces-spec/) and its
 * Authorization Profile v0.1: the Minimal profile plus listing, Collection and Space management,
 * multi-tenancy, linksets, `PublicCanRead` policies, Resource and Collection metadata, conditional
 * requests, cursor pagination and the service description.
 *
 * It sits beside the KERI design on purpose. Controllers are `did:key`; `did:keri` is refused with
 * the error the specification prescribes for an unsupported DID method. The frozen KERI module and
 * `peers/sovereignKeyId.ts` are not imported, and nothing imports this domain. The DID method
 * registry (`keys.ts`) is the seam where a conformant KERI resolver would plug in.
 *
 * Nothing here is registered with Nest, bound to a port or written to the database. See
 * `docs/pws.md` for what exists, what was verified against what, and what wiring it takes.
 */
export { PwsController } from './PwsController';
export { PwsModule } from './PwsModule';
export { createPwsHandler } from './handler';
export type { PwsConfig, PwsHandler } from './handler';
export type { PwsRequest, PwsResponse } from './http';
export { nodeListener } from './nodeAdapter';
export type { NodeListenerOptions } from './nodeAdapter';

export { StampClock, compareStamps } from './stamp';
export type { Stamp } from './stamp';
export { MemoryPwsStore } from './store';
export type { ListOptions, Page, PwsStore, PwsTx } from './store';
export type {
  CollectionRecord,
  Custom,
  Generator,
  PlaintextIndexDeclaration,
  PolicyDocument,
  PolicyScope,
  ResourceRecord,
  SpaceRecord,
  Validator,
} from './models';

export { DidRegistry, didKeyMethod, isDid, publicKeyFromEd25519Multikey } from './keys';
export type { DidMethodSupport, ResolvedKey, VerificationRelationship } from './keys';
export { PwsError, ERROR_STATUS, PWS_NAMESPACE } from './problems';
export type { ErrorKind } from './problems';
export { PwsUrls, parseRoute } from './routes';
export type { Route } from './routes';
export {
  buildServiceDescription,
  serviceLink,
  FEATURES,
  PWS_SPEC_ID,
  PWS_AUTHZ_PROFILE_ID,
} from './serviceDescription';
export type { InstanceDisclosure } from './serviceDescription';

// Capabilities: what a client or a grant issuer needs.
export {
  ZCAP_CONTEXT,
  ZcapError,
  authorizeInvocation,
  chainFor,
  decodeEmbeddedCapability,
  delegateCapability,
  formatCapabilityInvocation,
  isValidTarget,
  parseCapabilityInvocation,
  parseRootZcapId,
  rootZcapId,
  verifyDelegationChain,
} from './zcap';
export type { DelegatedZcap, DelegateOptions, DenialReason, RootZcap, Zcap } from './zcap';

// Primitives, each pinned to its specification's published vectors.
export * from './dataIntegrity';
export * from './didKey';
export * from './digest';
export * from './ed25519';
export * from './httpSignature';
export * from './jcs';
export * from './multibase';
