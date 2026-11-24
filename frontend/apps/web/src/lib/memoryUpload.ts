import { fetchJson } from '@ci/common';

import type { File as FileData } from '@/api/types';

export interface MemoryUploadOptions {
  authToken?: string | null;
  /** @deprecated Prefer `thingCapture`. Still accepted by the upload API. */
  inventoryCapture?: boolean;
  thingCapture?: boolean;
  model?: string;
  /**
   * A deliberate "save to Memory" (the Capture sheet). The server catalogues
   * the upload as content as well as a file, so it shows up in the Content
   * library and the memory explorer like an imported photo would — a bare
   * upload is only ever a File.
   */
  memoryCapture?: boolean;
  /**
   * When the phone's camera or recorder made this media (ISO 8601). Send it
   * ONLY for media the device just produced — never for a library pick, whose
   * bytes may be years old. With it, the server can put the capture on the
   * timeline even when the bytes carry no date (a recording never does).
   */
  capturedAt?: string;
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

  if (options.memoryCapture) {
    formData.append('memoryCapture', 'true');

    if (options.capturedAt) {
      formData.append('capturedAt', options.capturedAt);
    }
  }

  const headers: Record<string, string> = {};

  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  const data = await fetchJson<FileData[]>('/api/files/upload', {
    method: 'POST',
    // A capture is queued and replayed (`memoryUploadQueue.ts`), not refused: it must not
    // raise the offline-write dialog the way an edit or an import would.
    allowOffline: true,
    headers,
    body: formData,
  });

  return data ?? [];
}
