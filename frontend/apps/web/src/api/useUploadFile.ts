import { useState, useCallback } from 'react';

import { useAuth } from '@/hooks';
import { uploadFilesToMemory, type MemoryUploadOptions } from '@/lib/memoryUpload';

import type { File as FileData } from './types';

type ReturnType = [
  {
    files: FileData[];
    loading: boolean;
    error: unknown | null;
  },
  {
    upload: (files: File[], options?: MemoryUploadOptions) => Promise<boolean>;
    reset: () => void;
  },
];

export function useUploadFile(): ReturnType {
  const [{ authToken }] = useAuth();

  const [files, setFiles] = useState<FileData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const upload = useCallback(
    async (files: File[], options: MemoryUploadOptions = {}) => {
      setFiles([]);
      setError(null);
      setLoading(true);

      let success = false;

      try {
        const data = await uploadFilesToMemory(files, {
          ...options,
          authToken: options.authToken ?? authToken,
        });

        setFiles(data);

        success = true;
      } catch (err) {
        setError(err);

        success = false;
      } finally {
        setLoading(false);
      }

      return success;
    },
    [authToken],
  );

  const reset = useCallback(() => {
    setFiles([]);
    setError(null);
    setLoading(false);
  }, []);

  return [
    {
      files,
      loading,
      error,
    },
    {
      upload,
      reset,
    },
  ];
}
