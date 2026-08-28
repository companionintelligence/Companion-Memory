import { hasNotificationPermission, scheduleLocalNotification } from '@ci/common';

import type { File as FileData } from '@/api/types';

import { uploadFilesToMemory, type MemoryUploadOptions } from './memoryUpload';

/**
 * Serial Memory ingest that is not tied to a React tree. Closing Capture (or
 * leaving the page) does not abort the POST. True OS-background resumable
 * upload still needs a native URLSession slice; this is the "you can put the
 * phone down / switch screens" cut.
 */
let tail: Promise<unknown> = Promise.resolve();

export function enqueueMemoryUpload(files: File[], options: MemoryUploadOptions = {}): Promise<FileData[]> {
  if (files.length === 0) {
    return Promise.resolve([]);
  }

  const job = tail.then(() => uploadFilesToMemory(files, options));

  tail = job.then(
    () => undefined,
    () => undefined,
  );

  return job.then(async (uploaded) => {
    try {
      await notifyIfBackgrounded(files);
    } catch {
      // Ingest already succeeded; a notification failure must not surface as a failed save.
    }

    return uploaded;
  });
}

async function notifyIfBackgrounded(files: File[]): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return;
  }

  if (!(await hasNotificationPermission())) {
    return;
  }

  const label = files.length === 1 ? files[0].name : `${files.length} files`;

  await scheduleLocalNotification('Saved to Memory', label);
}

/** Test seam: wait for the current chain without exposing `tail`. */
export function flushMemoryUploadQueue(): Promise<void> {
  return tail.then(
    () => undefined,
    () => undefined,
  );
}
