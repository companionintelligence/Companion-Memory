import { InMemoryReplayGuard } from './replayGuard';

describe('InMemoryReplayGuard', () => {
  it('accepts a key once and refuses it again', () => {
    const guard = new InMemoryReplayGuard();

    expect(guard.firstSighting('alice\nm1', 2000, 1000)).toBe(true);
    expect(guard.firstSighting('alice\nm1', 2000, 1000)).toBe(false);
    expect(guard.firstSighting('alice\nm2', 2000, 1000)).toBe(true);
    expect(guard.firstSighting('bob\nm1', 2000, 1000)).toBe(true);
  });

  it('forgets an entry once its window has passed', () => {
    const guard = new InMemoryReplayGuard();

    guard.firstSighting('k', 1500, 1000);

    expect(guard.firstSighting('k', 1500, 1499)).toBe(false);
    expect(guard.firstSighting('k', 3000, 1501)).toBe(true);
  });

  it('stays bounded under flood by dropping the oldest entries, never by refusing new ones', () => {
    const guard = new InMemoryReplayGuard({ maxEntries: 3 });

    for (const key of ['a', 'b', 'c', 'd']) {
      expect(guard.firstSighting(key, 9999, 1000)).toBe(true);
    }

    expect(guard.size()).toBe(3);
    // The oldest ("a") was evicted, so it would be accepted again; the newest are still remembered.
    expect(guard.firstSighting('d', 9999, 1000)).toBe(false);
    expect(guard.firstSighting('a', 9999, 1000)).toBe(true);
  });
});
