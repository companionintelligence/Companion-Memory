import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  DEFAULT_FORWARD_AUTH_MAX_SKEW_MS,
  FORWARD_AUTH_ASSERTION_HEADER,
  type ForwardAuthHeaders,
  buildForwardAuthAssertionMessage,
  buildForwardAuthMessage,
  buildForwardAuthUserIdMessage,
  formatForwardAuthAssertion,
  forwardAuthPolicy,
  isHubIssuer,
  readForwardAuthHeaders,
  signForwardAuthAssertion,
  signForwardAuthUser,
  signForwardAuthUserId,
  verifyForwardAuthHeaders,
  verifyHubForwardAuth,
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

describe('default replay window', () => {
  it('is 30 seconds', () => {
    expect(DEFAULT_FORWARD_AUTH_MAX_SKEW_MS).toBe(30_000);
  });

  it('ships as 30 seconds, with audience binding following the Hub', () => {
    // Read rather than import: the api tsconfig has no resolveJsonModule (see PortalTokenService.test.ts).
    const raw = readFileSync(resolvePath(__dirname, '../../../../config/default.json'), 'utf8');
    const { hubForwardAuth } = (JSON.parse(raw) as { auth: { hubForwardAuth: Record<string, unknown> } })
      .auth;

    expect(hubForwardAuth).toMatchObject({ maxSkewMs: 30_000, requireAudience: 'auto' });
  });

  it('accepts an unbound header set 30 s old and refuses one a millisecond older', () => {
    const headers = headersFor('alice', NOW);

    expect(verifyForwardAuthHeaders(SECRET, headers, { now: NOW + 30_000 }).ok).toBe(true);
    expect(verifyForwardAuthHeaders(SECRET, headers, { now: NOW + 30_001 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

const IDENTITY_SECRET = 'memory-own-secret';
const AUDIENCE = 'ci-memory:ci-marketplace';
const NONCE = 'nB7cS0fTq3kz1XyH9wA2eQ';
const OTHER_NONCE = 'Zr4mK8pL2vJ6sD0gU1tY5w';

/** What a Hub that gave Memory its own key sends: today's headers plus the bound assertion. */
function boundHeadersFor(
  username: string,
  timestampMs: number,
  {
    audience = AUDIENCE,
    nonce = NONCE,
    secret = IDENTITY_SECRET,
    stable = true,
  }: { audience?: string; nonce?: string; secret?: string; stable?: boolean } = {},
): ForwardAuthHeaders {
  const issuer = stable ? ISSUER : null;
  const userId = stable ? USER_ID : null;
  const signature = signForwardAuthAssertion(secret, audience, nonce, timestampMs, username, issuer, userId);

  return {
    ...(stable ? stableHeadersFor(username, timestampMs) : headersFor(username, timestampMs)),
    assertion: formatForwardAuthAssertion(nonce, signature),
  };
}

const BOUND = forwardAuthPolicy({
  secret: SECRET,
  identitySecret: IDENTITY_SECRET,
  audience: AUDIENCE,
  requireAudience: 'auto',
  maxSkewMs: DEFAULT_FORWARD_AUTH_MAX_SKEW_MS,
});
const LEGACY = forwardAuthPolicy({ secret: SECRET, maxSkewMs: DEFAULT_FORWARD_AUTH_MAX_SKEW_MS });

describe('forwardAuthPolicy', () => {
  it('binds to this app once the Hub provides both its own key and its URN, and then requires the assertion', () => {
    expect(BOUND).toEqual({
      sharedSecret: SECRET,
      bound: { secret: IDENTITY_SECRET, audience: AUDIENCE },
      acceptUnbound: false,
      maxSkewMs: 30_000,
    });
  });

  it('accepts the unbound format from a Hub that provided neither', () => {
    expect(LEGACY).toMatchObject({ bound: null, acceptUnbound: true });
  });

  it.each([
    ['a key with no URN', { identitySecret: IDENTITY_SECRET, audience: '' }],
    ['a URN with no key', { identitySecret: '  ', audience: AUDIENCE }],
  ])('is not bound with %s', (_label, partial) => {
    expect(forwardAuthPolicy({ secret: SECRET, maxSkewMs: 1, ...partial })).toMatchObject({
      bound: null,
      acceptUnbound: true,
    });
  });

  it('refuses the unbound format from an older Hub when told to', () => {
    expect(forwardAuthPolicy({ secret: SECRET, requireAudience: 'true', maxSkewMs: 1 })).toMatchObject({
      bound: null,
      acceptUnbound: false,
    });
  });

  it('accepts the unbound format beside the bound one when told to', () => {
    expect(
      forwardAuthPolicy({
        secret: SECRET,
        identitySecret: IDENTITY_SECRET,
        audience: AUDIENCE,
        requireAudience: 'false',
        maxSkewMs: 1,
      }),
    ).toMatchObject({ bound: { audience: AUDIENCE }, acceptUnbound: true });
  });
});

describe('bound assertion', () => {
  it('is signature-compatible with the canonical message the Hub signs', () => {
    // Mirror of CI-Hub packages/backend/src/modules/auth/utils/forward-auth-signing.ts
    expect(buildForwardAuthAssertionMessage(AUDIENCE, NONCE, NOW, 'alice', ISSUER, USER_ID)).toBe(
      `ci-hub-forward-auth/2\n${AUDIENCE}\n${NONCE}\n${NOW}\nalice\n${ISSUER}\n${USER_ID}`,
    );
    expect(buildForwardAuthAssertionMessage(AUDIENCE, NONCE, NOW, 'alice', null, null)).toBe(
      `ci-hub-forward-auth/2\n${AUDIENCE}\n${NONCE}\n${NOW}\nalice\n\n`,
    );
    expect(formatForwardAuthAssertion(NONCE, 'ab12')).toBe(`2.${NONCE}.ab12`);
    // The same vector is pinned in CI-Hub's forward-auth-signing.test.ts.
    expect(
      signForwardAuthAssertion(IDENTITY_SECRET, AUDIENCE, NONCE, NOW, 'alice@example.com', ISSUER, USER_ID),
    ).toBe('b4a88bb12dfc65b4e912d10e6dddfb9d29b866328475403dd27a12fa2d26d806');
  });

  it('verifies an assertion for this app, with the stable id it carries', () => {
    expect(verifyHubForwardAuth(BOUND, boundHeadersFor('alice@example.com', NOW), { now: NOW })).toEqual({
      ok: true,
      username: 'alice@example.com',
      stableId: { issuer: ISSUER, subject: USER_ID },
      bound: true,
      replayKey: NONCE,
      expiresAt: NOW + 30_000,
    });
  });

  it('verifies an assertion with no stable id', () => {
    expect(
      verifyHubForwardAuth(BOUND, boundHeadersFor('alice', NOW, { stable: false }), { now: NOW }),
    ).toMatchObject({
      ok: true,
      stableId: null,
      bound: true,
    });
  });

  it('refuses an assertion the Hub signed for another app', () => {
    const forOtherApp = boundHeadersFor('alice', NOW, { audience: 'importer:ci-marketplace' });

    expect(verifyHubForwardAuth(BOUND, forOtherApp, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses an assertion signed with the Hub-wide secret instead of this app key', () => {
    const shared = boundHeadersFor('alice', NOW, { secret: SECRET });

    expect(verifyHubForwardAuth(BOUND, shared, { now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a stale assertion', () => {
    const headers = boundHeadersFor('alice', NOW);

    expect(verifyHubForwardAuth(BOUND, headers, { now: NOW + 30_000 }).ok).toBe(true);
    expect(verifyHubForwardAuth(BOUND, headers, { now: NOW + 30_001 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyHubForwardAuth(BOUND, headers, { now: NOW - 30_001 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it.each<[string, Partial<ForwardAuthHeaders>]>([
    ['another username', { user: 'admin@example.com' }],
    ['another timestamp', { timestamp: String(NOW + 1) }],
    ['another stable id', { userId: '0192a3b4-c5d6-7e8f-9a0b-000000000000' }],
    ['the stable id removed', { issuer: null, userId: null, userIdSignature: null }],
  ])('refuses the assertion carried onto %s', (_label, change) => {
    const tampered = { ...boundHeadersFor('alice', NOW), ...change };

    expect(verifyHubForwardAuth(BOUND, tampered, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses the assertion with its nonce swapped', () => {
    const real = boundHeadersFor('alice', NOW);
    const swapped = { ...real, assertion: real.assertion!.replace(NONCE, OTHER_NONCE) };

    expect(verifyHubForwardAuth(BOUND, swapped, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([
    ['another version', (a: string) => a.replace(/^2\./, '3.')],
    ['no nonce', (a: string) => a.replace(`.${NONCE}.`, '..')],
    ['a nonce with a separator in it', (a: string) => a.replace(NONCE, `${NONCE}.x`)],
    ['an upper-case signature', (a: string) => a.toUpperCase().replace(/^2\./, '2.')],
    ['a short signature', (a: string) => a.slice(0, -2)],
  ])('refuses a malformed assertion: %s', (_label, mangle) => {
    const real = boundHeadersFor('alice', NOW);

    expect(
      verifyHubForwardAuth(BOUND, { ...real, assertion: mangle(real.assertion!) }, { now: NOW }),
    ).toEqual({
      ok: false,
      reason: 'bad_assertion',
    });
  });

  it('refuses a half-present stable id', () => {
    const headers = { ...boundHeadersFor('alice', NOW), userId: null };

    expect(verifyHubForwardAuth(BOUND, headers, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_stable_id',
    });
  });
});

describe('old-format (unbound) header sets', () => {
  it('are refused once the Hub has given this app its own key, even when they verify', () => {
    const unbound = stableHeadersFor('alice', NOW);

    expect(verifyForwardAuthHeaders(SECRET, unbound, { now: NOW }).ok).toBe(true);
    expect(verifyHubForwardAuth(BOUND, unbound, { now: NOW })).toEqual({ ok: false, reason: 'unbound' });
  });

  it('do not rescue a wrong assertion: the request is judged by the assertion alone', () => {
    const wrongApp = boundHeadersFor('alice', NOW, { audience: 'importer:ci-marketplace' });
    const lenient = { ...BOUND, acceptUnbound: true };

    expect(verifyHubForwardAuth(lenient, wrongApp, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('are accepted from a Hub that has not provided a key, with nothing to spend them by', () => {
    expect(verifyHubForwardAuth(LEGACY, headersFor('alice', NOW), { now: NOW })).toEqual({
      ok: true,
      username: 'alice',
      stableId: null,
      bound: false,
      replayKey: null,
      expiresAt: NOW + 30_000,
    });
  });

  it('decide alone while this app has no key to check an assertion with', () => {
    // A Hub that already signs assertions, before this app's env carries the key for them.
    expect(verifyHubForwardAuth(LEGACY, boundHeadersFor('alice', NOW), { now: NOW })).toMatchObject({
      ok: true,
      bound: false,
    });
  });

  it('still need a valid signature and a fresh timestamp', () => {
    expect(verifyHubForwardAuth(LEGACY, headersFor('alice', NOW, 'attacker-secret'), { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyHubForwardAuth(LEGACY, headersFor('alice', NOW), { now: NOW + 30_001 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('are refused from an older Hub when told to', () => {
    const strict = forwardAuthPolicy({ secret: SECRET, requireAudience: 'true', maxSkewMs: 30_000 });

    expect(verifyHubForwardAuth(strict, headersFor('alice', NOW), { now: NOW })).toEqual({
      ok: false,
      reason: 'unbound',
    });
  });

  it('are accepted beside the bound format when told to', () => {
    const lenient = forwardAuthPolicy({
      secret: SECRET,
      identitySecret: IDENTITY_SECRET,
      audience: AUDIENCE,
      requireAudience: 'false',
      maxSkewMs: 30_000,
    });

    expect(verifyHubForwardAuth(lenient, headersFor('alice', NOW), { now: NOW })).toMatchObject({
      ok: true,
      bound: false,
    });
  });
});

describe('readForwardAuthHeaders', () => {
  it('reads the first value of each header, the assertion included', () => {
    expect(
      readForwardAuthHeaders({
        'x-ci-hub-user': ['alice', 'mallory'],
        'x-ci-hub-user-timestamp': String(NOW),
        [FORWARD_AUTH_ASSERTION_HEADER]: `2.${NONCE}.sig`,
      }),
    ).toEqual({
      user: 'alice',
      timestamp: String(NOW),
      signature: null,
      issuer: null,
      userId: null,
      userIdSignature: null,
      assertion: `2.${NONCE}.sig`,
    });
  });
});
