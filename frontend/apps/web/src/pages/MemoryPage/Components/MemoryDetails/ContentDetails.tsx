import { useState, useEffect } from 'react';

import { Label } from '@ci/shadcn';

import { useAuth } from '@/hooks';

import type { MemoryItem, FileMeta } from '../../types';
import { formatBytes } from '../utils.tsx';

interface Props {
  memory: MemoryItem;
}

export function ContentDetails({ memory }: Props) {
  const [{ authToken }] = useAuth();

  const [fileDetails, setFileDetails] = useState<FileMeta | null>(null);

  const hydrateFile = async () => {
    const tempFile = await (
      await fetch(`/api/files/${memory.metadata!.linkedId}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })
    ).json();
    if (tempFile) {
      setFileDetails(tempFile);
    }
  };

  useEffect(() => {
    if (memory.metadata?.linkedId) {
      hydrateFile();
    }
  }, []);

  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4">
      {fileDetails?.size && (
        <div className="grid gap-3">
          <Label>{formatBytes(fileDetails.size, 2)}</Label>
        </div>
      )}
      {fileDetails?.contentType?.startsWith('image/') && (
        <img
          src={`/static/${fileDetails.url}`}
          alt={fileDetails.name}
          className="w-full h-48 object-cover rounded mb-2"
          loading="lazy"
        />
      )}
    </div>
  );
}
