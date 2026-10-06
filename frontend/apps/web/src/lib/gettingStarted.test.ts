import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissGettingStarted,
  GETTING_STARTED_MAX_AGE_MS,
  isGettingStartedActive,
  markGettingStartedActive,
} from './gettingStarted';

beforeEach(() => {
  window.localStorage.clear();
});

describe('getting-started marker', () => {
  it('is off for a user who never finished onboarding here', () => {
    expect(isGettingStartedActive('u1')).toBe(false);
  });

  it('is off without a user id', () => {
    expect(isGettingStartedActive(null)).toBe(false);
    expect(isGettingStartedActive(undefined)).toBe(false);
  });

  it('is on after onboarding marks it, and only for that user', () => {
    markGettingStartedActive('u1');

    expect(isGettingStartedActive('u1')).toBe(true);
    expect(isGettingStartedActive('u2')).toBe(false);
  });

  it('turns off when dismissed', () => {
    markGettingStartedActive('u1');
    dismissGettingStarted('u1');

    expect(isGettingStartedActive('u1')).toBe(false);
  });

  it('lapses on its own — an ignored banner is not permanent chrome', () => {
    const start = new Date('2026-09-29T12:00:00Z');
    markGettingStartedActive('u1', start);

    expect(isGettingStartedActive('u1', new Date(start.getTime() + GETTING_STARTED_MAX_AGE_MS - 1))).toBe(
      true,
    );
    expect(isGettingStartedActive('u1', new Date(start.getTime() + GETTING_STARTED_MAX_AGE_MS + 1))).toBe(
      false,
    );
  });

  it('treats corrupt storage as never marked', () => {
    window.localStorage.setItem('ci:getting-started:u1', '{not json');
    expect(isGettingStartedActive('u1')).toBe(false);

    window.localStorage.setItem('ci:getting-started:u1', JSON.stringify({ state: 'active' }));
    expect(isGettingStartedActive('u1')).toBe(false);
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => markGettingStartedActive('u1')).not.toThrow();
    expect(isGettingStartedActive('u1')).toBe(false);

    spy.mockRestore();
    set.mockRestore();
  });
});
