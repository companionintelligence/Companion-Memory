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
 * The checks, in order. The order is a COST order: each check is dearer than the ones before it, and
 * an expensive one is reached only by a caller who has already paid for the cheaper ones.
 *
 *   1.  decode the response and the challenge inside it   microseconds; nothing else can proceed on garbage
 *   2.  version, audience, nonce length, time window       arithmetic; needs no key and no store
 *   3.  claim an attempt on the nonce (the store)          a lookup. A challenge that was never issued, was
 *                                                          already answered or is out of attempts ends HERE,
 *                                                          before any signature work or database read
 *   4.  the classical signature                            a fraction of a millisecond
 *   5.  the identity and its post-quantum PIN              a database read. An identity the lookup does not
 *                                                          know ends here, before step 6
 *   6.  the post-quantum policy and signature              milliseconds: the dearest check, so the last
 *   7.  spend the nonce                                    only a response that passed everything spends it
 *
 * What protects what. The classical signature proves possession of SOME key, and an anonymous caller
 * has a throwaway one, so it is not what protects step 5 or step 6. Step 3 is: a caller needs a live
 * challenge from this verifier, and gets a few attempts at it. Step 5's `unknown-identity` answer is
 * the other half: with it, only an enrolled identity is ever put through step 6.
 *
 * It returns a result and does not throw for anything a peer can send. It DOES throw (the call
 * rejects) when OUR side fails or breaks its contract: a store that cannot be reached, or a store or
 * callback that returns something outside its type. That must not be readable as either an acceptance
 * or an authentication failure, and an unrecognized answer must never be read as a favorable one.
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
 *
 * WHERE A PIN MAY COME FROM: NOT FROM A LOGIN. The classical signature covers the challenge and nothing
 * else, so it does not cover the response's PQ key. Anyone who can ALTER one response, with no
 * cryptanalysis at all, can keep the owner's classical half and swap in a key pair of their own, and
 * `pq-required` passes with THEIR key. A caller that pinned "whatever the first good login carried"
 * would pin that key, lock the owner out, and leave the attacker's key as the one a later forger of
 * classical signatures needs. A pin is recorded at ENROLLMENT, over an authenticated channel, in a
 * step where both keys sign a message that names both public keys (the wiring phase). Until then,
 * {@link Verified.pqPinned} is how a caller tells a post-quantum key that matched such a record from
 * one that merely signed.
 */
export type PqPin =
  /** Not enrolled here: refuse now, before any post-quantum work. This is the pin lookup's way to say "I do not know this key". */
  | { readonly kind: 'unknown-identity' }
  /**
   * No memory of a post-quantum key, and the caller does not mind: whatever valid key the response
   * carries is accepted. The key is NOT evidence of anything and must not be recorded as a pin. This is
   * also what a verifier with no pin store gets for every identity.
   */
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
  /**
   * The pin for a classical fingerprint. Omit it and every identity is `unpinned`. A verifier whose
   * identities are all enrolled should answer `unknown-identity` for any other fingerprint, which keeps
   * the post-quantum verification (the dearest check) away from strangers.
   */
  readonly resolvePqPin?: (fingerprint: Uint8Array) => PqPin | Promise<PqPin>;
}

/** The authenticated identity a successful verification produces. */
export interface Verified {
  readonly fingerprint: Uint8Array;
  readonly publicKey: ClassicalPublicKey;
  /** The PQ key that signed, if any. */
  readonly pqPublicKey: PqPublicKey | null;
  /**
   * True only when `pqPublicKey` matched a `key` pin, so the post-quantum signature is about THIS
   * identity. False for every other case, including a valid signature from an `unpinned` identity: the
   * key is then whatever the response carried, and it must not be recorded as a pin.
   */
  readonly pqPinned: boolean;
}

export type VerifyResult =
  | { readonly ok: true; readonly verified: Verified }
  | { readonly ok: false; readonly code: IdentiKeyErrorCode };

const fail = (code: IdentiKeyErrorCode): VerifyResult => ({ ok: false, code });

/**
 * Our side broke its contract: a store or callback answered with something its type does not allow
 * (an untyped database row, a value added to a union later). The only safe response is to reject the
 * call. Reading an unknown answer as "fine", the way a `switch` with no default does, would
 * authenticate a caller on the strength of a bug.
 */
function outsideContract(what: string, value: unknown): Error {
  let shown: string;
  if (typeof value === 'string') {
    shown = JSON.stringify(value.slice(0, 32));
  } else {
    shown = value === null ? 'null' : typeof value;
  }

  return new Error(`identikey: ${what} returned ${shown}, which is not a value it may return`);
}

/**
 * Ask the caller's pin lookup, and check that what comes back is an object at all. An untyped database
 * row can resolve `undefined` or `null`; reading `.kind` off that would throw an accident of a
 * TypeError, and the contract error says what actually went wrong. The `kind` itself is checked by the
 * caller's `switch`, whose `default` rejects.
 */
async function lookupPin(options: VerifyOptions, fingerprint: Uint8Array): Promise<PqPin> {
  if (options.resolvePqPin === undefined) {
    return { kind: 'unpinned' };
  }

  const pin: unknown = await options.resolvePqPin(fingerprint);
  if (typeof pin !== 'object' || pin === null) {
    throw outsideContract('resolvePqPin', pin);
  }

  return pin as PqPin;
}

function assertOptions(options: VerifyOptions): void {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new RangeError('now must be Unix seconds (a non-negative integer)');
  }

  if (!Number.isSafeInteger(options.skewSeconds) || options.skewSeconds < 0) {
    throw new RangeError('skewSeconds must be a non-negative integer');
  }

  if (typeof options.audience !== 'string' || options.audience.length === 0) {
    throw new RangeError('audience must be a non-empty string');
  }

  // A typo must not weaken the policy: anything but the two known values is a configuration error.
  if (options.policy !== 'pq-optional' && options.policy !== 'pq-required') {
    throw new RangeError("policy must be 'pq-optional' or 'pq-required'");
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

  // Spec §7 step 3, before any signature work: this verifier issued the challenge, it is unspent, and
  // it has an attempt left. This claims the attempt, whatever the response turns out to say.
  const attempt = await options.nonces.beginAttempt(challenge.nonce, response.challengeBytes);
  switch (attempt) {
    case 'proceed':
      break;
    case 'unknown':
      return fail('unknown-challenge');
    case 'used':
      return fail('replay');
    case 'mismatch':
      return fail('challenge-mismatch');
    case 'exhausted':
      return fail('attempts-exceeded');
    default:
      throw outsideContract('the nonce store (beginAttempt)', attempt);
  }

  const payload = signingPayload(response.challengeBytes);
  if (!verifyClassical(response.publicKey, payload, response.signature)) {
    return fail('bad-signature');
  }

  const fingerprint = fingerprintOf(response.publicKey);
  const pin = await lookupPin(options, fingerprint);

  const pq = response.pq;
  let pqPinned = false;
  switch (pin.kind) {
    case 'unknown-identity':
      // Not enrolled. Nothing past this point (the post-quantum verification, milliseconds of
      // synchronous CPU) is spent on a key nobody here knows.
      return fail('unknown-identity');
    case 'key':
      // A pinned identity must present exactly its key. Absent is a downgrade; different is a swap.
      if (pq === undefined || !pqPublicKeysEqual(pq.publicKey, pin.publicKey)) {
        return fail('pq-key-changed');
      }

      pqPinned = true;
      break;
    case 'none':
      if (pq !== undefined) {
        return fail('pq-key-changed');
      }

      break;
    case 'unpinned':
      break;
    default:
      throw outsideContract('resolvePqPin (the kind of its pin)', (pin as { kind?: unknown }).kind);
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

  // Every check has passed. Only now spend the nonce.
  const spent = await options.nonces.consume(challenge.nonce, response.challengeBytes);
  switch (spent) {
    case 'consumed':
      break;
    case 'used':
      return fail('replay');
    case 'unknown':
      return fail('unknown-challenge');
    case 'mismatch':
      return fail('challenge-mismatch');
    default:
      throw outsideContract('the nonce store (consume)', spent);
  }

  return {
    ok: true,
    verified: {
      fingerprint,
      publicKey: response.publicKey,
      pqPublicKey: pq?.publicKey ?? null,
      pqPinned,
    },
  };
}
