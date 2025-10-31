import { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import { createHookContext } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';

import type { MemoryItem, SearchResult } from './types';

// Constants
const MAX_MEMORIES = 500;
const LOAD_BATCH_SIZE = 200;
const OFFLOAD_THRESHOLD = 1000;
const MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

export interface MemoryQuery {
  search?: string;
  category?: string;
  dateRange?: {
    start?: string;
    end?: string;
  };
  entityTypes?: string[];
  excludedEntityTypes?: string[];
}

interface MemoryContextValue {
  memories: MemoryItem[];
  searchResults: SearchResult[];
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
  searchError: string | null;
  hasMorePast: boolean;
  hasMoreFuture: boolean;
  loadPastEvents: () => Promise<void>;
  loadFutureEvents: () => Promise<void>;
  refreshTimeline: () => Promise<void>;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  loadingPast: boolean;
  loadingFuture: boolean;
  activeMemory: MemoryItem | null;
  setActiveMemory: (memory: MemoryItem | null) => void;
}

function useMemoryService(): MemoryContextValue {
  const [searchParams] = useSearchParams();
  const [activeMemory, setActiveMemory] = useState<MemoryItem | null>(null);

  const query: MemoryQuery = useMemo(() => {
    const search = searchParams.get('search') || undefined;
    const category = searchParams.get('category') || undefined;
    const entityTypes = searchParams.get('entityTypes')?.split(',').filter(Boolean) || undefined;

    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    const dateRange =
      startDate || endDate
        ? {
            start: startDate,
            end: endDate,
          }
        : undefined;

    const excludedEntityTypes =
      searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) || undefined;

    return {
      search,
      category,
      dateRange,
      entityTypes,
      excludedEntityTypes,
    };
  }, [searchParams]);

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasMorePast, setHasMorePast] = useState(true);
  const [hasMoreFuture, setHasMoreFuture] = useState(true);
  const [searchQuery, setSearchQuery] = useState(query.search || '');

  // Track loading states separately for past and future
  const [loadingPast, setLoadingPast] = useState(false);
  const [loadingFuture, setLoadingFuture] = useState(false);

  // Track offsets for past and future loading
  const pastOffsetRef = useRef(0);
  const futureOffsetRef = useRef(0);
  const totalCountRef = useRef(0);

  // Get auth token from useAuth hook
  const [{ authToken }] = useAuth();

  // Fetch memories from API
  const fetchMemories = useCallback(
    async (offset: number = 0, limit: number = 500, direction: 'past' | 'future' | 'initial' = 'initial') => {
      try {
        if (!authToken) {
          throw new Error('No authentication token available');
        }

        const params = new URLSearchParams();

        // Add search query (prioritize the hook query over the function parameter)
        const searchToUse = query.search || searchQuery;
        if (searchToUse) {
          params.append('query', searchToUse);
        }

        // Handle categories - combine single category and entityTypes
        const categories = [];
        if (query.category) {
          categories.push(query.category);
        }

        if (query.entityTypes && query.entityTypes.length > 0) {
          categories.push(...query.entityTypes);
        }

        if (categories.length > 0) {
          params.append('categories', categories.join(','));
        }

        // Handle excluded entity types
        if (query.excludedEntityTypes && query.excludedEntityTypes.length > 0) {
          params.append('excludeCategories', query.excludedEntityTypes.join(','));
        }

        params.append('limit', limit.toString());
        params.append('offset', offset.toString());

        // Add date filters based on direction
        const now = new Date();
        if (direction === 'past') {
          // For past events, get events before the oldest current event
          const oldestMemory = memories.reduce((oldest, memory) => {
            const memoryDate = new Date(memory.timestamp);
            const oldestDate = new Date(oldest.timestamp);

            return memoryDate < oldestDate ? memory : oldest;
          }, memories[0]);

          if (oldestMemory) {
            params.append('endDate', oldestMemory.timestamp);
          }
        } else if (direction === 'future') {
          // For future events, get events after the newest current event
          const newestMemory = memories.reduce((newest, memory) => {
            const memoryDate = new Date(memory.timestamp);
            const newestDate = new Date(newest.timestamp);

            return memoryDate > newestDate ? memory : newest;
          }, memories[0]);

          if (newestMemory) {
            params.append('startDate', newestMemory.timestamp);
          }
        } else {
          // For initial load, use query date range or default to around current time
          if (query.dateRange?.start) {
            params.append('startDate', query.dateRange.start);
          } else {
            const oneMonthAgo = new Date(now.getTime() - MONTH_IN_MS);
            params.append('startDate', oneMonthAgo.toISOString());
          }

          if (query.dateRange?.end) {
            params.append('endDate', query.dateRange.end);
          } else {
            const oneMonthFromNow = new Date(now.getTime() + MONTH_IN_MS);
            params.append('endDate', oneMonthFromNow.toISOString());
          }
        }

        const url = `/api/memory${params.toString() ? `?${params.toString()}` : ''}`;

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch memories: ${response.statusText}`);
        }

        const result = await response.json();
        const data: MemoryItem[] = result.data || result;
        const total = result.total || data.length;

        return { data, total };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
        throw new Error(errorMessage);
      }
    },
    [authToken, query],
  );

  // Load initial memories around current date
  const loadInitialMemories = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Clear existing memories when query changes
    setMemories([]);

    try {
      const { data, total } = await fetchMemories(0, MAX_MEMORIES, 'initial');

      setMemories(data);
      totalCountRef.current = total;

      pastOffsetRef.current = 0;
      futureOffsetRef.current = data.length;

      setHasMorePast(true);
      setHasMoreFuture(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(errorMessage);
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [fetchMemories, query]);

  const loadInitialEmbeddings = useCallback(async () => {
    setSearchResults([]);
    setSearchLoading(true);
    setError(null);

    if (query?.search?.length === 0) {
      return;
    }

    // Clear existing memories when query changes
    setMemories([]);
    try {
      const response = await fetch(`/api/embeddings/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: searchQuery,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch memories: ${response.statusText}`);
      }

      const result = await response.json();

      setSearchResults(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setSearchError(errorMessage);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [query]);

  // Load past events (for scrolling up)
  const loadPastEvents = useCallback(async () => {
    if (loadingPast || !hasMorePast) {
      return;
    }

    setLoadingPast(true);
    try {
      const { data } = await fetchMemories(0, LOAD_BATCH_SIZE, 'past');

      if (data.length > 0) {
        setMemories((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newEvents = data.filter((event) => !existingIds.has(event.id));

          let updatedMemories = [...newEvents, ...prev];

          if (updatedMemories.length > OFFLOAD_THRESHOLD) {
            updatedMemories = updatedMemories.slice(0, MAX_MEMORIES);
            setHasMoreFuture(true);
          }

          return updatedMemories;
        });

        pastOffsetRef.current += data.length;
        setHasMorePast(data.length === LOAD_BATCH_SIZE);
      } else {
        setHasMorePast(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoadingPast(false);
    }
  }, [fetchMemories, loadingPast, hasMorePast]);

  const loadFutureEvents = useCallback(async () => {
    if (loadingFuture || !hasMoreFuture) {
      return;
    }

    setLoadingFuture(true);
    try {
      const { data } = await fetchMemories(0, LOAD_BATCH_SIZE, 'future');

      if (data.length > 0) {
        setMemories((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newEvents = data.filter((event) => !existingIds.has(event.id));

          let updatedMemories = [...prev, ...newEvents];

          if (updatedMemories.length > OFFLOAD_THRESHOLD) {
            updatedMemories = updatedMemories.slice(updatedMemories.length - MAX_MEMORIES);
            setHasMorePast(true);
          }

          return updatedMemories;
        });

        futureOffsetRef.current += data.length;
        setHasMoreFuture(data.length === LOAD_BATCH_SIZE);
      } else {
        setHasMoreFuture(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoadingFuture(false);
    }
  }, [fetchMemories, loadingFuture, hasMoreFuture]);

  // Refresh timeline
  const refreshTimeline = useCallback(async () => {
    setMemories([]);
    pastOffsetRef.current = 0;
    futureOffsetRef.current = 0;
    setHasMorePast(true);
    setHasMoreFuture(true);
    await loadInitialMemories();
  }, [loadInitialMemories]);

  // Load initial memories when component mounts or query changes
  useEffect(() => {
    loadInitialMemories();
    loadInitialEmbeddings();
  }, [query]);

  return {
    memories,
    searchResults,
    loading,
    searchLoading,
    error,
    searchError,
    hasMorePast,
    hasMoreFuture,
    loadPastEvents,
    loadFutureEvents,
    refreshTimeline,
    searchQuery,
    setSearchQuery,
    loadingPast,
    loadingFuture,
    activeMemory,
    setActiveMemory,
  };
}

const { Provider, useHookContext } = createHookContext(useMemoryService);

export { Provider as MemoryProvider, useHookContext as useMemoryService };
