import { hasNotificationPermission, scheduleLocalNotification } from '@ci/common';

import type { File as FileData } from '@/api/types';

import { uploadFilesToMemory, type MemoryUploadOptions } from './memoryUpload';

const STORAGE_KEY = 'ci.memoryUploadQueue.v1';
const MAX_PERSISTED_BYTES = 2 * 1024 * 1024;

export interface PersistedUploadFile {
  name: string;
  type: string;
  lastModified: number;
  base64: string;
}

export interface PersistedUploadJob {
  id: string;
  createdAt: string;
  options: Omit<MemoryUploadOptions, 'authToken'>;
  files: PersistedUploadFile[];
}

function readPersistedJobs(): PersistedUploadJob[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) ? (parsed as PersistedUploadJob[]) : [];
  } catch {
    return [];
  }
}

function writePersistedJobs(jobs: PersistedUploadJob[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    if (jobs.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    }
  } catch {
    // Storage quota exceeded or private browsing restrictions; in-memory queue continues.
  }
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer();

    return new Uint8Array(buf);
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array((reader.result as ArrayBuffer) ?? new ArrayBuffer(0)));
    };

    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(file);
  });
}

async function serializeFilesForStorage(files: File[]): Promise<PersistedUploadFile[] | null> {
  const totalSize = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (totalSize > MAX_PERSISTED_BYTES) {
    return null;
  }

  const out: PersistedUploadFile[] = [];
  for (const file of files) {
    const bytes = await readFileBytes(file);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }

    out.push({
      name: file.name,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now(),
      base64: btoa(binary),
    });
  }

  return out;
}

function deserializeStoredFile(stored: PersistedUploadFile): File {
  const binary = atob(stored.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new File([bytes], stored.name, {
    type: stored.type,
    lastModified: stored.lastModified,
  });
}

function removePersistedJob(jobId: string): void {
  const jobs = readPersistedJobs();
  const next = jobs.filter((j) => j.id !== jobId);
  if (next.length !== jobs.length) {
    writePersistedJobs(next);
  }
}

export function getPersistedUploadQueueCount(): number {
  return readPersistedJobs().length;
}

/**
 * Serial Memory ingest that is not tied to a React tree. Closing Capture (or
 * leaving the page) does not abort the POST, and small captures (≤ 2 MB) are
 * journaled to `localStorage` (`lm-mini` durable queue pattern) so interrupted
 * or offline sessions can replay via {@link rehydrateMemoryUploadQueue}.
 */
let tail: Promise<unknown> = Promise.resolve();
let jobSequence = 0;

export function enqueueMemoryUpload(files: File[], options: MemoryUploadOptions = {}): Promise<FileData[]> {
  if (files.length === 0) {
    return Promise.resolve([]);
  }

  jobSequence += 1;
  const jobId = `upload-${Date.now()}-${jobSequence}`;
  const { authToken: _omitToken, ...persistedOptions } = options;

  const persistPromise = serializeFilesForStorage(files)
    .then((serialized) => {
      if (!serialized) {
        return;
      }

      const current = readPersistedJobs();
      current.push({
        id: jobId,
        createdAt: new Date().toISOString(),
        options: persistedOptions,
        files: serialized,
      });
      writePersistedJobs(current);
    })
    .catch(() => undefined);

  const job = tail.then(() => uploadFilesToMemory(files, options));

  tail = job.then(
    () => undefined,
    () => undefined,
  );

  return job.then(async (uploaded) => {
    await persistPromise;
    removePersistedJob(jobId);

    try {
      await notifyIfBackgrounded(files);
    } catch {
      // Ingest already succeeded; a notification failure must not surface as a failed save.
    }

    return uploaded;
  });
}

/**
 * Replay any durable upload jobs that survived an app reload, tab close, or
 * offline interruption (`lm-mini` offline capture recovery).
 */
export async function rehydrateMemoryUploadQueue(authToken?: string | null): Promise<FileData[][]> {
  const jobs = readPersistedJobs();
  if (jobs.length === 0) {
    return [];
  }

  const results: FileData[][] = [];
  for (const storedJob of jobs) {
    const files = storedJob.files.map(deserializeStoredFile);
    try {
      const uploaded = await uploadFilesToMemory(files, {
        ...storedJob.options,
        ...(authToken ? { authToken } : {}),
      });
      removePersistedJob(storedJob.id);
      results.push(uploaded);
    } catch {
      // Keep failed jobs in storage for the next retry pass.
    }
  }

  return results;
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
