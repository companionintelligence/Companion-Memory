/**
 * IdentiKey protocol tier: self-sovereign authentication that sits beside the KERI-shaped peer
 * identity (CI-Engineering ADR-0020). See docs/identikey.md for what is here, what is not, and why.
 *
 * Phase 1 is a LIBRARY. Nothing in this barrel registers a Nest module, opens a route, reads
 * configuration or touches the database; the wiring is a later phase behind its own flag.
 */

export { IdentiKeyError, MIN_NONCE_LENGTH, type IdentiKeyErrorCode } from './errors';

export {
  CLASSICAL_ALGORITHMS,
  PQ_ALGORITHMS,
  classicalAlgFromTag,
  pqAlgFromTag,
  type ClassicalAlg,
  type PqAlg,
} from './identity/algorithms';

export {
  bytesEqual,
  classicalPublicKey,
  classicalPublicKeyFromCbor,
  classicalSignature,
  classicalSignatureFromCbor,
  ed25519JwkOf,
  ed25519KeyFromJwk,
  fingerprintFromBase58,
  fingerprintOf,
  fingerprintToBase58,
  pqPublicKey,
  pqPublicKeyFromCbor,
  pqPublicKeysEqual,
  pqSignature,
  pqSignatureFromCbor,
  publicKeyToCbor,
  signatureToCbor,
  type ClassicalPublicKey,
  type ClassicalSignature,
  type Ed25519PublicJwk,
  type PqPublicKey,
  type PqSignature,
} from './identity/keys';

export {
  MAX_CHALLENGE_BYTES,
  MAX_CHALLENGE_ITEMS,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_ITEMS,
  PROTOCOL_VERSION,
  PURPOSE_CHALLENGE,
  SIGNING_CONTEXT,
  decodeChallenge,
  decodeResponse,
  encodeChallenge,
  encodeResponse,
  signingPayload,
  type Challenge,
  type Response,
} from './identity/challenge';

export {
  ChallengeIssuer,
  InMemoryNonceStore,
  type AttemptOutcome,
  type ChallengeIssuerOptions,
  type ConsumeOutcome,
  type InMemoryNonceStoreOptions,
  type IssuedChallenge,
  type NonceStore,
} from './identity/nonceStore';

export { verifyClassical, verifyPq } from './identity/signatures';

export {
  verifyResponse,
  type PqPin,
  type Verified,
  type VerifyOptions,
  type VerifyPolicy,
  type VerifyResult,
} from './identity/verify';

export { SoftwareSigner, respond, type RespondOptions, type Signer } from './identity/softwareSigner';
