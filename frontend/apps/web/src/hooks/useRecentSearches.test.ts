import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useRecentSearches } from './useRecentSearches';

const KEY = 'memoryRecentSearches';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('useRecentSearches', () => {
  it('initialises from localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify(['alpha', 'beta']));

    const { result } = renderHook(() => useRecentSearches());

    expect(result.current[0]).toEqual(['alpha', 'beta']);
  });

  it('returns an empty list when storage is empty or invalid', () => {
    localStorage.setItem(KEY, 'not json');

    const { result } = renderHook(() => useRecentSearches());

    expect(result.current[0]).toEqual([]);
  });

  it('adds a query to the front, trimmed, and persists it', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => result.current[1].addRecentSearch('  hello  '));

    expect(result.current[0]).toEqual(['hello']);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual(['hello']);
  });

  it('ignores blank queries', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => result.current[1].addRecentSearch('   '));

    expect(result.current[0]).toEqual([]);
  });

  it('de-duplicates case-insensitively, moving the match to the front', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => result.current[1].addRecentSearch('Coffee'));
    act(() => result.current[1].addRecentSearch('tea'));
    act(() => result.current[1].addRecentSearch('COFFEE'));

    expect(result.current[0]).toEqual(['COFFEE', 'tea']);
  });

  it('caps the list at 8 entries', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => {
      for (let i = 0; i < 10; i++) {
        result.current[1].addRecentSearch(`q${i}`);
      }
    });

    expect(result.current[0]).toHaveLength(8);
    expect(result.current[0][0]).toBe('q9'); // most recent first
    expect(result.current[0]).not.toContain('q0');
  });

  it('removes a specific query', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => result.current[1].addRecentSearch('keep'));
    act(() => result.current[1].addRecentSearch('drop'));
    act(() => result.current[1].removeRecentSearch('drop'));

    expect(result.current[0]).toEqual(['keep']);
  });

  it('clears all queries', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => result.current[1].addRecentSearch('a'));
    act(() => result.current[1].clearRecentSearches());

    expect(result.current[0]).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([]);
  });

  it('syncs across tabs via the storage event', () => {
    const { result } = renderHook(() => useRecentSearches());

    act(() => {
      localStorage.setItem(KEY, JSON.stringify(['from-other-tab']));
      const storageEvent = new Event('storage');
      Object.defineProperty(storageEvent, 'key', { value: KEY });
      window.dispatchEvent(storageEvent);
    });

    expect(result.current[0]).toEqual(['from-other-tab']);
  });
});
