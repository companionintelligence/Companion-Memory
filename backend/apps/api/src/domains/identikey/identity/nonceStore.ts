import { randomBytes } from 'node:crypto';

import { IdentiKeyError, MIN_NONCE_LENGTH } from '../errors';

import { encodeChallenge, PROTOCOL_VERSION, type Challenge } from './challenge';
import { bytesEqual } from './keys';

/**
 * Verifier-issued nonces and replay protection (identikey-auth-challenge-v1 §6 and §7).
 *
 * A challenge is answerable exactly once, and only by the verifier that issued it. The store is what
 * makes both true: it remembers every challenge it handed out, and `consume` is an atomic
 * test-and-set, so two concurrent responses to one challenge cannot both win.
 *
 * It also makes the verifier's work a function of what it issued. `beginAttempt` runs BEFORE any
 * signature is checked (spec §7 step 3) and is an atomic test-and-increment, so a response to a
 * challenge that was never issued costs one lookup, and a challenge allows only a few attempts however
 * many responses are in flight at once. Without it, one live challenge, which any anonymous caller can
 * obtain, buys unlimited rounds of the most expensive thing the verifier does.
 *
 * Three departures from the Rust reference's `NonceStore`:
 *
 *   * The store keeps the exact CHALLENGE BYTES it issued under each nonce and refuses a response
 *     whose bytes differ. That is what makes the next point safe: `verifyResponse` judges the window
 *     from the timestamps INSIDE the response, so the store must vouch that they are the ones it
 *     issued. (The reference does not bind. It keeps one expiry per nonce, which caps `exp` but leaves
 *     `iat`, and everything else in the challenge, to the claimant.)
 *   * The store does not judge time. `verifyResponse` does, once, with the one skew parameter. (The
 *     reference also checks `now > exp` in its store, without skew, which silently cancels the upper
 *     half of the skew tolerance it applies a few lines earlier.)
 *   * The store limits attempts. The reference allows any number of failing responses to one challenge.
 *
 * This file is the interface and an in-memory implementation for one process. A deployment with more
 * than one API replica needs a shared store (the same `claimOnce` shape the peer-ask replay cache has);
 * that arrives with the wiring phase, behind this interface.
 */

export type ConsumeOutcome =
  /** First use of an issued challenge. The nonce is now spent. */
  | 'consumed'
  /** Never issued here (or forgotten). */
  | 'unknown'
  /** Issued here and already answered. */
  | 'used'
  /** Issued here, but the response carries different challenge bytes. */
  | 'mismatch';

export type AttemptOutcome =
  /** An issued, unspent challenge with an attempt left. One attempt has been used up. */
  | 'proceed'
  /** Never issued here (or forgotten). */
  | 'unknown'
  /** Issued here and already answered. */
  | 'used'
  /** Issued here, but the response carries different challenge bytes. Not counted: it is not an attempt at this challenge. */
  | 'mismatch'
  /** Issued here, unspent, and it has had all the attempts it gets. */
  | 'exhausted';

export interface NonceStore {
  /**
   * Remember a freshly issued challenge. Throws `store-full` when it cannot, and throws (a plain
   * Error) if the nonce is already present: a repeated 128-bit nonce means the random source is broken,
   * and overwriting a SPENT entry would resurrect it.
   */
  recordIssued(nonce: Uint8Array, challengeBytes: Uint8Array, expiresAt: number, now: number): Promise<void>;

  /**
   * Atomically claim one attempt at the challenge: if and only if it was issued here for exactly these
   * bytes, is unspent and has an attempt left, count the attempt and answer `proceed`. Called before any
   * signature work, so the count includes responses that turn out to be wrong, and a hostile caller
   * holding one live challenge gets a handful of tries and no more. It must be a single atomic
   * test-and-increment: concurrent callers must not all be told `proceed` past the limit.
   */
  beginAttempt(nonce: Uint8Array, challengeBytes: Uint8Array): Promise<AttemptOutcome>;

  /** Atomically spend the nonce, if and only if it was issued here for exactly these bytes and is unspent. */
  consume(nonce: Uint8Array, challengeBytes: Uint8Array): Promise<ConsumeOutcome>;

  /** Forget challenges that can no longer be answered. Returns how many it dropped. Always safe to call: forgetting only ever turns a result into `unknown`. */
  gc(now: number): Promise<number>;
}

interface Entry {
  readonly challengeBytes: Uint8Array;
  readonly expiresAt: number;
  used: boolean;
  attempts: number;
}

export interface InMemoryNonceStoreOptions {
  /**
   * The most unexpired challenges held at once. Issuing is unauthenticated, so this is the bound on
   * what an anonymous caller can make the process hold. Default 10 000 (a few MB).
   */
  maxEntries?: number;
  /** How long past `expiresAt` an entry is kept, so a late replay reads `used` and not `unknown`. Default 60. */
  retainSeconds?: number;
  /**
   * How many responses one challenge may receive, right or wrong, before it stops being looked at.
   * A person gets it right in one. Default 3, at most 10.
   */
  maxAttempts?: number;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, Entry>();

  private readonly maxEntries: number;

  private readonly retainSeconds: number;

  private readonly maxAttempts: number;

  constructor(options: InMemoryNonceStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.retainSeconds = options.retainSeconds ?? 60;
    this.maxAttempts = options.maxAttempts ?? 3;

    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new RangeError('maxAttempts must be an integer from 1 to 10');
    }
  }

  /** Entries currently held, for tests and metrics. */
  get size(): number {
    return this.entries.size;
  }

  async recordIssued(
    nonce: Uint8Array,
    challengeBytes: Uint8Array,
    expiresAt: number,
    now: number,
  ): Promise<void> {
    const key = keyOf(nonce);
    if (this.entries.has(key)) {
      throw new Error('identikey: a nonce was issued twice; the random source is broken');
    }

    if (this.entries.size >= this.maxEntries) {
      await this.gc(now);
    }

    if (this.entries.size >= this.maxEntries) {
      throw new IdentiKeyError('store-full', `${this.maxEntries} unexpired challenges are outstanding`);
    }

    this.entries.set(key, {
      challengeBytes: new Uint8Array(challengeBytes),
      expiresAt,
      used: false,
      attempts: 0,
    });
  }

  async beginAttempt(nonce: Uint8Array, challengeBytes: Uint8Array): Promise<AttemptOutcome> {
    const entry = this.entries.get(keyOf(nonce));
    if (entry === undefined) {
      return 'unknown';
    }

    if (!bytesEqual(entry.challengeBytes, challengeBytes)) {
      return 'mismatch';
    }

    if (entry.used) {
      return 'used';
    }

    if (entry.attempts >= this.maxAttempts) {
      return 'exhausted';
    }

    // No await between the reads above and this write: in one process that is what makes it atomic.
    entry.attempts += 1;

    return 'proceed';
  }

  async consume(nonce: Uint8Array, challengeBytes: Uint8Array): Promise<ConsumeOutcome> {
    const entry = this.entries.get(keyOf(nonce));
    if (entry === undefined) {
      return 'unknown';
    }

    if (!bytesEqual(entry.challengeBytes, challengeBytes)) {
      return 'mismatch';
    }

    if (entry.used) {
      return 'used';
    }

    // No await between the read above and this write: in one process that is what makes it atomic.
    entry.used = true;

    return 'consumed';
  }

  async gc(now: number): Promise<number> {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt + this.retainSeconds < now) {
        this.entries.delete(key);
        dropped += 1;
      }
    }

    return dropped;
  }
}

const keyOf = (nonce: Uint8Array): string => Buffer.from(nonce).toString('hex');

// ─── issuing ─────────────────────────────────────────────────────────────────

export interface IssuedChallenge {
  readonly challenge: Challenge;
  /** What goes on the wire, and what the claimant signs. */
  readonly bytes: Uint8Array;
}

export interface ChallengeIssuerOptions {
  /** Who this verifier is. A claimant signs it; a verifier refuses a challenge made for anyone else. */
  audience: string;
  /** How long a challenge stays answerable, in seconds. 1 to 3600. */
  ttlSeconds: number;
  /** Test seam. Defaults to the operating system's CSPRNG. */
  randomBytes?: (length: number) => Uint8Array;
}

export class ChallengeIssuer {
  private readonly audience: string;

  private readonly ttlSeconds: number;

  private readonly random: (length: number) => Uint8Array;

  constructor(options: ChallengeIssuerOptions) {
    if (options.audience.length === 0) {
      throw new RangeError('a challenge audience cannot be empty');
    }

    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 3600) {
      throw new RangeError('ttlSeconds must be an integer from 1 to 3600');
    }

    this.audience = options.audience;
    this.ttlSeconds = options.ttlSeconds;
    this.random = options.randomBytes ?? ((length) => randomBytes(length));
  }

  /** Issue a fresh challenge at `now` (Unix seconds) and record it. */
  async issue(store: NonceStore, now: number): Promise<IssuedChallenge> {
    const challenge: Challenge = {
      version: PROTOCOL_VERSION,
      audience: this.audience,
      // The protocol's minimum is the right size: 128 random bits do not collide in practice.
      nonce: new Uint8Array(this.random(MIN_NONCE_LENGTH)),
      issuedAt: now,
      expiresAt: now + this.ttlSeconds,
    };
    const bytes = encodeChallenge(challenge);
    await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, now);

    return { challenge, bytes };
  }
}
