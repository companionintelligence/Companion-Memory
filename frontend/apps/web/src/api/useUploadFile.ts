import { useState, useCallback } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import type { File as FileData } from './types';

type ReturnType = [
  {
    file: FileData | null;
    loading: boolean;
    error: unknown | null;
  },
  {
    upload: (file: File) => void;
  },
];

export function useUploadFile(): ReturnType {
  const [{ authToken }] = useAuth();

  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setFile(null);
      setError(null);
      setLoading(true);

      const formData = new FormData();

      formData.append('file', file);

      let fileData: FileData;

      try {
        fileData = await fetchJson<FileData>('/api/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        });

        setFile(fileData);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [authToken],
  );

  return [
    {
      file,
      loading,
      error,
    },
    {
      upload,
    },
  ];
}
