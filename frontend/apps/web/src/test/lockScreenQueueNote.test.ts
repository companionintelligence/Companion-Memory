import { lockScreenQueueNote } from '@ci/common';
import { describe, expect, it } from 'vitest';

describe('lockScreenQueueNote', () => {
  it('is empty when nothing waits', () => {
    expect(lockScreenQueueNote({})).toBe('');
    expect(lockScreenQueueNote({ locations: 0, notes: 0, savedSearches: 0, other: 0 })).toBe('');
  });

  it('names one kind with its number', () => {
    expect(lockScreenQueueNote({ locations: 1 })).toBe('1 location waiting to sync');
    expect(lockScreenQueueNote({ locations: 17 })).toBe('17 locations waiting to sync');
    expect(lockScreenQueueNote({ savedSearches: 1 })).toBe('1 saved search waiting to sync');
  });

  it('lists several kinds in a fixed order, with "and" before the last, leaving out zeros', () => {
    expect(lockScreenQueueNote({ locations: 17, notes: 1, savedSearches: 2 })).toBe(
      '17 locations, 1 note and 2 saved searches waiting to sync',
    );
    expect(lockScreenQueueNote({ savedSearches: 2, locations: 3 })).toBe(
      '3 locations and 2 saved searches waiting to sync',
    );
  });

  it('calls an outbox row of an unnamed kind a capture', () => {
    expect(lockScreenQueueNote({ other: 1 })).toBe('1 capture waiting to sync');
    expect(lockScreenQueueNote({ notes: 2, other: 3 })).toBe('2 notes and 3 captures waiting to sync');
  });

  it('never shows a negative or fractional count', () => {
    expect(lockScreenQueueNote({ locations: -2, notes: 1.7 })).toBe('1 note waiting to sync');
  });
});
