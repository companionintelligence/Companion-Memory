import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { Injectable } from '@nestjs/common';

/**
 * Issues and redeems short-lived, single-use one-time codes that carry an OIDC
 * sign-in result back into the NATIVE app via a custom-scheme deep link.
 *
 * Why a one-time code (and not the JWT itself) in the deep-link URL:
 *   - Deep-link URLs are visible to the OS, can land in logs, and on Android another
 *     app can register the same `companion` scheme and be handed the URL. Putting a
 *     long-lived credential (JWT / API key) there would leak it.
 *   - Instead the URL carries a high-entropy, single-use code valid for ~2 minutes.
 *
 * The code alone is not enough to redeem it. The app that started the sign-in sent the
 * S256 challenge of a PKCE verifier it kept to itself (RFC 7636, between the app and this
 * appliance), and the code is stored with that challenge. `/oidc/native/exchange` is
 * unauthenticated, so redeeming requires the matching verifier: an app or a person who
 * only saw the URL holds a code they cannot use.
 *
 * Security properties:
 *   - The code is 32 bytes of CSPRNG randomness (base64url), not derivable.
 *   - The userId binding lives ONLY server-side in this store — the URL reveals nothing.
 *   - Redemption needs the verifier whose SHA-256 is the stored challenge.
 *   - Any redemption attempt deletes the entry, right verifier or not, so a code works
 *     at most once and cannot be guessed at.
 *   - Entries expire after `TTL_MS`; expired entries are swept lazily on each issue.
 *
 * Storage is in-memory and therefore per-process. That is correct for the
 * single-instance appliance deployment. If CI-Server is ever horizontally scaled, this
 * must move to a shared store (e.g. the Postgres instance or Redis) so the exchange can
 * hit any instance — see the note in OidcController.
 */
@Injectable()
export class OidcNativeCodeService {
  private static readonly TTL_MS = 2 * 60 * 1000;

  private readonly store = new Map<string, { userId: string; challenge: string; expiresAt: number }>();

  /**
   * Mint a single-use code bound to `userId` and to the app's PKCE `challenge`
   * (base64url SHA-256 of its verifier), valid for ~2 minutes.
   */
  issue(userId: string, challenge: string): string {
    this.sweepExpired();

    const code = randomBytes(32).toString('base64url');

    this.store.set(code, { userId, challenge, expiresAt: Date.now() + OidcNativeCodeService.TTL_MS });

    return code;
  }

  /**
   * Redeem a code: returns the bound userId and invalidates the code, or null if the
   * code is unknown, already used, expired, or `verifier` is not the one the app that
   * started the sign-in holds. Always single use.
   */
  redeem(code: string, verifier: string): string | null {
    if (!code) {
      return null;
    }

    const entry = this.store.get(code);

    // Delete first so even an expired/invalid attempt cannot be retried.
    this.store.delete(code);

    if (!entry || entry.expiresAt < Date.now() || !verifier) {
      return null;
    }

    const presented = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
    const expected = Buffer.from(entry.challenge);

    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return null;
    }

    return entry.userId;
  }

  private sweepExpired(): void {
    const now = Date.now();

    for (const [code, entry] of this.store) {
      if (entry.expiresAt < now) {
        this.store.delete(code);
      }
    }
  }
}
