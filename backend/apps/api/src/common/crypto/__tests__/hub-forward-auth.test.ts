import {
  DEFAULT_FORWARD_AUTH_MAX_SKEW_MS,
  buildForwardAuthMessage,
  signForwardAuthUser,
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
    expect(result).toEqual({ ok: true, username: 'alice' });
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
