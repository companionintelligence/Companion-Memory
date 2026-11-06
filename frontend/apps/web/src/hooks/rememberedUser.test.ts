import { afterEach, describe, expect, it } from 'vitest';

import { graphQLFailure, httpFailure, transportFailure } from '@/test/apolloErrors';

import {
  forgetUser,
  isApplianceOutage,
  isProfileUnanswered,
  recallUser,
  rememberUser,
} from './rememberedUser';

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
    expect(isApplianceOutage(httpFailure(500))).toBe(true);
    expect(isApplianceOutage(httpFailure(504))).toBe(true);
    expect(isApplianceOutage(transportFailure())).toBe(true);
    expect(isApplianceOutage(httpFailure(401))).toBe(false);
    expect(isApplianceOutage(httpFailure(403))).toBe(false);
    expect(isApplianceOutage(graphQLFailure([{ message: 'Unauthenticated' }]))).toBe(false);
    expect(isApplianceOutage(undefined)).toBe(false);
  });

  it('counts a GraphQL error as an unanswered profile only when it is not about the credential', () => {
    expect(isProfileUnanswered(httpFailure(500))).toBe(true);
    expect(isProfileUnanswered(httpFailure(401))).toBe(false);
    expect(
      isProfileUnanswered(
        graphQLFailure([{ message: 'database down', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]),
      ),
    ).toBe(true);
    expect(
      isProfileUnanswered(
        graphQLFailure([{ message: 'not signed in', extensions: { code: 'UNAUTHENTICATED' } }]),
      ),
    ).toBe(false);
  });
});
