import { useState, useEffect } from 'react';

import { SavedSearchService } from '@/api/savedSearchService';
import type { SavedSearch, CreateSavedSearchRequest, UpdateSavedSearchRequest } from '@/api/savedSearchService';
import { useAuth } from './use-auth';

export function useSavedSearchService() {
  const [{ authToken }] = useAuth();
  const [service, setService] = useState<SavedSearchService | null>(null);

  useEffect(() => {
    if (authToken) {
      setService(new SavedSearchService(authToken));
    } else {
      setService(null);
    }
  }, [authToken]);

  return service;
}

export function useSavedSearches() {
  const service = useSavedSearchService();
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSavedSearches = async () => {
    if (!service) return;

    try {
      setLoading(true);
      setError(null);
      const searches = await service.findAll();
      setSavedSearches(searches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch saved searches');
    } finally {
      setLoading(false);
    }
  };

  const createSavedSearch = async (request: CreateSavedSearchRequest) => {
    if (!service) return;

    try {
      setError(null);
      const newSearch = await service.create(request);
      setSavedSearches(prev => [newSearch, ...prev]);
      return newSearch;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create saved search');
      throw err;
    }
  };

  const updateSavedSearch = async (id: string, request: UpdateSavedSearchRequest) => {
    if (!service) return;

    try {
      setError(null);
      const updatedSearch = await service.update(id, request);
      setSavedSearches(prev => prev.map(search => search.id === id ? updatedSearch : search));
      return updatedSearch;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update saved search');
      throw err;
    }
  };

  const deleteSavedSearch = async (id: string) => {
    if (!service) return;

    try {
      setError(null);
      await service.delete(id);
      setSavedSearches(prev => prev.filter(search => search.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete saved search');
      throw err;
    }
  };

  useEffect(() => {
    fetchSavedSearches();
  }, [service]);

  return {
    savedSearches,
    loading,
    error,
    refetch: fetchSavedSearches,
    createSavedSearch,
    updateSavedSearch,
    deleteSavedSearch,
  };
}

export function useTagSuggestions() {
  const service = useSavedSearchService();
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTags = async () => {
    if (!service) return;

    try {
      setLoading(true);
      const suggestions = await service.getTagSuggestions();
      setTags(suggestions);
    } catch (err) {
      console.error('Failed to fetch tag suggestions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTags();
  }, [service]);

  return { tags, loading, refetch: fetchTags };
}