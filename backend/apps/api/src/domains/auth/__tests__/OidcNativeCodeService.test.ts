import { createHash } from 'crypto';

import { OidcNativeCodeService } from '../services/OidcNativeCodeService';

/** A verifier the app keeps, and the S256 challenge it sends when it starts the sign-in. */
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const OTHER_VERIFIER = 'w'.repeat(43);

describe('OidcNativeCodeService', () => {
  let service: OidcNativeCodeService;

  beforeEach(() => {
    service = new OidcNativeCodeService();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues a high-entropy, opaque code (no userId leaked into the code)', () => {
    const code = service.issue('user-123', CHALLENGE);

    expect(typeof code).toBe('string');
    // 32 random bytes base64url-encoded → 43 chars.
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(code).not.toContain('user-123');
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('redeems a valid code exactly once (single use / replay-safe)', () => {
    const code = service.issue('user-123', CHALLENGE);

    expect(service.redeem(code, VERIFIER)).toBe('user-123');
    // Second attempt must fail — the code is consumed.
    expect(service.redeem(code, VERIFIER)).toBeNull();
  });

  it('returns null for an unknown or empty code', () => {
    expect(service.redeem('does-not-exist', VERIFIER)).toBeNull();
    expect(service.redeem('', VERIFIER)).toBeNull();
  });

  it('refuses a code presented without the verifier the app started with', () => {
    // Whoever only saw the deep link — another app claiming the scheme, or someone the link was
    // sent to — holds the code but not the verifier.
    const code = service.issue('user-123', CHALLENGE);

    expect(service.redeem(code, OTHER_VERIFIER)).toBeNull();
  });

  it('refuses an empty verifier', () => {
    const code = service.issue('user-123', CHALLENGE);

    expect(service.redeem(code, '')).toBeNull();
  });

  it('spends the code on a wrong verifier, so the right one cannot follow it', () => {
    const code = service.issue('user-123', CHALLENGE);

    expect(service.redeem(code, OTHER_VERIFIER)).toBeNull();
    expect(service.redeem(code, VERIFIER)).toBeNull();
  });

  it('refuses the challenge itself in place of the verifier', () => {
    const code = service.issue('user-123', CHALLENGE);

    expect(service.redeem(code, CHALLENGE)).toBeNull();
  });

  it('issues distinct codes for repeated calls', () => {
    const a = service.issue('user-123', CHALLENGE);
    const b = service.issue('user-123', CHALLENGE);

    expect(a).not.toBe(b);
    expect(service.redeem(a, VERIFIER)).toBe('user-123');
    expect(service.redeem(b, VERIFIER)).toBe('user-123');
  });

  it('keeps codes bound to the right user', () => {
    const codeA = service.issue('user-A', CHALLENGE);
    const codeB = service.issue('user-B', CHALLENGE);

    expect(service.redeem(codeB, VERIFIER)).toBe('user-B');
    expect(service.redeem(codeA, VERIFIER)).toBe('user-A');
  });

  it('rejects a code once it has expired (~2 min TTL)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const code = service.issue('user-123', CHALLENGE);

    // Advance past the 2-minute TTL.
    jest.setSystemTime(new Date('2026-01-01T00:02:01Z'));

    expect(service.redeem(code, VERIFIER)).toBeNull();
  });

  it('still accepts a code just before it expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const code = service.issue('user-123', CHALLENGE);

    jest.setSystemTime(new Date('2026-01-01T00:01:59Z'));

    expect(service.redeem(code, VERIFIER)).toBe('user-123');
  });
});
