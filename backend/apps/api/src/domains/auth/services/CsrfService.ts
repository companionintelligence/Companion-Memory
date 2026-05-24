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
  validateToken(cookieValue: string | undefined, headerValue: string | undefined): void {
    if (!cookieValue || !headerValue) {
      throw new ForbiddenException('Missing CSRF token');
    }

    if (cookieValue.length !== headerValue.length) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    if (!timingSafeEqual(Buffer.from(cookieValue), Buffer.from(headerValue))) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    if (!this.verifyToken(cookieValue)) {
      throw new ForbiddenException('Invalid CSRF token');
    }
  }

  /**
   * Verify the HMAC signature of a token.
   */
  verifyToken(token: string): boolean {
    const dotIndex = token.indexOf('.');

    if (dotIndex === -1) {
      return false;
    }

    const random = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    const expectedSignature = this.sign(random);

    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  private sign(value: string): string {
    return createHmac('sha256', CSRF_SECRET).update(value).digest('hex');
  }
}
