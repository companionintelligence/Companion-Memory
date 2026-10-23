import { describe, expect, it } from 'vitest';

import { answersFromDevice } from './deviceFallback';

describe('answersFromDevice', () => {
  it('answers from the phone once the probe says the appliance is unreachable', () => {
    expect(answersFromDevice({ mode: 'cached', isResolved: true, error: undefined, hasDatabase: true })).toBe(
      true,
    );
    expect(answersFromDevice({ mode: 'local', isResolved: true, error: undefined, hasDatabase: true })).toBe(
      true,
    );
    expect(
      answersFromDevice({ mode: 'connected', isResolved: true, error: undefined, hasDatabase: true }),
    ).toBe(false);
  });

  it('waits for the first probe rather than flashing the local list on every load', () => {
    expect(answersFromDevice({ mode: 'fresh', isResolved: false, error: undefined, hasDatabase: true })).toBe(
      false,
    );
  });

  it('a request that failed on the network also falls back; a GraphQL error does not', () => {
    expect(
      answersFromDevice({
        mode: 'connected',
        isResolved: true,
        error: { networkError: new TypeError('Failed to fetch') },
        hasDatabase: true,
      }),
    ).toBe(true);
    expect(
      answersFromDevice({
        mode: 'connected',
        isResolved: true,
        error: { graphQLErrors: [{ message: 'nope' }], networkError: null },
        hasDatabase: true,
      }),
    ).toBe(false);
  });

  it('never without a synced replica (a desktop browser)', () => {
    expect(
      answersFromDevice({ mode: 'cached', isResolved: true, error: undefined, hasDatabase: false }),
    ).toBe(false);
  });
});
