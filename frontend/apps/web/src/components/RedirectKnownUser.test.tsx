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

  it('compares addresses, ignoring case, when the Hub sends no stable id', () => {
    expect(hubNamesSomeoneElse(user, { username: 'Old@Example.com', accountId: null })).toBe(false);
    expect(hubNamesSomeoneElse(user, { username: 'other@example.com', accountId: null })).toBe(true);
  });
});
