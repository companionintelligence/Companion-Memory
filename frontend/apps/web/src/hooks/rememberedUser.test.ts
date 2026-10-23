import { afterEach, describe, expect, it } from 'vitest';

import { forgetUser, isApplianceOutage, recallUser, rememberUser } from './rememberedUser';

afterEach(() => forgetUser());

describe('rememberedUser', () => {
  it('answers with the kept profile for the origin that gave it, and for no other', () => {
    rememberUser('https://box.local', { id: 'u1', onboarded: true });

    expect(recallUser('https://box.local')).toEqual({ id: 'u1', onboarded: true });
    expect(recallUser('https://other.local')).toBeNull();
  });

  it('keeps the latest profile and forgets it on request', () => {
    rememberUser('https://box.local', { id: 'u1' });
    rememberUser('https://box.local', { id: 'u2' });
    expect(recallUser('https://box.local')).toEqual({ id: 'u2' });

    forgetUser();
    expect(recallUser('https://box.local')).toBeNull();
  });

  it('survives junk in storage', () => {
    localStorage.setItem('ci.rememberedUser', '{not json');
    expect(recallUser('https://box.local')).toBeNull();
  });

  // The dev proxy's 500 while the API is down, a dead origin and a gateway timeout are
  // outages; the server rejecting the key, or answering with a GraphQL error, is not.
  it('tells an appliance outage from a rejected credential', () => {
    expect(
      isApplianceOutage({
        networkError: Object.assign(new Error('500'), { statusCode: 500 }),
        graphQLErrors: [],
      }),
    ).toBe(true);
    expect(isApplianceOutage({ networkError: new TypeError('Failed to fetch'), graphQLErrors: [] })).toBe(
      true,
    );
    expect(
      isApplianceOutage({
        networkError: Object.assign(new Error('504'), { statusCode: 504 }),
        graphQLErrors: [],
      }),
    ).toBe(true);
    expect(
      isApplianceOutage({
        networkError: Object.assign(new Error('401'), { statusCode: 401 }),
        graphQLErrors: [],
      }),
    ).toBe(false);
    expect(
      isApplianceOutage({
        networkError: Object.assign(new Error('403'), { statusCode: 403 }),
        graphQLErrors: [],
      }),
    ).toBe(false);
    expect(
      isApplianceOutage({ networkError: null, graphQLErrors: [{ message: 'Unauthenticated' }] as never }),
    ).toBe(false);
    expect(isApplianceOutage(undefined)).toBe(false);
  });
});
