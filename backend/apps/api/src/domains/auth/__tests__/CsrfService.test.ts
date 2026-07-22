import { ForbiddenException } from '@nestjs/common';

import { CsrfService } from '../services/CsrfService';

/**
 * Unit tests for the signed double-submit CSRF token service, with real crypto
 * (the HMAC secret comes from the test config). The `ensureToken` matrix is the
 * contract the stable-token design rests on: every render/refresh site reuses a
 * valid cookie and only mints when the cookie is absent or invalid, so a
 * background session refresh can never invalidate a token already embedded in
 * an open page (CI-Server#1740).
 */
describe('CsrfService', () => {
  const service = new CsrfService();

  describe('generateToken / verifyToken', () => {
    it('round-trips: generated tokens verify', () => {
      const token = service.generateToken();

      expect(token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
      expect(service.verifyToken(token)).toBe(true);
    });

    it('generates unique tokens', () => {
      expect(service.generateToken()).not.toBe(service.generateToken());
    });

    it('rejects a tampered random part', () => {
      const token = service.generateToken();
      const [random, signature] = token.split('.');
      const flipped = (random[0] === 'a' ? 'b' : 'a') + random.slice(1);

      expect(service.verifyToken(`${flipped}.${signature}`)).toBe(false);
    });

    it('rejects a tampered signature', () => {
      const token = service.generateToken();
      const [random, signature] = token.split('.');
      const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);

      expect(service.verifyToken(`${random}.${flipped}`)).toBe(false);
    });

    it('rejects malformed tokens', () => {
      expect(service.verifyToken('')).toBe(false);
      expect(service.verifyToken('no-dot')).toBe(false);
      expect(service.verifyToken('short.sig')).toBe(false);
    });
  });

  describe('ensureToken', () => {
    it('reuses a valid existing token unchanged', () => {
      const existing = service.generateToken();

      expect(service.ensureToken(existing)).toBe(existing);
    });

    it('mints when the cookie is absent', () => {
      const token = service.ensureToken(undefined);

      expect(service.verifyToken(token)).toBe(true);
    });

    it('mints when the cookie is empty', () => {
      const token = service.ensureToken('');

      expect(service.verifyToken(token)).toBe(true);
      expect(token).not.toBe('');
    });

    it('mints when cookie-parser produced a non-string (a `j:` JSON cookie)', () => {
      // cookie-parser runs JSONCookies over every cookie, so `csrfToken=j:{}`
      // arrives as a parsed object. Calling .indexOf on it used to TypeError
      // into a 500 on GET /authenticate/csrf, GET /api/connect and
      // confirm-account — and with the cookie's 7-day maxAge the browser stayed
      // wedged, with the SPA's own recovery endpoint among the casualties.
      for (const poisoned of [{}, 5, true, [], null] as unknown[]) {
        const token = service.ensureToken(poisoned);

        expect(typeof token).toBe('string');
        expect(service.verifyToken(token)).toBe(true);
      }
    });

    it('mints a fresh token when the cookie is invalid (e.g. signed with a rotated secret)', () => {
      const invalid = 'deadbeef.deadbeef';
      const token = service.ensureToken(invalid);

      expect(token).not.toBe(invalid);
      expect(service.verifyToken(token)).toBe(true);
    });
  });

  describe('validateToken (double-submit equality is load-bearing)', () => {
    it('accepts a matching valid pair', () => {
      const token = service.generateToken();

      expect(() => service.validateToken(token, token)).not.toThrow();
    });

    it('rejects when either side is missing', () => {
      const token = service.generateToken();

      expect(() => service.validateToken(undefined, token)).toThrow(ForbiddenException);
      expect(() => service.validateToken(token, undefined)).toThrow(ForbiddenException);
    });

    it('labels a genuinely absent value "Missing" and a malformed one "Invalid"', () => {
      // Both are 403s, but the message must be accurate: an absent cookie/header
      // (undefined/null/empty) is "Missing", while a present-but-non-string value
      // (a `j:` JSON cookie parsed to an object) is "Invalid". The presence check
      // must run before the type check or "Missing" becomes unreachable.
      const token = service.generateToken();

      for (const absent of [undefined, null, ''] as unknown[]) {
        expect(() => service.validateToken(absent, token)).toThrow('Missing CSRF token');
        expect(() => service.validateToken(token, absent)).toThrow('Missing CSRF token');
      }

      for (const malformed of [{}, 5, true, []] as unknown[]) {
        expect(() => service.validateToken(malformed, token)).toThrow('Invalid CSRF token');
        expect(() => service.validateToken(token, malformed)).toThrow('Invalid CSRF token');
      }
    });

    it('rejects two DIFFERENT validly-signed tokens (equality, not just signature)', () => {
      // Tokens are not session-bound, so an attacker could harvest a valid
      // token from their own browser; only the cookie↔field equality ties the
      // request to this browser's cookie jar. Must never regress.
      const cookie = service.generateToken();
      const field = service.generateToken();

      expect(() => service.validateToken(cookie, field)).toThrow(ForbiddenException);
    });

    it('rejects an unsigned but equal pair', () => {
      expect(() => service.validateToken('forged.forged', 'forged.forged')).toThrow(ForbiddenException);
    });

    it('rejects a non-string value as Forbidden rather than throwing TypeError', () => {
      // Same JSON-cookie hazard on the validating side: Buffer.from({}) throws a
      // TypeError, which the callers classify as non-CSRF and re-throw as a 500,
      // skipping the self-heal that would have replaced the poisoned cookie.
      const token = service.generateToken();

      for (const poisoned of [{}, 5, true, [], null] as unknown[]) {
        expect(() => service.validateToken(poisoned, token)).toThrow(ForbiddenException);
        expect(() => service.validateToken(token, poisoned)).toThrow(ForbiddenException);
      }
    });

    it('rejects a multi-byte pair as Forbidden rather than throwing RangeError', () => {
      // 'é' is one JS character but two UTF-8 bytes, so a string-length guard
      // treats these as equal-length while timingSafeEqual sees 2 bytes vs 1 and
      // raises RangeError — which escapes the callers' CSRF handling as a 500
      // and skips the self-heal redirect. Byte-length comparison keeps it a 403.
      expect(() => service.validateToken('é', 'a')).toThrow(ForbiddenException);
      expect(() => service.validateToken('a', 'é')).toThrow(ForbiddenException);
    });

    it('rejects a token whose signature half is multi-byte', () => {
      // Same hazard inside verifyToken: the signature comes from the cookie, so
      // it can be multi-byte while matching the expected hex signature's JS
      // length. Must return false, not throw.
      const random = 'a'.repeat(64);
      const multiByteSignature = 'é'.repeat(64);

      expect(service.verifyToken(`${random}.${multiByteSignature}`)).toBe(false);
      expect(() =>
        service.validateToken(`${random}.${multiByteSignature}`, `${random}.${multiByteSignature}`),
      ).toThrow(ForbiddenException);
    });
  });
});
