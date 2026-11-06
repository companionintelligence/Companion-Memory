import { IdentiKeyError, MIN_NONCE_LENGTH, type IdentiKeyErrorCode } from '../errors';

import {
  decodeChallenge,
  decodeResponse,
  PROTOCOL_VERSION,
  signingPayload,
  type Challenge,
  type Response,
} from './challenge';
import { fingerprintOf, pqPublicKeysEqual, type ClassicalPublicKey, type PqPublicKey } from './keys';
import type { NonceStore } from './nonceStore';
import { verifyClassical, verifyPq } from './signatures';

/**
 * End-to-end verification of a response (identikey-auth-challenge-v1 §7).
 *
 * The checks, in order, and the reason for the order:
 *
 *   1.  decode the response and the challenge inside it   cheap, and nothing else can proceed on garbage
 *   2.  version, audience, nonce length, time window       cheap, and need no key
 *   3.  the classical signature                            only a signature holder gets past here
 *   4.  the post-quantum PIN                               a database read, so after (3), never before
 *   5.  the post-quantum policy and signature              the most expensive check, last of the crypto
 *   6.  spend the nonce                                    LAST, so a bad proof cannot burn a good challenge
 *
 * It returns a result and does not throw for anything a peer can send. It does throw (the call
 * rejects) when OUR side fails, such as a store that cannot be reached: that must not be readable as
 * either an acceptance or an authentication failure.
 */

/** How much post-quantum assurance the verifier demands. */
export type VerifyPolicy =
  /** Classical-only is accepted. If a PQ signature is present it must still verify. */
  | 'pq-optional'
  /** A verifiable PQ signature is required in addition to the classical one. */
  | 'pq-required';

/**
 * What the verifier already knows about an identity's post-quantum key.
 *
 * WHY THIS EXISTS. In the Rust reference a response carries its own ML-DSA public key, and nothing ties
 * that key to the identity: the fingerprint hashes the CLASSICAL key alone. So an attacker who can
 * forge the classical signature (the very thing a quantum computer enables, and the reason the PQ
 * signature exists) can attach a key pair of their own and a valid signature from it, and
 * `pq-required` is satisfied. The PQ signature then proves nothing about WHO signed.
 *
 * The cure cannot be inside a single response; it has to be a memory of which PQ key belongs to which
 * fingerprint. The caller supplies that memory through {@link VerifyOptions.resolvePqPin}.
 */
export type PqPin =
  /** First contact: nothing is known, so the response's PQ key (if any) is accepted and reported back to be pinned. */
  | { readonly kind: 'unpinned' }
  /** The identity is enrolled without a PQ key, so none may appear. */
  | { readonly kind: 'none' }
  /** The identity is enrolled with this PQ key, so it must appear, unchanged. */
  | { readonly kind: 'key'; readonly publicKey: PqPublicKey };

export interface VerifyOptions {
  /** The audience this verifier answers for. */
  readonly audience: string;
  /** Unix seconds. */
  readonly now: number;
  /** Clock skew tolerated on either end of the validity window, in seconds. */
  readonly skewSeconds: number;
  readonly policy: VerifyPolicy;
  readonly nonces: NonceStore;
  /** The pin for a classical fingerprint. Omit it and every identity is `unpinned`. */
  readonly resolvePqPin?: (fingerprint: Uint8Array) => PqPin | Promise<PqPin>;
}

/** The authenticated identity a successful verification produces. */
export interface Verified {
  readonly fingerprint: Uint8Array;
  readonly publicKey: ClassicalPublicKey;
  /** The PQ key that signed, if any. For an `unpinned` identity this is what the caller should now pin. */
  readonly pqPublicKey: PqPublicKey | null;
}

export type VerifyResult =
  | { readonly ok: true; readonly verified: Verified }
  | { readonly ok: false; readonly code: IdentiKeyErrorCode };

const fail = (code: IdentiKeyErrorCode): VerifyResult => ({ ok: false, code });

function assertOptions(options: VerifyOptions): void {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new RangeError('now must be Unix seconds (a non-negative integer)');
  }

  if (!Number.isSafeInteger(options.skewSeconds) || options.skewSeconds < 0) {
    throw new RangeError('skewSeconds must be a non-negative integer');
  }
}

export async function verifyResponse(
  responseBytes: Uint8Array,
  options: VerifyOptions,
): Promise<VerifyResult> {
  assertOptions(options);

  let response: Response;
  let challenge: Challenge;
  try {
    response = decodeResponse(responseBytes);
    challenge = decodeChallenge(response.challengeBytes);
  } catch (error) {
    if (error instanceof IdentiKeyError) {
      return fail(error.code);
    }

    throw error;
  }

  if (challenge.version !== PROTOCOL_VERSION) {
    return fail('version');
  }

  if (challenge.audience !== options.audience) {
    return fail('audience');
  }

  if (challenge.nonce.length < MIN_NONCE_LENGTH) {
    return fail('nonce-too-short');
  }

  // The window, with the same tolerance at both ends.
  if (
    options.now + options.skewSeconds < challenge.issuedAt ||
    options.now > challenge.expiresAt + options.skewSeconds
  ) {
    return fail('time-window');
  }

  const payload = signingPayload(response.challengeBytes);
  if (!verifyClassical(response.publicKey, payload, response.signature)) {
    return fail('bad-signature');
  }

  const fingerprint = fingerprintOf(response.publicKey);
  const pin: PqPin =
    options.resolvePqPin === undefined ? { kind: 'unpinned' } : await options.resolvePqPin(fingerprint);

  const pq = response.pq;
  switch (pin.kind) {
    case 'key':
      // A pinned identity must present exactly its key. Absent is a downgrade; different is a swap.
      if (pq === undefined || !pqPublicKeysEqual(pq.publicKey, pin.publicKey)) {
        return fail('pq-key-changed');
      }

      break;
    case 'none':
      if (pq !== undefined) {
        return fail('pq-key-changed');
      }

      break;
    case 'unpinned':
      break;
  }

  if (pq === undefined) {
    if (options.policy === 'pq-required') {
      return fail('pq-required');
    }
  } else if (!verifyPq(pq.publicKey, payload, pq.signature)) {
    // A present PQ signature must verify even under `pq-optional`: otherwise stripping or corrupting
    // it would be a free downgrade.
    return fail('bad-signature');
  }

  // Every cryptographic check has passed. Only now spend the nonce.
  switch (await options.nonces.consume(challenge.nonce, response.challengeBytes)) {
    case 'consumed':
      break;
    case 'used':
      return fail('replay');
    case 'unknown':
      return fail('unknown-challenge');
    case 'mismatch':
      return fail('challenge-mismatch');
  }

  return {
    ok: true,
    verified: {
      fingerprint,
      publicKey: response.publicKey,
      pqPublicKey: pq?.publicKey ?? null,
    },
  };
}
