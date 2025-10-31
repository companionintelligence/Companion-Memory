import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks';
import { ResultCard } from '@/pages/MemoryPage/GalleryView/ResultCard';
import type { MemoryItem, SearchResult } from '@/pages/MemoryPage/types.ts';

import { useMemoryService } from '../useMemoryService';

export function GalleryView() {
  const [{ authToken }] = useAuth();

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<MemoryItem[]>([]);

  const { memories, searchResults } = useMemoryService();

  const hydrateFiles = useCallback(async () => {
    const tempFiles: MemoryItem[] = [];
    const filtered = memories.filter((memory) => memory.metadata?.entityType === 'File');

    for (const memory of filtered) {
      if (memory.metadata) {
        const tempFile = await (
          await fetch(`/api/files/${memory.metadata.linkedId}`, {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          })
        ).json();
        if (tempFile) {
          memory.file = tempFile;
          tempFiles.push(memory);
        }
      }
    }

    setFiles(tempFiles);
  }, [memories]);

  useEffect(() => {
    hydrateFiles();
  }, [memories]);

  let combinedResults: (SearchResult | MemoryItem)[] = [];
  combinedResults = combinedResults.concat(files).concat(searchResults);

  // File upload handler
  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const form = e.currentTarget;
    const input = form.elements.namedItem('file') as HTMLInputElement;

    if (!input.files || input.files.length === 0) {
      return;
    }

    setUploading(true);
    setError(null);

    const formData = new FormData();

    formData.append('file', input.files[0]);

    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });

      if (!res.ok) {
        throw new Error('Upload failed');
      }

      // After upload, refresh file list
      window.location.reload(); // Or call fetchFiles() if you refactor fetchFiles out of useEffect
    } catch (err) {
      setError((err as Error).message || 'Unknown error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <form className="flex items-center gap-4 mb-8" onSubmit={handleUpload} encType="multipart/form-data">
        <input
          type="file"
          name="file"
          className="file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:bg-blue-50 file:text-blue-700"
          required
        />
        <button
          type="submit"
          disabled={uploading}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition"
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </form>

      {error && <div className="mb-4 text-red-500">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        {combinedResults.map((result) => (
          <ResultCard result={result} />
        ))}
      </div>
    </>
  );
}
