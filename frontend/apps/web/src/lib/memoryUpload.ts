import { fetchJson } from '@ci/common';

import type { File as FileData } from '@/api/types';

export interface MemoryUploadOptions {
  authToken?: string | null;
  /** @deprecated Prefer `thingCapture`. Still accepted by the upload API. */
  inventoryCapture?: boolean;
  thingCapture?: boolean;
  model?: string;
}

/**
 * POST files to Memory (`/api/files/upload`). The server stores the object,
 * creates the file row, and fans out `FileUploadedEvent` so the content lands
 * in the user's database — no chat thread required.
 */
export async function uploadFilesToMemory(
  files: File[],
  options: MemoryUploadOptions = {},
): Promise<FileData[]> {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();

  for (const file of files) {
    formData.append('files', file);
  }

  if (options.thingCapture || options.inventoryCapture) {
    formData.append('thingCapture', 'true');
  }

  if (options.model) {
    formData.append('model', options.model);
  }

  const headers: Record<string, string> = {};

  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  const data = await fetchJson<FileData[]>('/api/files/upload', {
    method: 'POST',
    headers,
    body: formData,
  });

  return data ?? [];
}
