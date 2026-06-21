import { useCallback, useEffect, useState } from 'react';

const RECENT_SEARCHES_KEY = 'memoryRecentSearches';
const MAX_RECENT_SEARCHES = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function write(values: string[]) {
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(values));
  } catch {
    // Ignore quota / private-mode write failures — recents are best-effort.
  }
}

type Value = [
  string[],
  {
    addRecentSearch: (query: string) => void;
    removeRecentSearch: (query: string) => void;
    clearRecentSearches: () => void;
  },
];

/**
 * Locally-persisted list of recent Memory search queries (most-recent first,
 * de-duplicated case-insensitively, capped at {@link MAX_RECENT_SEARCHES}).
 * Backed by localStorage so it survives reloads; kept in sync across tabs.
 */
export function useRecentSearches(): Value {
  const [recentSearches, setRecentSearches] = useState<string[]>(read);

  // Keep multiple tabs/instances consistent.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === RECENT_SEARCHES_KEY) {
        setRecentSearches(read());
      }
    };

    window.addEventListener('storage', handleStorage);

    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const addRecentSearch = useCallback((query: string) => {
    const trimmed = query.trim();

    if (!trimmed) {
      return;
    }

    setRecentSearches((previous) => {
      const next = [
        trimmed,
        ...previous.filter((value) => value.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, MAX_RECENT_SEARCHES);

      write(next);

      return next;
    });
  }, []);

  const removeRecentSearch = useCallback((query: string) => {
    setRecentSearches((previous) => {
      const next = previous.filter((value) => value !== query);

      write(next);

      return next;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    write([]);
    setRecentSearches([]);
  }, []);

  return [recentSearches, { addRecentSearch, removeRecentSearch, clearRecentSearches }];
}
