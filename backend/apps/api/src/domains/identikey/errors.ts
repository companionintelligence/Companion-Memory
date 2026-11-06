/**
 * Why an IdentiKey message was refused.
 *
 * The codes exist for logs, metrics and tests. They are NOT meant to reach the party that sent the
 * message: an HTTP surface built on this module should answer every one of them the same way, because
 * "your signature was wrong" and "your nonce was already used" tell an attacker which half of a forged
 * message to fix next. (The peer-ask surface already follows the same rule: one 401 for every failure.)
 */
export type IdentiKeyErrorCode =
  /** Not canonical dCBOR, wrong shape, an unknown member, or over a size limit. */
  | 'malformed'
  /** `v` is not the one protocol version this module speaks. */
  | 'version'
  /** An `alg` tag outside the registry. */
  | 'unknown-algorithm'
  /** Key bytes the algorithm cannot use: wrong length, off the curve, or a weak (small-order) point. */
  | 'bad-key'
  /** A signature that does not verify, or is the wrong length for its algorithm. */
  | 'bad-signature'
  /** The challenge was issued for a different audience than this verifier's. */
  | 'audience'
  /** Fewer than {@link MIN_NONCE_LENGTH} nonce bytes. */
  | 'nonce-too-short'
  /** Outside `[iat - skew, exp + skew]`, or the issued challenge expired before it was answered. */
  | 'time-window'
  /** The nonce was issued here and has already been answered. */
  | 'replay'
  /** The nonce was never issued here (or was, and has since been forgotten). Worth a log line: it is probing. */
  | 'unknown-challenge'
  /** The nonce was issued here, but for different challenge bytes than the response carries. */
  | 'challenge-mismatch'
  /** The challenge has had its allowed number of attempts. Whatever the next response says, it is not looked at. */
  | 'attempts-exceeded'
  /** The pin lookup said this fingerprint is not enrolled here. Refused before any post-quantum work. */
  | 'unknown-identity'
  /** Policy demands a post-quantum signature and none was present. */
  | 'pq-required'
  /** A post-quantum key without its signature, or the reverse. */
  | 'pq-dangling'
  /** The post-quantum part differs from what is pinned for this identity (a different key, a key where none was pinned, or none where one was). */
  | 'pq-key-changed'
  /** The nonce store is full of unexpired challenges and will not issue another. Map to 503/429, not 401. */
  | 'store-full';

/** Thrown by the decoders and constructors; `verifyResponse` converts it into a result instead. */
export class IdentiKeyError extends Error {
  constructor(
    readonly code: IdentiKeyErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'IdentiKeyError';
  }
}

/** The smallest verifier-issued nonce the protocol accepts, in bytes (identikey-auth-challenge-v1 §4.1). */
export const MIN_NONCE_LENGTH = 16;
