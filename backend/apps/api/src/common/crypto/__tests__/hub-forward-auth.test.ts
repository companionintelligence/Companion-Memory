import {
  DEFAULT_FORWARD_AUTH_MAX_SKEW_MS,
  buildForwardAuthMessage,
  buildForwardAuthUserIdMessage,
  isHubIssuer,
  signForwardAuthUser,
  signForwardAuthUserId,
  verifyForwardAuthHeaders,
} from '../hub-forward-auth';

const SECRET = 'shared-secret';
const NOW = 1_700_000_000_000;

function headersFor(username: string, timestampMs: number, secret = SECRET) {
  return {
    user: username,
    timestamp: String(timestampMs),
    signature: signForwardAuthUser(secret, username, timestampMs),
  };
}

describe('hub-forward-auth verifier', () => {
  it('accepts a header signed with the shared secret', () => {
    const result = verifyForwardAuthHeaders(SECRET, headersFor('alice', NOW), { now: NOW });
    expect(result).toEqual({ ok: true, username: 'alice', stableId: null });
  });

  it('is signature-compatible with the canonical message the Hub signs', () => {
    // Mirror of CI-Hub packages/backend/src/modules/auth/utils/forward-auth-signing.ts
    expect(buildForwardAuthMessage('alice', NOW)).toBe(`alice\n${NOW}`);
  });

  it('rejects a FORGED header signed with the wrong secret', () => {
    const forged = headersFor('alice', NOW, 'attacker-secret');
    const result = verifyForwardAuthHeaders(SECRET, forged, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unsigned header (username only, as the old Hub sent)', () => {
    const result = verifyForwardAuthHeaders(
      SECRET,
      { user: 'alice', timestamp: null, signature: null },
      { now: NOW },
    );
    expect(result).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a valid signature replayed for a DIFFERENT username', () => {
    // Attacker takes alice's real signature but swaps the username header to escalate.
    const real = headersFor('alice', NOW);
    const tampered = { ...real, user: 'admin' };
    const result = verifyForwardAuthHeaders(SECRET, tampered, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired signature outside the skew window', () => {
    const old = headersFor('alice', NOW);
    const result = verifyForwardAuthHeaders(SECRET, old, { now: NOW + DEFAULT_FORWARD_AUTH_MAX_SKEW_MS + 1 });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a non-numeric timestamp', () => {
    const bad = { ...headersFor('alice', NOW), timestamp: 'not-a-number' };
    const result = verifyForwardAuthHeaders(SECRET, bad, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects when no shared secret is configured', () => {
    const result = verifyForwardAuthHeaders('', headersFor('alice', NOW), { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

const ISSUER = 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const USER_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

function stableHeadersFor(
  username: string,
  timestampMs: number,
  {
    issuer = ISSUER,
    userId = USER_ID,
    secret = SECRET,
  }: { issuer?: string; userId?: string; secret?: string } = {},
) {
  return {
    ...headersFor(username, timestampMs),
    issuer,
    userId,
    userIdSignature: signForwardAuthUserId(secret, issuer, userId, username, timestampMs),
  };
}

describe('hub-forward-auth stable id', () => {
  it('returns the (issuer, subject) pair when the id signature verifies', () => {
    const result = verifyForwardAuthHeaders(SECRET, stableHeadersFor('alice@example.com', NOW), { now: NOW });

    expect(result).toEqual({
      ok: true,
      username: 'alice@example.com',
      stableId: { issuer: ISSUER, subject: USER_ID },
    });
  });

  it('is signature-compatible with the canonical id message the Hub signs', () => {
    // Mirror of CI-Hub packages/backend/src/modules/auth/utils/forward-auth-signing.ts
    expect(buildForwardAuthUserIdMessage(ISSUER, USER_ID, 'alice', NOW)).toBe(
      `ci-hub-user-id/1\n${ISSUER}\n${USER_ID}\nalice\n${NOW}`,
    );
  });

  it('rejects an id signed with the wrong secret', () => {
    const forged = stableHeadersFor('alice', NOW, { secret: 'attacker-secret' });

    expect(verifyForwardAuthHeaders(SECRET, forged, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a real id signature carried onto another person', () => {
    // The id is bound to the username: bob's triple with alice's id and id signature must not verify.
    const alice = stableHeadersFor('alice', NOW);
    const spliced = {
      ...headersFor('bob', NOW),
      issuer: alice.issuer,
      userId: alice.userId,
      userIdSignature: alice.userIdSignature,
    };

    expect(verifyForwardAuthHeaders(SECRET, spliced, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a swapped id under the original id signature', () => {
    const real = stableHeadersFor('alice', NOW);
    const swapped = { ...real, userId: '0192a3b4-c5d6-7e8f-9a0b-000000000000' };

    expect(verifyForwardAuthHeaders(SECRET, swapped, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a swapped directory under the original id signature', () => {
    const real = stableHeadersFor('alice', NOW);
    const swapped = { ...real, issuer: 'urn:ci-hub:00000000-0000-4000-8000-000000000000' };

    expect(verifyForwardAuthHeaders(SECRET, swapped, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([
    ['an id with no id signature', { userIdSignature: null }],
    ['an id with no issuer', { issuer: null }],
    ['an id signature with no id', { userId: null }],
  ])('rejects the whole identity for %s', (_label, missing) => {
    const partial = { ...stableHeadersFor('alice', NOW), ...missing };

    expect(verifyForwardAuthHeaders(SECRET, partial, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_stable_id',
    });
  });

  it.each<[string, { issuer?: string; userId?: string }]>([
    ['an https issuer (an OIDC issuer is never a Hub directory)', { issuer: 'https://hub.ci.computer' }],
    ['an issuer that is not a directory uuid', { issuer: 'urn:ci-hub:not-a-uuid' }],
    ['an id that is not a uuid', { userId: '42' }],
    ['an upper-case id', { userId: USER_ID.toUpperCase() }],
  ])('rejects %s even when correctly signed', (_label, override) => {
    const issuer = override.issuer ?? ISSUER;
    const userId = override.userId ?? USER_ID;
    const headers = stableHeadersFor('alice', NOW, { issuer, userId });

    expect(verifyForwardAuthHeaders(SECRET, headers, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_stable_id',
    });
  });

  it('still checks the triple first: an expired request with a valid id is expired', () => {
    const result = verifyForwardAuthHeaders(SECRET, stableHeadersFor('alice', NOW), {
      now: NOW + DEFAULT_FORWARD_AUTH_MAX_SKEW_MS + 1,
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('isHubIssuer', () => {
  it('tells a Hub directory from an OIDC issuer', () => {
    expect(isHubIssuer(ISSUER)).toBe(true);
    expect(isHubIssuer('https://hub.ci.computer')).toBe(false);
  });
});
