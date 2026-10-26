import { GlobalUID } from '@ci/common';
import { describe, expect, it } from 'vitest';

import { hubNamesSomeoneElse } from './RedirectKnownUser';

const user = { id: 'user-a', email: 'old@example.com' };

describe('hubNamesSomeoneElse', () => {
  it('names nobody without a verified Hub identity', () => {
    expect(hubNamesSomeoneElse(user, { username: null, accountId: null })).toBe(false);
  });

  it('keeps a linked person who renamed themselves: the account matches, the address no longer does', () => {
    expect(hubNamesSomeoneElse(user, { username: 'new@example.com', accountId: 'user-a' })).toBe(false);
  });

  it('names someone else when the Hub person signs in as another account, even at the same address', () => {
    expect(hubNamesSomeoneElse(user, { username: 'old@example.com', accountId: 'user-b' })).toBe(true);
  });

  it("matches the Hub's bare account id against the global id GraphQL gives the signed-in user", () => {
    // `me.id` is base64 of `user:<uuid>`; the Hub names the account by the uuid alone. Compared
    // as they came, every Hub person looked like someone else and Open from the Hub showed the splash.
    const accountId = '01a1769a-9c03-73ca-9693-dd66622934b0';
    const signedIn = { id: GlobalUID.encode('user', accountId), email: 'old@example.com' };

    expect(hubNamesSomeoneElse(signedIn, { username: 'old@example.com', accountId })).toBe(false);
    expect(hubNamesSomeoneElse(signedIn, { username: 'old@example.com', accountId: '01a1769a-0000-7000-8000-000000000000' })).toBe(true);
  });

  it('compares addresses, ignoring case, when the Hub sends no stable id', () => {
    expect(hubNamesSomeoneElse(user, { username: 'Old@Example.com', accountId: null })).toBe(false);
    expect(hubNamesSomeoneElse(user, { username: 'other@example.com', accountId: null })).toBe(true);
  });
});
