import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { ForbiddenException, Injectable } from '@nestjs/common';

import config from '@ci/configuration';

const CSRF_SECRET = config.auth.csrf.secret;

/**
 * Implements the signed double-submit cookie pattern for CSRF protection.
 *
 * Token format: `{randomHex}.{hmacHex}`
 *
 * This service is responsible for generating and verifying CSRF tokens.
 * Cookie management and request validation are controller concerns.
 */
@Injectable()
export class CsrfService {
  /**
   * Generate a signed CSRF token.
   */
  generateToken(): string {
    const random = randomBytes(32).toString('hex');
    const signature = this.sign(random);

    return `${random}.${signature}`;
  }

  /**
   * Validate an CSRF token pair (cookie + header).
   *
   * Verifies that both values are present, match each other using a
   * constant-time comparison, and carry a valid HMAC signature.
   *
   * @throws ForbiddenException if validation fails
   */
  validateToken(cookieValue: unknown, headerValue: unknown): void {
    // Missing takes precedence over malformed so an absent cookie/header reports
    // "Missing" rather than "Invalid": a genuinely absent value arrives as
    // `undefined` (no cookie / no header) or `''` (empty), which the type check
    // below would otherwise mislabel as invalid. A falsy non-string (e.g. `0`,
    // `false`) is not "missing" — it falls through to the type check.
    if (cookieValue == null || cookieValue === '' || headerValue == null || headerValue === '') {
      throw new ForbiddenException('Missing CSRF token');
    }

    // Both arguments are `unknown` rather than `string | undefined` because
    // neither source is actually type-safe: cookie-parser runs JSONCookies over
    // every cookie, so a `csrfToken=j:{…}` value arrives as a parsed object (or
    // number, or boolean), and Express header values can be arrays. Passing
    // either into Buffer.from() throws a TypeError that escapes as a 500 and
    // bypasses the callers' self-heal handling, so reject non-strings here as a
    // plain CSRF failure — which lets the caller re-render and ensureToken
    // replace the poisoned cookie.
    if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') {
      throw new ForbiddenException('Invalid CSRF token');
    }

    // Compare BYTE lengths, not JS string lengths. `timingSafeEqual` rejects
    // buffers of differing byte length with a RangeError, and a multi-byte
    // character makes the two measures disagree ('é' is one JS char but two
    // bytes) — so a string-length guard lets such a pair through and the throw
    // escapes as a 500, bypassing the callers' CSRF self-heal handling.
    const cookieBytes = Buffer.from(cookieValue);
    const headerBytes = Buffer.from(headerValue);

    if (cookieBytes.length !== headerBytes.length) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    if (!timingSafeEqual(cookieBytes, headerBytes)) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    if (!this.verifyToken(cookieValue)) {
      throw new ForbiddenException('Invalid CSRF token');
    }
  }

  /**
   * Return the existing token when it carries a valid signature, otherwise mint
   * a fresh one.
   *
   * A CSRF token identifies a browser, not a request: reusing a valid cookie
   * keeps every open tab and server-rendered page (consent / confirm-account)
   * converged on one stable value, so a background session refresh can never
   * invalidate a form that was rendered earlier. Rotation is reserved for
   * identity boundaries (login, signup, OIDC sign-in) and logout (clear).
   */
  ensureToken(cookieValue: unknown): string {
    return this.verifyToken(cookieValue) ? (cookieValue as string) : this.generateToken();
  }

  /**
   * Verify the HMAC signature of a token.
   */
  verifyToken(token: unknown): boolean {
    // See validateToken: a cookie value is not guaranteed to be a string.
    if (typeof token !== 'string') {
      return false;
    }

    const dotIndex = token.indexOf('.');

    if (dotIndex === -1) {
      return false;
    }

    const random = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    const expectedSignature = this.sign(random);

    // Byte lengths again: the signature half comes from an attacker-settable
    // cookie, so it may contain multi-byte characters that match the expected
    // hex signature's JS length while differing in bytes.
    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expectedSignature);

    if (signatureBytes.length !== expectedBytes.length) {
      return false;
    }

    return timingSafeEqual(signatureBytes, expectedBytes);
  }

  private sign(value: string): string {
    return createHmac('sha256', CSRF_SECRET).update(value).digest('hex');
  }
}
