import { COMPANION_LINK_TTL_MS, signCompanionLink, verifyCompanionLink } from '../companionLink';

const SECRET = 'test-auth-token-secret';
const NOW = Date.UTC(2026, 10, 27, 12);

describe('the signed "connect a Companion account" cookie', () => {
  const value = signCompanionLink(SECRET, 'user-1', 'session-token-a', NOW);

  it('names the account for the session that asked, inside its lifetime', () => {
    expect(verifyCompanionLink(SECRET, value, 'session-token-a', NOW + 1_000)).toBe('user-1');
  });

  it('is refused from another session, so a copied cookie connects nothing', () => {
    expect(verifyCompanionLink(SECRET, value, 'session-token-b', NOW + 1_000)).toBeNull();
    expect(verifyCompanionLink(SECRET, value, undefined, NOW + 1_000)).toBeNull();
  });

  it('is refused once its lifetime is over', () => {
    expect(verifyCompanionLink(SECRET, value, 'session-token-a', NOW + COMPANION_LINK_TTL_MS + 1)).toBeNull();
  });

  it('is refused when its account is changed, or it was signed with another secret', () => {
    const [body, signature] = value.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'someone-else' }),
    ).toString('base64url');

    expect(verifyCompanionLink(SECRET, `${forged}.${signature}`, 'session-token-a', NOW)).toBeNull();
    expect(verifyCompanionLink('another-secret', value, 'session-token-a', NOW)).toBeNull();
  });

  it.each([undefined, '', 'no-dot', 'a.b.c', 42])('is refused when it is not one at all (%p)', (junk) => {
    expect(verifyCompanionLink(SECRET, junk, 'session-token-a', NOW)).toBeNull();
  });
});
