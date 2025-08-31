import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import { type Tag, type CreateTagDto, type UpdateTagDto } from './types';

export function useTagService() {
  const [{ authToken }] = useAuth();

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);

  const fetchTags = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchJson<Tag[]>('/api/tags', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      setTags(data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const createTag = useCallback(
    async (tagData: CreateTagDto): Promise<Tag> => {
      const data = await fetchJson<Tag>('/api/tags', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tagData),
      });

      // Refresh the tags list
      await fetchTags();
      return data;
    },
    [authToken, fetchTags]
  );

  const updateTag = useCallback(
    async (id: string, tagData: UpdateTagDto): Promise<Tag> => {
      const data = await fetchJson<Tag>(`/api/tags/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tagData),
      });

      // Refresh the tags list
      await fetchTags();
      return data;
    },
    [authToken, fetchTags]
  );

  const deleteTag = useCallback(
    async (id: string): Promise<void> => {
      await fetchJson(`/api/tags/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      // Refresh the tags list
      await fetchTags();
    },
    [authToken, fetchTags]
  );

  useEffect(() => {
    if (authToken) {
      fetchTags();
    }
  }, [authToken, fetchTags]);

  return {
    data: tags,
    loading,
    error,
    refresh: fetchTags,
    create: createTag,
    update: updateTag,
    delete: deleteTag,
  };
}