/**
 * DIDComm Messaging v2.1 (https://didcomm.org/), alongside — not on top of — the KERI design in
 * `domains/peers` and `domains/asks`.
 *
 * Two layers that answer different questions are kept apart on purpose:
 *
 *   - **Identifiers and keys** (who is this, which keys are theirs): `did:key`, `did:peer`, `did:web`
 *     here; KERI/ToIP in the design of ADR-0013, which is not implemented (the Hub froze its KERI
 *     module, and `did:keri:D<x>` in Companion Memory is its own spelling of an Ed25519 key, not
 *     CESR). DIDComm is identifier-agnostic: it asks a {@link DidResolver} for a DID document and
 *     uses the keys that document lists. A conformant KERI-backed resolver (`did:webs`) would plug in
 *     through `createDidResolver({ methods })` without touching anything else. `did:keri` itself is
 *     refused.
 *   - **Messages** (confidentiality, sender authentication, routing, threading, protocols): this
 *     domain. Authcrypt/anoncrypt envelopes, signed messages, mediator routing, trust-ping,
 *     discover-features, problem reports and out-of-band invitations.
 *
 * Nothing here is registered with Nest, exposed over HTTP, stored in the database or called from
 * any other domain. It makes no network request: DID resolution for `did:web` goes through a
 * caller-supplied `fetchJson`, and delivery returns the endpoint and bytes for the caller to send
 * through its own egress policy. See `docs/didcomm.md` for what exists, what does not, and how it is
 * meant to be wired.
 */
export { DidcommController } from './DidcommController';
export { DidcommModule } from './DidcommModule';
export { DidcommAgent } from './agent';
export type {
  DidcommAgentOptions,
  HandlerContext,
  MessageHandler,
  OutboundReply,
  ReceiveResult,
} from './agent';
export { didOf, fragmentOf, isDid, isDidUrl, isPartyIdentifier } from './did';
export type { DidDocument, DidResolver, VerificationMethod } from './didDocument';
export { didcommEndpoints, keyForKid, parseDidDocument, relationshipKeys } from './didDocument';
export type { DidcommEndpoint, DocumentKey, VerificationRelationship } from './didDocument';
export { didKeyFromJwk, jwkFromDidKey, resolveDidKey } from './didKey';
export { createDidPeer2, resolveDidPeer } from './didPeer';
export type { PeerKeyInput, PeerKeyPurpose, PeerServiceInput } from './didPeer';
export { didWebToUrl } from './didWeb';
export type { DidWebOptions } from './didWeb';
export {
  buildDisclose,
  buildQueries,
  answerQueries,
  DISCLOSE_TYPE,
  DISCOVER_FEATURES_PROTOCOL,
  matchesPattern,
  QUERIES_TYPE,
} from './discoverFeatures';
export type { FeatureDisclosure, FeatureQuery } from './discoverFeatures';
export { ed25519PublicKeyToX25519 } from './edwards';
export { DidcommError, problemCodeFor } from './errors';
export type { DidcommErrorCode } from './errors';
export { createFromPrior, verifyFromPrior } from './fromPrior';
export type { VerifiedFromPrior } from './fromPrior';
export {
  didKeyIdentityFromEd25519Seed,
  generateDidKeyIdentity,
  generateDidPeerIdentity,
  secretsOf,
} from './identity';
export type { DidcommIdentity } from './identity';
export { generateKeyPair } from './jwk';
export type { KeyCurve, PrivateJwk, PublicJwk } from './jwk';
export {
  attachmentBytes,
  createMessage,
  isExpired,
  MEDIA_TYPE,
  parseMessage,
  parseMessageJson,
  threadIdOf,
} from './message';
export type { Attachment, DidcommMessage, MessageInit } from './message';
export {
  buildInvitation,
  decodeInvitationUrl,
  encodeInvitationUrl,
  OOB_INVITATION_TYPE,
  OOB_PROTOCOL,
  replyParentThread,
} from './outOfBand';
export type { InvitationInput } from './outOfBand';
export { packEncrypted, packPlaintext, packSigned, unpack } from './pack';
export type {
  EnvelopeLayer,
  PackContext,
  PackedMessage,
  PackEncryptedOptions,
  PackMetadata,
  UnpackMetadata,
  UnpackOptions,
  UnpackResult,
} from './pack';
export { belongsToProtocol, messageName, parseMessageType, parseProtocolId } from './piuri';
export {
  buildProblemReport,
  interpolateComment,
  isProblemCode,
  parseProblemReport,
  PROBLEM_REPORT_TYPE,
} from './problemReport';
export type { ParsedProblemReport, ProblemReportInput } from './problemReport';
export { InMemoryReplayGuard } from './replayGuard';
export type { ReplayGuard } from './replayGuard';
export { createDidResolver, firstOf, StaticDidResolver } from './resolver';
export type { DidResolverOptions } from './resolver';
export { buildForwardMessage, FORWARD_TYPE, parseForward, prepareDelivery } from './routing';
export type { Delivery, DeliveryOptions, ForwardInput, ParsedForward } from './routing';
export { InMemorySecretsResolver } from './secrets';
export type { SecretsResolver } from './secrets';
export {
  buildPing,
  buildPingResponse,
  PING_RESPONSE_TYPE,
  PING_TYPE,
  TRUST_PING_PROTOCOL,
  wantsResponse,
} from './trustPing';
